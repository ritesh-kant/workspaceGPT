import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import {
  NamedRoot,
  WorkspaceRootRequiredError,
  resolveAgainstRoots,
} from '../codebase/codebaseTools';

/**
 * Read-only inspection tools for the agent loop (P1.5/P1.6):
 *
 *  - get_diagnostics — the editor's live problems (compile/type/lint errors)
 *    via vscode.languages.getDiagnostics. The cheapest verification signal
 *    after an edit: no build needed, and it's exactly what the user's IDE sees.
 *  - git_status / git_diff / git_log / git_blame — read-only git against the
 *    user's REAL repository (unlike checkpoints, which use the shadow repo).
 *    Strictly read commands; nothing here stages, commits, or mutates.
 */

// ── Diagnostics ──

export interface GetDiagnosticsArgs {
  /** Restrict to one file; omit for a workspace-wide summary. */
  path?: string;
}

interface DiagnosticEntry {
  file: string;
  line: number;
  severity: string;
  message: string;
  source?: string;
}

const MAX_DIAGNOSTICS = 50;
const SEVERITY_NAMES = ['error', 'warning', 'info', 'hint'] as const;

export async function getDiagnostics(args: GetDiagnosticsArgs, roots: NamedRoot[]): Promise<{
  diagnostics: DiagnosticEntry[];
  totalProblems: number;
  truncated: boolean;
}> {
  if (!roots.length) throw new WorkspaceRootRequiredError();

  let all: [vscode.Uri, readonly vscode.Diagnostic[]][];
  if (args.path) {
    const resolved = resolveAgainstRoots(roots, args.path);
    if (!resolved) throw new Error(`Cannot resolve path "${args.path}".`);
    const uri = vscode.Uri.file(path.resolve(resolved.root.uri.fsPath, resolved.relPath));
    all = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    all = vscode.languages.getDiagnostics() as [vscode.Uri, readonly vscode.Diagnostic[]][];
  }

  const rootPaths = roots.map((r) => r.uri.fsPath);
  const entries: DiagnosticEntry[] = [];
  let total = 0;
  // Errors first, then warnings — the cap should never hide errors behind hints.
  for (const severity of [0, 1, 2, 3]) {
    for (const [uri, diags] of all) {
      const root = rootPaths.find((rp) => uri.fsPath === rp || uri.fsPath.startsWith(rp + path.sep));
      if (!root) continue;
      for (const d of diags) {
        if (d.severity !== severity) continue;
        total++;
        if (entries.length < MAX_DIAGNOSTICS) {
          entries.push({
            file: path.relative(root, uri.fsPath),
            line: d.range.start.line + 1,
            severity: SEVERITY_NAMES[d.severity] ?? 'unknown',
            message: d.message.slice(0, 300),
            source: d.source,
          });
        }
      }
    }
  }
  return { diagnostics: entries, totalProblems: total, truncated: total > entries.length };
}

// ── Git (read-only, user's real repo) ──

const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT_CHARS = 20_000;

function gitRun(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

function capOutput(out: string): { output: string; truncated: boolean } {
  if (out.length <= MAX_GIT_OUTPUT_CHARS) return { output: out, truncated: false };
  return { output: out.slice(0, MAX_GIT_OUTPUT_CHARS) + '\n… (output truncated)', truncated: true };
}

/** Resolve an optional path arg to { cwd, relPath } with the boundary guard. */
function gitTarget(roots: NamedRoot[], relOrPrefixed?: string): { cwd: string; relPath?: string } {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  if (!relOrPrefixed) return { cwd: roots[0].uri.fsPath };
  const resolved = resolveAgainstRoots(roots, relOrPrefixed);
  if (!resolved) throw new Error(`Cannot resolve path "${relOrPrefixed}".`);
  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error('Path resolves outside the workspace root.');
  }
  return { cwd: rootFsPath, relPath: resolved.relPath };
}

export interface GitDiffArgs {
  /** Restrict the diff to one file/directory. */
  path?: string;
  /** Diff the staged (index) changes instead of unstaged ones. */
  staged?: boolean;
}

export interface GitLogArgs {
  path?: string;
  /** Number of commits, max 20. */
  maxCount?: number;
}

export interface GitBlameArgs {
  path: string;
  startLine: number;
  endLine: number;
}

export async function gitStatus(_args: unknown, roots: NamedRoot[]) {
  const { cwd } = gitTarget(roots);
  const branch = (await gitRun(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '(no HEAD)')).trim();
  const status = await gitRun(cwd, ['status', '--porcelain']);
  return { branch, ...capOutput(status.trimEnd() || '(clean — no uncommitted changes)') };
}

export async function gitDiff(args: GitDiffArgs, roots: NamedRoot[]) {
  const { cwd, relPath } = gitTarget(roots, args.path);
  const cmd = ['diff', ...(args.staged ? ['--cached'] : []), ...(relPath ? ['--', relPath] : [])];
  const out = await gitRun(cwd, cmd);
  return capOutput(out.trimEnd() || '(no changes)');
}

export async function gitLog(args: GitLogArgs, roots: NamedRoot[]) {
  const { cwd, relPath } = gitTarget(roots, args.path);
  const n = Math.min(Math.max(args.maxCount ?? 10, 1), 20);
  const out = await gitRun(cwd, [
    'log',
    `--max-count=${n}`,
    '--date=short',
    '--format=%h %ad %an — %s',
    ...(relPath ? ['--', relPath] : []),
  ]);
  return capOutput(out.trimEnd() || '(no commits)');
}

export async function gitBlame(args: GitBlameArgs, roots: NamedRoot[]) {
  const { cwd, relPath } = gitTarget(roots, args.path);
  if (!relPath) throw new Error('git_blame requires a file path.');
  const start = Math.max(1, args.startLine);
  const end = Math.min(args.endLine, start + 100); // cap the range
  const out = await gitRun(cwd, ['blame', '-L', `${start},${end}`, '--date=short', '--', relPath]);
  return capOutput(out.trimEnd());
}
