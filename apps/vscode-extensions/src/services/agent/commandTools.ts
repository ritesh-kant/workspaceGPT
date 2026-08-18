import * as vscode from 'vscode';
import { execFile, ExecFileException } from 'child_process';
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
const MAX_TIMEOUT_SEC = 300;

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

export function resolveCommandCwd(roots: NamedRoot[], cwdArg?: string): { cwd: string; displayCwd: string } {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  const rootFsPath = roots[0].uri.fsPath;
  if (!cwdArg) return { cwd: rootFsPath, displayCwd: '.' };
  const abs = path.resolve(rootFsPath, cwdArg.replace(/^\.?\//, ''));
  if (abs !== rootFsPath && !abs.startsWith(rootFsPath + path.sep)) {
    throw new Error('cwd resolves outside the workspace root.');
  }
  return { cwd: abs, displayCwd: path.relative(rootFsPath, abs) || '.' };
}

export function executeCommand(command: string, cwd: string, timeoutSec?: number): Promise<CommandResult> {
  const timeout = Math.min(Math.max(timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC) * 1000;
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const [file, args] = isWin ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/bash', ['-lc', command]];

  return new Promise((resolve) => {
    execFile(
      file,
      args as string[],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1' } },
      (err: ExecFileException | null, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join(stderr ? '\n--- stderr ---\n' : '');
        const truncated = combined.length > MAX_OUTPUT_CHARS;
        resolve({
          exitCode: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) + '\n… (output truncated)' : combined,
          durationMs: Date.now() - started,
          truncated,
          timedOut: !!err?.killed,
        });
      }
    );
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
