import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
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
export const MAX_TIMEOUT_SEC = 600;
/**
 * Ceiling for a command that runs with NOBODY approving it — every `run_checks`
 * and every autonomous `run_command`. The 600s ceiling exists for a command a
 * human deliberately asked for and is watching; applied to an unattended one it
 * means a single bad derivation can silently eat ten minutes of the run, which
 * is exactly what a `pnpm exec jest` over a 500-file suite did (636.8s, killed
 * at the ceiling, ticket #1534774). A check that cannot finish in three minutes
 * is reported as not-run, which costs a line in the report instead of a third
 * of the run's wall clock.
 */
export const UNATTENDED_MAX_TIMEOUT_SEC = 180;

// ── The PATH a command actually needs ──
//
// Commands run through `/bin/bash -lc`, which sources bash's login files —
// but this user's toolchain is on the PATH that `~/.zshrc` builds (nvm puts
// node and pnpm under ~/.nvm/versions/node/<v>/bin and writes its setup to
// the rc file of the shell it was installed from). A VS Code launched from
// the Dock never sources that file either, so the extension host's own PATH
// has no nvm directory to inherit. The result, measured on ticket #1534774:
//
//   env -i PATH=/usr/bin:/bin bash -lc 'command -v pnpm' → not found
//   env -i PATH=/usr/bin:/bin zsh  -lic 'command -v pnpm' → ~/.nvm/…/bin/pnpm
//
// Nine consecutive `run_checks` calls exited 127 and the run reported "could
// not verify" against the ticket's own acceptance criterion, blaming the
// workspace for what was really our environment.
//
// So ask the user's LOGIN SHELL what the PATH is, once per session, and hand
// that to every spawn. Deliberately only the PATH is taken, and the command
// interpreter stays `/bin/bash` — quoting and word-splitting differ between
// shells, and the denylist in `prepare` was written against bash's grammar.
//
// `-i` is required, not decoration: nvm's block lives in `~/.zshrc`, which a
// non-interactive shell does not read (`zsh -lc` fails the probe above,
// `zsh -lic` passes).
const PATH_PROBE_TIMEOUT_MS = 5_000;
/** Markers, so rc-file chatter printed on startup can't be mistaken for the PATH. */
const PATH_PROBE_START = '__WGPT_PATH_START__';
const PATH_PROBE_END = '__WGPT_PATH_END__';

/** Resolved once per extension host — a login shell costs ~100ms to start and the answer cannot change under us. */
let userPathProbe: Promise<string | undefined> | undefined;

function probeLoginShellPath(): Promise<string | undefined> {
  // Windows has no login-shell rc convention to consult; cmd.exe inherits the
  // PATH the host was started with, which is the best available answer there.
  if (process.platform === 'win32') return Promise.resolve(undefined);
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-lic', `printf '${PATH_PROBE_START}%s${PATH_PROBE_END}' "$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      done(undefined);
      return;
    }
    // An rc file that waits for input (a prompt, a version-manager banner
    // paging) would otherwise hang every command in the session behind it.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(undefined);
    }, PATH_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const start = out.indexOf(PATH_PROBE_START);
      const end = out.indexOf(PATH_PROBE_END);
      if (start < 0 || end <= start) return done(undefined);
      const probed = out.slice(start + PATH_PROBE_START.length, end).trim();
      done(probed.includes(path.sep) ? probed : undefined);
    });
  });
}

/**
 * The PATH to run commands with: the login shell's, plus anything the
 * extension host had that the shell did not mention.
 *
 * Union rather than replacement — VS Code injects directories of its own
 * (its bundled `code` CLI, a remote server's helpers) and dropping them would
 * trade one class of "command not found" for another.
 */
async function resolveCommandPath(): Promise<string | undefined> {
  if (!userPathProbe) userPathProbe = probeLoginShellPath();
  const probed = await userPathProbe;
  if (!probed) return undefined;
  const seen = new Set(probed.split(path.delimiter));
  const extras = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !seen.has(dir));
  return extras.length ? `${probed}${path.delimiter}${extras.join(path.delimiter)}` : probed;
}
const VERIFY_COMMAND_RE = /\b(test|tests|jest|vitest|pytest|mocha|build|compile|tsc|typecheck|type-check|lint|eslint|cargo|go)\b/i;

/**
 * A repo-wide verification command in a monorepo, refused so the run uses a
 * scoped one instead.
 *
 * `run_checks` already derives the narrow command — nearest package.json,
 * eslint on the single changed file, the sibling test file rather than the
 * suite — but nothing stopped a run from bypassing it with `pnpm lint` at the
 * workspace root. In an autonomous run that is auto-approved and invisible:
 * `lint`/`test`/`build` get a 180s default and a 600s ceiling, so one such
 * call can eat minutes of wall clock, and on a large monorepo it will do that
 * repeatedly for a change that touched three files.
 *
 * Deliberately narrow — it fires only when ALL of these hold:
 *   - the command is a verification verb (lint / test / build / typecheck),
 *   - it runs at a workspace ROOT rather than inside a package,
 *   - it names no path target and no workspace selector (`--filter`, `-F`,
 *     `--workspace`, `--scope`, a `./path` argument),
 *   - and the user did not ask for a repo-wide run.
 *
 * Everything else is untouched: `npx eslint src/foo.ts` at the root has a
 * target, `pnpm --filter @app/web test` has a selector, and a command with an
 * explicit package `cwd` is not at a root.
 */
const VERIFY_VERB_RE = /\b(lint|test|tests|typecheck|type-check|build|compile)\b/i;
/**
 * Only whole-project RUNNERS are candidates. Without this the guard fires on
 * anything whose text happens to contain a verify verb — `node test.js` runs
 * exactly one file and was refused by the first version of this check.
 */
const PROJECT_RUNNER_RE =
  /^\s*(pnpm|npm|yarn|bun|turbo|nx|lerna|make|eslint|jest|vitest|tsc|prettier|pytest|cargo|go)\b/i;
/**
 * A verification tool invoked directly. Needed because VERIFY_VERB_RE cannot
 * see the verb inside the tool's own name — "lint" in `eslint` has no word
 * boundary, so `eslint .` at a monorepo root (which lints everything) read as
 * a non-verification command.
 */
const STANDALONE_VERIFY_RE =
  /^\s*(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|bunx\s+)?(eslint|jest|vitest|tsc|prettier|pytest)\b/i;
/** A path-ish argument, a file argument, or a workspace selector — all of which scope the run. */
const SCOPED_ARG_RE =
  /(--filter\b|(?:^|\s)-F(?:\s|=)|--workspace\b|--scope\b|--project\b|(?:^|\s)-p\s|(?:^|\s)\.?\/[\w.@-]|(?:^|\s)[\w.@-]+\/[\w./@*-]+|(?:^|\s)[\w.@-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|json)\b)/i;

/** Did the USER ask for a whole-repo run? Then it is not the harness's call to refuse. */
export const REPO_WIDE_REQUEST_RE =
  /\b(all|whole|entire|full|every|each)\s+(the\s+)?(tests?|test suite|suites?|packages?|apps?|repo|monorepo|workspace|codebase|projects?)\b|\bfull (test )?(suite|run|build)\b|\brepo[- ]wide\b|\bacross (the )?(whole|entire) (repo|monorepo|workspace)\b/i;

/**
 * Is this root a monorepo — i.e. does a narrower, per-package command even
 * exist?
 *
 * Without this the guard is wrong for the common case: in a single-package
 * repo `pnpm test` at the root IS the correct scoped command, and refusing it
 * would break every non-monorepo workspace to save time in monorepos.
 */
export function isMonorepoRoot(rootPath: string): boolean {
  try {
    if (
      fs.existsSync(path.join(rootPath, 'pnpm-workspace.yaml')) ||
      fs.existsSync(path.join(rootPath, 'lerna.json')) ||
      fs.existsSync(path.join(rootPath, 'nx.json'))
    ) {
      return true;
    }
    const pkgPath = path.join(rootPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
    const w = pkg.workspaces;
    return Array.isArray(w) ? w.length > 0 : !!w && typeof w === 'object';
  } catch {
    // Unreadable or malformed manifest — assume single-package and let the
    // command through. The guard must never be the reason a run cannot verify.
    return false;
  }
}

export interface UnscopedCheck {
  /** Human-readable reason, handed back to the model as a tool error. */
  reason: string;
}

/**
 * Returns a refusal when `command` is an unscoped repo-wide verification run.
 * Pure so the decision is testable on its own — the timeouts it protects are
 * measured in minutes, and a wrong answer here is either a wasted run or a
 * blocked legitimate one.
 */
export function checkUnscopedVerification(opts: {
  command: string;
  /** Absolute cwd the command resolved to (from resolveCommandCwd). */
  cwd: string;
  /** Absolute paths of the workspace roots. */
  rootPaths: string[];
  /** True when the user's own message asked for a repo-wide run. */
  userAskedRepoWide?: boolean;
}): UnscopedCheck | null {
  const command = String(opts.command ?? '').trim();
  if (!command) return null;
  if (opts.userAskedRepoWide) return null;
  if (!PROJECT_RUNNER_RE.test(command) && !STANDALONE_VERIFY_RE.test(command)) return null;
  if (!VERIFY_VERB_RE.test(command) && !STANDALONE_VERIFY_RE.test(command)) return null;
  if (SCOPED_ARG_RE.test(command)) return null;
  const atRoot = opts.rootPaths.some((r) => r === opts.cwd);
  if (atRoot) {
    // Only meaningful where a narrower command exists at all.
    if (!isMonorepoRoot(opts.cwd)) return null;
    return {
      reason:
        `Refused: "${command}" is a repo-wide ${VERIFY_VERB_RE.exec(command)?.[0] ?? STANDALONE_VERIFY_RE.exec(command)?.[1] ?? 'verification'} run at the workspace root, ` +
        'which in a monorepo checks every package to verify a change that touched a few files. ' +
        'Use `run_checks` with the path of a file you changed instead — it derives the package, the runner and the single ' +
        'test/lint target itself, and runs from that package\'s directory. ' +
        'If you genuinely need a wider run, scope it: pass a package `cwd`, add a path argument, or use the workspace ' +
        'selector (e.g. `--filter <package>`).',
    };
  }
  // Inside a package of a monorepo an unscoped TEST run is still the whole
  // package's suite. Observed live as `pnpm exec jest` in a 500-test-file
  // Next.js app: jest forked a jsdom worker per core, the machine hit 20GB
  // and swapped, and the run died on the stall timer. Lint and typecheck stay
  // allowed at package level — they are package-scoped by nature and do not
  // fork a worker per core.
  const insideMonorepo = opts.rootPaths.some((r) => opts.cwd.startsWith(r + path.sep) && isMonorepoRoot(r));
  if (!insideMonorepo || !TEST_RUN_RE.test(command)) return null;
  return {
    reason:
      `Refused: "${command}" runs every test in this package to verify a change that touched a few files. ` +
      'Use `run_checks` with the path of a file you changed — it runs that file\'s own test file, nothing else. ' +
      `To run one test file directly, name it: e.g. \`${command} <path/to/file.test.ts>\`.`,
  };
}

/** A test run specifically — the check kind that forks a worker per core. */
const TEST_RUN_RE = /\b(test|tests|jest|vitest|pytest|mocha)\b/i;

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
export async function executeCommand(
  command: string,
  cwd: string,
  timeoutSec?: number,
  onOutput?: (combinedSoFar: string) => void,
  /** No human approved this one — hold it to UNATTENDED_MAX_TIMEOUT_SEC. */
  unattended = false
): Promise<CommandResult> {
  const ceiling = unattended ? UNATTENDED_MAX_TIMEOUT_SEC : MAX_TIMEOUT_SEC;
  const timeout = Math.min(Math.max(timeoutSec ?? defaultTimeoutSec(command), 1), ceiling) * 1000;
  const started = Date.now();
  const isWin = process.platform === 'win32';
  const [file, args] = isWin ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/bash', ['-lc', command]];
  // Awaited before the timer starts so a slow first probe is not billed to
  // this command's timeout.
  const commandPath = await resolveCommandPath();

  return new Promise((resolve) => {
    let combined = '';
    let timedOut = false;
    let settled = false;
    // Declared before finish() so the spawn-failure path below can call it
    // (a `const` here would be in its temporal dead zone at that point).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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
      // `detached` gives the shell its OWN process group so the timeout can
      // kill the whole tree, not just bash. Observed live without it: a
      // `pnpm exec jest` suite was "killed after 180s" — bash died, pnpm →
      // node → eleven jest workers did not, the machine sat at 20GB for
      // another seven minutes, and because those orphans still held our
      // stdout pipe, 'close' (and so this promise) waited for them too.
      child = spawn(file, args as string[], {
        cwd,
        env: { ...process.env, ...(commandPath ? { PATH: commandPath } : {}), CI: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWin,
      });
    } catch (e) {
      combined = e instanceof Error ? e.message : String(e);
      finish(null);
      return;
    }
    const killTree = () => {
      if (isWin) {
        // /T walks the child tree; /F because test workers ignore a polite close.
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          /* fall through to the direct kill */
        }
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole group
        } catch {
          /* group already gone */
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      combined += `\n… killed after ${Math.round(timeout / 1000)}s timeout`;
      killTree();
      // A survivor that left the group (its own setsid) can still hold the
      // pipes open. The verdict is "timed out" either way — hand it back now
      // instead of waiting on a process we no longer control.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 2_000);
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
  action: 'edit' | 'create' | 'delete' | 'command' | 'confluence-edit' | 'confluence-create';
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
