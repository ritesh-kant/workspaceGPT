import { execFile } from 'child_process';
import { NamedRoot } from '../codebase/codebaseTools';

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
}

const EMPTY_STATUS: GitStatusSnapshot = { isRepo: false, added: 0, removed: 0, filesChanged: 0, hasRemote: false };
const GIT_TIMEOUT_MS = 10_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export async function getGitStatus(roots: NamedRoot[]): Promise<GitStatusSnapshot> {
  if (!roots.length) return EMPTY_STATUS;
  const cwd = roots[0].uri.fsPath;

  let gitCwd: string;
  try {
    gitCwd = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return EMPTY_STATUS; // not a git repository
  }

  const [branch, shortstat, porcelain, remote] = await Promise.all([
    git(gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
    git(gitCwd, ['diff', '--shortstat', 'HEAD']).catch(() => ''),
    git(gitCwd, ['status', '--porcelain']).catch(() => ''),
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
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    added: addedMatch ? parseInt(addedMatch[1], 10) : 0,
    removed: removedMatch ? parseInt(removedMatch[1], 10) : 0,
    filesChanged: (trackedMatch ? parseInt(trackedMatch[1], 10) : 0) + untrackedCount,
    hasRemote: !!remote,
  };
}
