import { execFile } from 'child_process';
import * as path from 'path';
import type { NamedRoot } from '../codebase/codebaseTools';
import { resolveAgainstRoots } from '../codebase/codebaseTools';

/**
 * CI monitoring for the pull request on the chat's current branch. GitHub
 * only, through the user's own `gh` login — no token is read, stored or sent
 * anywhere by us. Everything here is a read except `pushCiFix`, which only
 * ever commits to the PR's own branch.
 */

export type CiState = 'none' | 'pending' | 'passed' | 'failed' | 'merged' | 'closed' | 'unavailable';

export interface CiCheck {
  name: string;
  state: 'pass' | 'fail' | 'pending';
  url?: string;
}

export interface CiSnapshot {
  state: CiState;
  /** Why the state is 'unavailable' (gh missing / not signed in / not a GitHub repo). */
  reason?: string;
  pr?: { number: number; url: string; branch: string; sha: string };
  checks: CiCheck[];
  /** Tail of the failing jobs' logs — only on `failed`, never persisted. */
  failureLog?: string;
}

const GH_TIMEOUT_MS = 25_000;
const LOG_TAIL_LINES = 150;
const LOG_MAX_CHARS = 9_000;
const MAX_LOG_RUNS = 2;

function run(file: string, args: string[], cwd: string, timeout = GH_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
    execFile(file, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message).trim()) as Error & { code?: string };
        e.code = (err as NodeJS.ErrnoException).code;
        reject(e);
      } else resolve(stdout);
    });
  });
}

const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR', 'ACTION_REQUIRED']);
// CANCELLED is left out on purpose: a superseded run (concurrency group, a
// newer push) is cancelled by CI itself and is not something to fix.
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED', 'STALE']);

interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

function toCheck(i: RollupItem): CiCheck {
  const name = i.name || i.context || 'check';
  const url = i.detailsUrl || i.targetUrl || undefined;
  // CheckRun carries status+conclusion; a commit status carries only state.
  const verdict = (i.conclusion || i.state || '').toUpperCase();
  const finished = i.__typename === 'StatusContext' ? !!verdict && verdict !== 'PENDING' && verdict !== 'EXPECTED' : (i.status || '').toUpperCase() === 'COMPLETED';
  if (!finished) return { name, state: 'pending', url };
  if (FAIL.has(verdict)) return { name, state: 'fail', url };
  return { name, state: PASS.has(verdict) ? 'pass' : 'pending', url };
}

/** Status of the PR for the branch checked out in `cwd`. Never throws. */
export async function getCiSnapshot(cwd: string): Promise<CiSnapshot> {
  let raw: string;
  try {
    raw = await run('gh', ['pr', 'view', '--json', 'number,url,state,headRefName,headRefOid,statusCheckRollup'], cwd);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === 'ENOENT') return { state: 'unavailable', reason: 'Install the GitHub CLI (gh) to monitor CI.', checks: [] };
    if (/no pull requests? found/i.test(err.message)) return { state: 'none', checks: [] };
    if (/auth login|not logged in|GH_TOKEN/i.test(err.message)) return { state: 'unavailable', reason: 'Run `gh auth login` to monitor CI.', checks: [] };
    if (/none of the git remotes|not a git repository|could not resolve to a Repository/i.test(err.message)) return { state: 'none', checks: [] };
    return { state: 'unavailable', reason: err.message.split('\n')[0].slice(0, 160), checks: [] };
  }
  let data: { number: number; url: string; state: string; headRefName: string; headRefOid: string; statusCheckRollup?: RollupItem[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: 'unavailable', reason: 'Unreadable response from gh.', checks: [] };
  }
  const pr = { number: data.number, url: data.url, branch: data.headRefName, sha: data.headRefOid };
  const checks = (data.statusCheckRollup ?? []).map(toCheck);
  if (data.state === 'MERGED') return { state: 'merged', pr, checks };
  if (data.state === 'CLOSED') return { state: 'closed', pr, checks };
  if (!checks.length) return { state: 'none', pr, checks };
  // Failed only once everything has finished: a log from a run that is still
  // going is incomplete, and a second failure may be on its way.
  if (checks.some((c) => c.state === 'pending')) return { state: 'pending', pr, checks };
  return { state: checks.some((c) => c.state === 'fail') ? 'failed' : 'passed', pr, checks };
}

/** Last lines of the failing GitHub Actions jobs' logs, capped — enough to see the error, not the whole run. */
export async function getFailureLog(cwd: string, checks: CiCheck[]): Promise<string> {
  const runIds = [...new Set(checks.filter((c) => c.state === 'fail').map((c) => /\/actions\/runs\/(\d+)/.exec(c.url ?? '')?.[1]).filter((x): x is string => !!x))].slice(0, MAX_LOG_RUNS);
  const parts: string[] = [];
  for (const id of runIds) {
    try {
      const out = await run('gh', ['run', 'view', id, '--log-failed'], cwd, 60_000);
      // Drop the "job\tstep\t" prefix and the ANSI/timestamp noise on each line.
      const lines = out
        .split('\n')
        .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ''))
        .filter((l) => l.trim());
      parts.push(lines.slice(-LOG_TAIL_LINES).join('\n'));
    } catch (e) {
      parts.push(`(could not read the log of run ${id}: ${(e as Error).message.split('\n')[0]})`);
    }
  }
  const names = checks.filter((c) => c.state === 'fail').map((c) => c.name);
  const head = `Failing checks: ${names.join(', ')}`;
  const log = parts.join('\n\n---\n\n');
  return log ? `${head}\n\n${log.length > LOG_MAX_CHARS ? log.slice(-LOG_MAX_CHARS) : log}` : `${head}\n\n(no log available — these checks are not GitHub Actions jobs; open their details link)`;
}

export interface CiPushResult {
  pushed: boolean;
  commitSha?: string;
  error?: string;
}

/**
 * Commit `files` and push them to the PR's own branch. Refuses unless the
 * checked-out branch IS the PR's head branch: the CI fix never lands on the
 * default branch or any other, whatever the caller asked.
 */
export async function pushCiFix(roots: NamedRoot[], files: string[], prBranch: string, subject: string): Promise<CiPushResult> {
  if (!files.length) return { pushed: false, error: 'No changed files to commit.' };
  const first = resolveAgainstRoots(roots, files[0]);
  if (!first) return { pushed: false, error: `Could not resolve ${files[0]} in the workspace.` };
  const cwd = first.root.uri.fsPath;
  const rel: string[] = [];
  for (const f of files) {
    const r = resolveAgainstRoots(roots, f);
    if (!r || r.root.uri.fsPath !== cwd) return { pushed: false, error: `Changed files span more than one repository (${f}).` };
    rel.push(r.relPath);
  }
  try {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], cwd, 15_000)).trim();
    const branch = (await run('git', ['branch', '--show-current'], top, 15_000)).trim();
    if (!branch || branch !== prBranch) return { pushed: false, error: `Checked-out branch (${branch || 'detached'}) is not the PR's branch (${prBranch}); not pushing.` };
    const fromTop = rel.map((f) => path.relative(top, path.join(cwd, f)));
    await run('git', ['add', '--', ...fromTop], top, 30_000);
    const message = `${subject}\n\nCo-authored-by: WorkspaceGPT Agent <agent@workspacegpt.dev>`;
    // Pathspec'd: only these files, never whatever else sits staged.
    await run('git', ['commit', '--quiet', '-m', message, '--', ...fromTop], top, 60_000);
    const commitSha = (await run('git', ['rev-parse', 'HEAD'], top, 15_000)).trim();
    await run('git', ['push', '--quiet', 'origin', branch], top, 90_000);
    return { pushed: true, commitSha };
  } catch (e) {
    return { pushed: false, error: (e as Error).message.split('\n')[0].slice(0, 300) };
  }
}
