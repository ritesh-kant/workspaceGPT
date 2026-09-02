import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import * as path from 'path';
import { NamedRoot, WorkspaceRootRequiredError } from '../codebase/codebaseTools';

/**
 * Agent command execution (Phase 2): `run_command` lets the agent verify its
 * own work (build/test/lint). Trust model, in order:
 *
 *   1. DENYLIST — destructive/exfil patterns are hard-blocked in prepare;
 *      no approval can override them.
 *   2. Session allowlist — commands the user approved "for this session"
 *      run without another card (exact-string match, deliberately narrow).
 *   3. Everything else — approval card, same gate as file writes.
 *
 * Output is captured via child_process (not a real terminal) and mirrored to
 * the "WorkspaceGPT Agent" output channel so the user can watch what ran.
 * True terminal integration (shellIntegration.executeCommand) is the E3
 * follow-up — capture-from-terminal needs VS Code's shell-integration API and
 * this keeps v0 dependable.
 */

export interface RunCommandArgs {
  command: string;
  /** Workspace-relative working directory; defaults to the workspace root. */
  cwd?: string;
  /** Seconds before the command is killed. Default 60, max 300. */
  timeoutSec?: number;
}

export interface CommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, interleaved per stream flush, capped. */
  output: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_SEC = 60;
/** Tests and builds in a monorepo routinely need more than a minute just to cold-start. */
const VERIFY_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 600;
const VERIFY_COMMAND_RE = /\b(test|tests|jest|vitest|pytest|mocha|build|compile|tsc|typecheck|type-check|lint|eslint|cargo|go)\b/i;

/** Default timeout for a command the model gave no timeout for — verification commands get the long one. */
export function defaultTimeoutSec(command: string): number {
  return VERIFY_COMMAND_RE.test(command) ? VERIFY_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC;
}

/**
 * Hard blocks — no approval path. Deliberately coarse: false positives are an
 * inconvenience (the agent rephrases or the user runs it themselves); false
 * negatives are catastrophe.
 */
const COMMAND_DENYLIST: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME)/i, reason: 'recursive delete of home or filesystem root' },
  { pattern: /\bsudo\b/, reason: 'privilege escalation' },
  { pattern: /\bmkfs\b|\bdiskutil\s+erase/i, reason: 'disk formatting' },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, reason: 'force push' },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, reason: 'destructive git on the user repo — use checkpoints instead' },
  { pattern: /(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh\b/, reason: 'piping a download into a shell' },
  { pattern: /\b(shutdown|reboot|halt)\b/, reason: 'system power control' },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*777\b/i, reason: 'world-writable permissions' },
  { pattern: /\b(launchctl|systemctl|crontab)\b/, reason: 'system service / scheduler modification' },
  { pattern: />\s*\/dev\/(sd|disk|nvme)/i, reason: 'raw device write' },
];

/** Throws when the command is hard-blocked. Returns normally otherwise. */
export function assertCommandAllowed(command: string): void {
  for (const { pattern, reason } of COMMAND_DENYLIST) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked (${reason}). This class of command is never run by the agent — ` +
          'ask the user to run it themselves if it is genuinely needed.'
      );
    }
  }
}

// ── Autonomous-run allowlist ──

/** Binaries an autonomous run may invoke when followed by a verification verb. */
const AUTONOMOUS_BINARIES = new Set(['pnpm', 'npm', 'yarn', 'bun', 'turbo', 'npx', 'go', 'cargo', 'make', 'python', 'python3']);
/** Verification tools safe to run bare — they execute no project-defined code hooks by default. */
const AUTONOMOUS_STANDALONE = new Set(['tsc', 'jest', 'vitest', 'eslint', 'prettier', 'pytest']);
/**
 * Read-only inspection commands. They mutate nothing and expose no more than
 * read_file already does, so making an autonomous run stop for them buys no
 * safety — it just kills the run (observed live: an agent-mode ticket run
 * stalled on `wc -l <file>`). Redirection/chaining is still refused below, so
 * these cannot be turned into writes.
 */
const AUTONOMOUS_READONLY = new Set(['wc', 'ls', 'cat', 'head', 'tail', 'file', 'stat', 'basename', 'dirname']);
const AUTONOMOUS_VERBS = new Set([
  'test', 'tests', 'lint', 'typecheck', 'type-check', 'check', 'vet', 'build', 'compile',
  ...AUTONOMOUS_STANDALONE,
]);

/**
 * Shell decoration models bolt onto a test command to keep its output small —
 * `2>&1`, `| tail -80`, `| head -n 40`. Harmless (stderr is already merged
 * into the captured output and the capture is capped), and refusing it cost a
 * live run two rounds: the model re-issued the same pipe on a different
 * binary. Stripped before the metachar check; anything else stays refused.
 */
const HARMLESS_SUFFIX_RE = /(\s+2>&1)?(\s*\|\s*(tail|head)(\s+-n\s*\d+|\s+-\d+)?)?\s*$/;

/**
 * Verification commands an autonomous run may execute without a human — test,
 * lint, type-check, build. Everything else (installs, publishes, deploys, git
 * mutations, arbitrary scripts) stays human-gated even where
 * assertCommandAllowed's denylist would pass it. Chaining and redirection are
 * refused outright: a composite command can smuggle anything.
 */
export function isAutonomousSafeCommand(command: string): boolean {
  const core = command.trim().replace(HARMLESS_SUFFIX_RE, '');
  if (/[;&|><`$\n\r]/.test(core)) return false;
  const tokens = core.split(/\s+/);
  const binary = tokens[0];
  if (AUTONOMOUS_READONLY.has(binary)) return true;
  if (AUTONOMOUS_STANDALONE.has(binary)) return true;
  if (!AUTONOMOUS_BINARIES.has(binary)) return false;
  return tokens.slice(1).some((t) => AUTONOMOUS_VERBS.has(t));
}

/**
 * The refusal the model reads. Names the actual problem: a command that is
 * only refused for its shell plumbing gets told to drop the plumbing and
 * re-run — the generic "outside the allowlist, do not retry" wording sent a
 * live run off to try `npx jest … | tail -80` after `pnpm … | tail -80`.
 */
export function describeAutonomousRefusal(command: string): string {
  const core = command.trim().replace(HARMLESS_SUFFIX_RE, '');
  if (/[;&|><`$\n\r]/.test(core)) {
    return (
      `Command refused: autonomous runs never execute shell chaining, pipes, redirects or substitutions (found in "${command}"). ` +
      'You do not need them — stdout and stderr are captured together and truncated for you. Re-run the SAME command as a single plain invocation (e.g. "npx jest --no-coverage path/to/test.ts").'
    );
  }
  return (
    `Command refused: autonomous runs may only execute verification commands (test / lint / type-check / build via pnpm, npm, yarn, npx, tsc, jest, vitest, pytest, go, cargo, make) — "${command}" is outside that allowlist. ` +
    'Do not retry it. Use run_checks with the file path instead — it derives an allowed command in the right directory — or note the command in your final report for the user to run.'
  );
}

export function resolveCommandCwd(roots: NamedRoot[], cwdArg?: string): { cwd: string; displayCwd: string } {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  // Multi-root workspaces: a cwd of "<rootName>" or "<rootName>/sub/dir" picks
  // that root, the same disambiguation the file tools accept — otherwise
  // every command ran in roots[0], and a package script in the second repo
  // failed with pnpm's "node_modules missing" from the wrong directory.
  let root = roots[0];
  let rel = (cwdArg ?? '').replace(/^\.?\//, '');
  if (rel && roots.length > 1) {
    for (const r of roots) {
      if (rel === r.name || rel.startsWith(`${r.name}/`)) {
        root = r;
        rel = rel.slice(r.name.length).replace(/^\//, '');
        break;
      }
    }
  }
  const rootFsPath = root.uri.fsPath;
  if (!rel) return { cwd: rootFsPath, displayCwd: roots.length > 1 ? root.name : '.' };
  const abs = path.resolve(rootFsPath, rel);
  if (abs !== rootFsPath && !abs.startsWith(rootFsPath + path.sep)) {
    throw new Error('cwd resolves outside the workspace root.');
  }
  const display = path.relative(rootFsPath, abs) || '.';
  return { cwd: abs, displayCwd: roots.length > 1 ? `${root.name}/${display}` : display };
}

/**
 * Run a shell command, streaming combined stdout+stderr to `onOutput` as it
 * arrives (the timeline shows a live tail, so a 90-second test run reads as
 * progress rather than a hang). Never rejects — a failed spawn is an exit
 * with null code and the error text as output.
 */
export function executeCommand(
  command: string,
  cwd: string,
  timeoutSec?: number,
  onOutput?: (combinedSoFar: string) => void
): Promise<CommandResult> {
  const timeout = Math.min(Math.max(timeoutSec ?? defaultTimeoutSec(command), 1), MAX_TIMEOUT_SEC) * 1000;
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const [file, args] = isWin ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/bash', ['-lc', command]];

  return new Promise((resolve) => {
    let combined = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const truncated = combined.length > MAX_OUTPUT_CHARS;
      resolve({
        exitCode,
        output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) + '\n… (output truncated)' : combined,
        durationMs: Date.now() - started,
        truncated,
        timedOut,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args as string[], { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      combined = e instanceof Error ? e.message : String(e);
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      combined += `\n… killed after ${Math.round(timeout / 1000)}s timeout`;
      child.kill('SIGKILL');
    }, timeout);
    // Streams are interleaved in arrival order; the first stderr chunk after
    // stdout gets a label so the model can tell warnings from results.
    let lastStream: 'stdout' | 'stderr' | null = null;
    const append = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      if (combined.length >= MAX_OUTPUT_CHARS + 2_000) return; // stop buffering runaway output
      if (stream === 'stderr' && lastStream === 'stdout') combined += '\n--- stderr ---\n';
      lastStream = stream;
      combined += chunk.toString();
      onOutput?.(combined);
    };
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    child.on('error', (err) => {
      combined += (combined ? '\n' : '') + err.message;
      finish(null);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
  });
}

// ── Output channel mirror ──

let channel: vscode.OutputChannel | null = null;

export function agentOutputChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('WorkspaceGPT Agent');
  return channel;
}

// ── Audit log (JSONL, append-only) ──

export interface AgentAuditEntry {
  ts: string;
  action: 'edit' | 'create' | 'delete' | 'command';
  detail: string;
  decision: 'approved' | 'approved-session' | 'rejected' | 'auto';
  outcome: 'applied' | 'failed' | 'skipped';
  error?: string;
}

export async function recordAgentAudit(globalStorageFsPath: string, entry: AgentAuditEntry): Promise<void> {
  const file = path.join(globalStorageFsPath, 'agent-actions.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
}
