import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { NamedRoot, resolveAgainstRoots } from '../codebase/codebaseTools';
import { pullRequestUrlTemplate } from './shipHelpers';

/**
 * Always-on snapshot for the composer's git status bar: current branch and
 * the working tree's uncommitted diff. Deliberately separate from
 * shipService.ts's per-turn `ShipResult` — this runs on a timer regardless of
 * agent activity, so it stays a cheap, read-only `git` shell-out.
 */
export interface GitStatusSnapshot {
  isRepo: boolean;
  branch?: string;
  /** Insertions in tracked files, vs. HEAD (git has no line count for untracked files). */
  added: number;
  /** Deletions in tracked files, vs. HEAD. */
  removed: number;
  /** Tracked files with changes, plus untracked files. */
  filesChanged: number;
  hasRemote: boolean;
  /** `origin`'s PR-by-number URL with `{id}` to substitute — lets the chat renderer link `PR #123`. */
  prUrlTemplate?: string;
  /**
   * The requested paths (as sent) that are still uncommitted, each with its
   * own diff vs. HEAD — lets the webview scope the bar to the files one chat
   * recorded. Paths since committed or restored are absent.
   */
  pathStats?: GitPathStat[];
}

export interface GitPathStat {
  path: string;
  added: number;
  removed: number;
}

const EMPTY_STATUS: GitStatusSnapshot = { isRepo: false, added: 0, removed: 0, filesChanged: 0, hasRemote: false };
const GIT_TIMEOUT_MS = 10_000;

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // GIT_OPTIONAL_LOCKS=0: these reads run on every file change and focus,
    // and a `git status` that takes index.lock to refresh the index can fail
    // the user's own `git commit` in a terminal with "index.lock exists".
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
    execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

/**
 * `origin`'s PR-by-number url template for the workspace, or undefined when
 * there is no remote / no known host. Resolved per agent turn so a recorded
 * pull-request reference can carry an absolute url — a message re-read from
 * history must not resolve its PRs against whatever repo is open later.
 */
export async function getPrUrlTemplate(roots: NamedRoot[]): Promise<string | undefined> {
  if (!roots.length) return undefined;
  try {
    const gitCwd = await git(roots[0].uri.fsPath, ['rev-parse', '--show-toplevel']);
    const remote = await git(gitCwd, ['remote', 'get-url', 'origin']);
    return remote ? pullRequestUrlTemplate(remote) : undefined;
  } catch {
    return undefined; // not a repo, or no origin
  }
}

/** Diff stats for those of `paths` (workspace display paths) that are still dirty. */
async function statsForPaths(roots: NamedRoot[], gitCwd: string, paths: string[], porcelain: string): Promise<GitPathStat[]> {
  // Untracked files only: `git()` trims its output, so the first porcelain
  // line can lose its leading status column and only "??" survives intact.
  // Tracked changes come from the numstat below instead.
  const untracked = new Set(
    porcelain
      .split('\n')
      .filter((line) => line.startsWith('?? '))
      .map((line) => line.slice(3).replace(/^"|"$/g, ''))
  );
  const realTop = fs.realpathSync(gitCwd);
  const fromTop = new Map<string, string>(); // repo-relative → display path as sent
  for (const display of paths) {
    const r = resolveAgainstRoots(roots, display);
    if (!r) continue;
    // realpath: `--show-toplevel` resolves symlinks (/tmp → /private/tmp),
    // so the root must be compared in the same form.
    let rootPath = r.root.uri.fsPath;
    try {
      rootPath = fs.realpathSync(rootPath);
    } catch {
      /* keep as is */
    }
    const rel = path.relative(realTop, path.join(rootPath, r.relPath)).split(path.sep).join('/');
    if (!rel.startsWith('..')) fromTop.set(rel, display);
  }
  if (!fromTop.size) return [];
  const numstat = await git(gitCwd, ['diff', '--numstat', '--no-renames', 'HEAD', '--', ...fromTop.keys()]).catch(() => '');
  const lines = new Map<string, [number, number]>();
  for (const line of numstat.split('\n')) {
    const [added, removed, file] = line.split('\t');
    // Binary files report "-\t-": changed, but no line counts.
    if (file) lines.set(file, [parseInt(added, 10) || 0, parseInt(removed, 10) || 0]);
  }
  // Untracked files have no diff vs. HEAD — they count as files, like the tree totals.
  return [...fromTop]
    .filter(([rel]) => lines.has(rel) || untracked.has(rel))
    .map(([rel, display]) => {
      const [added, removed] = lines.get(rel) ?? [0, 0];
      return { path: display, added, removed };
    });
}

export async function getGitStatus(roots: NamedRoot[], paths: string[] = []): Promise<GitStatusSnapshot> {
  if (!roots.length) return EMPTY_STATUS;
  const cwd = roots[0].uri.fsPath;

  let gitCwd: string;
  try {
    gitCwd = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return EMPTY_STATUS; // not a git repository
  }

  const [branch, shortstat, porcelain, remote] = await Promise.all([
    // NOT `rev-parse --abbrev-ref HEAD`: that reports the disambiguated form
    // ("heads/main") when the short name could match more than one ref.
    // `--show-current` gives the plain name, and '' on a detached HEAD.
    git(gitCwd, ['branch', '--show-current']).catch(() => ''),
    git(gitCwd, ['diff', '--shortstat', 'HEAD']).catch(() => ''),
    // -uall expands untracked directories into their files; the default
    // collapses them to one "dir/" entry and undercounts what would be shipped.
    git(gitCwd, ['status', '--porcelain', '-uall']).catch(() => ''),
    git(gitCwd, ['remote', 'get-url', 'origin']).catch(() => ''),
  ]);

  const trackedMatch = shortstat.match(/^(\d+) file/);
  const addedMatch = shortstat.match(/(\d+) insertion/);
  const removedMatch = shortstat.match(/(\d+) deletion/);
  const untrackedCount = porcelain
    .split('\n')
    .filter((line) => line.startsWith('??')).length;

  return {
    isRepo: true,
    branch: branch || undefined,
    added: addedMatch ? parseInt(addedMatch[1], 10) : 0,
    removed: removedMatch ? parseInt(removedMatch[1], 10) : 0,
    filesChanged: (trackedMatch ? parseInt(trackedMatch[1], 10) : 0) + untrackedCount,
    hasRemote: !!remote,
    prUrlTemplate: remote ? pullRequestUrlTemplate(remote) : undefined,
    pathStats: paths.length ? await statsForPaths(roots, gitCwd, paths, porcelain).catch(() => []) : undefined,
  };
}
