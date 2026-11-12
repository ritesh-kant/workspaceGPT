import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { NamedRoot } from '../codebase/codebaseTools';
import { git } from './gitStatusService';

/**
 * Files a turn changed through COMMANDS. Edit-tool writes are recorded as they
 * land (chatService turnFilesChanged), but `git checkout origin/main --
 * pnpm-lock.yaml` or `pnpm install` change files no write tool saw, so the
 * turn's file list — and with it Create PR and the CI fix push — left them
 * out: a fix run that regenerated a lockfile pushed nothing (#1588522).
 *
 * The fact is the working tree itself: each dirty file's content hash at the
 * start of the turn vs at the end. A file whose state moved during the turn
 * was changed during the turn. Taken only when the turn ran a command, so a
 * turn of edits alone keeps exactly its old file list.
 */

/** Per git toplevel: repo-relative path → content hash, or 'deleted'. */
export type TreeSnapshot = Map<string, Map<string, string>>;

export interface CommandChange {
  /** Display path, as the write tools record it. */
  path: string;
  kind: 'edit' | 'create' | 'delete';
  added: number;
  removed: number;
}

async function toplevels(roots: NamedRoot[]): Promise<string[]> {
  const tops = new Set<string>();
  for (const r of roots) {
    const top = await git(r.uri.fsPath, ['rev-parse', '--show-toplevel']).catch(() => '');
    if (top) tops.add(top);
  }
  return [...tops];
}

/** Untrimmed: porcelain's first entry starts with a space that `git()` would strip. */
function gitRaw(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : stdout)
    );
  });
}

/** Dirty paths (porcelain -z, untracked expanded) with their status code. */
async function dirty(top: string): Promise<Map<string, string>> {
  const out = await gitRaw(top, ['status', '--porcelain', '-z', '-uall', '--no-renames']);
  const files = new Map<string, string>();
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    files.set(entry.slice(3), entry.slice(0, 2));
  }
  return files;
}

export async function snapshotTree(roots: NamedRoot[]): Promise<TreeSnapshot> {
  const snap: TreeSnapshot = new Map();
  for (const top of await toplevels(roots)) {
    const files = await dirty(top);
    const hashes = new Map<string, string>();
    const present = [...files.keys()].filter((p) => fs.existsSync(path.join(top, p)));
    for (let i = 0; i < present.length; i += 200) {
      const chunk = present.slice(i, i + 200);
      const out = await git(top, ['hash-object', '--', ...chunk]).catch(() => '');
      out.split('\n').forEach((h, j) => chunk[j] && hashes.set(chunk[j], h));
    }
    snap.set(top, new Map([...files.keys()].map((p) => [p, hashes.get(p) ?? 'deleted'])));
  }
  return snap;
}

/** The display path the write tools would give an absolute file, or null outside every root. */
function displayPath(roots: NamedRoot[], abs: string): string | null {
  for (const r of roots) {
    let root = r.uri.fsPath;
    try {
      root = fs.realpathSync(root);
    } catch {
      /* keep as is */
    }
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const posix = rel.split(path.sep).join('/');
      return roots.length > 1 ? `${r.name}/${posix}` : posix;
    }
  }
  return null;
}

/** Files whose state differs between two snapshots, with line counts against HEAD. */
export async function changedSince(roots: NamedRoot[], start: TreeSnapshot, end: TreeSnapshot): Promise<CommandChange[]> {
  const out: CommandChange[] = [];
  for (const [top, after] of end) {
    const before = start.get(top) ?? new Map<string, string>();
    const moved = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
    if (!moved.length) continue;
    const tracked = new Set((await git(top, ['ls-files', '--', ...moved]).catch(() => '')).split('\n').filter(Boolean));
    const numstat = await git(top, ['diff', '--numstat', '--no-renames', 'HEAD', '--', ...moved]).catch(() => '');
    const counts = new Map<string, [number, number]>();
    for (const line of numstat.split('\n')) {
      const [a, r, file] = line.split('\t');
      if (file) counts.set(file, [parseInt(a, 10) || 0, parseInt(r, 10) || 0]);
    }
    let realTop = top;
    try {
      realTop = fs.realpathSync(top);
    } catch {
      /* keep as is */
    }
    for (const p of moved) {
      const shown = displayPath(roots, path.join(realTop, p));
      if (!shown) continue;
      const state = after.get(p);
      const kind = state === 'deleted' ? 'delete' : !tracked.has(p) ? 'create' : 'edit';
      const [added, removed] = counts.get(p) ?? [0, 0];
      out.push({ path: shown, kind, added, removed });
    }
  }
  return out;
}
