import * as path from 'path';
import { execFile } from 'child_process';
import { NamedRoot, resolveAgainstRoots } from '../codebase/codebaseTools';
import { applyWrite, prepareRestore } from './agentWriteTools';
import { getOriginalContent } from './agentDiffProvider';
import { planVerification } from './verifyTools';
import { assertCommandAllowed, executeCommand } from './commandTools';
import { extractProbeLines, ProbeLines } from './debugProbes';

/**
 * Host-side parts of Debug mode (docs/design/debug-mode.md §5-6): probe
 * bookkeeping, the counterfactual check and the bisect. The pure pieces live in
 * debugProbes.ts and workers/model/debugState.ts; chatService wires these to
 * its write gate and approval cards.
 */

export interface ProbeRecord {
  id: string;
  path: string;
  line: number;
  label: string;
  hypothesis?: string;
}

/** The slice of a run's state Debug mode keeps. */
export interface DebugRunState {
  probes: Map<string, ProbeRecord>;
  probeSeq: number;
  /** The latest values each probe printed, with how often it fired. */
  probeOutput: Map<string, ProbeLines>;
  /** Roots the probes were written under, so a cancelled run can still clean up. */
  probeRoots?: NamedRoot[];
}

export function newDebugRunState(): DebugRunState {
  return { probes: new Map(), probeSeq: 0, probeOutput: new Map() };
}

/**
 * `result` with the probe values it carries. Scans the whole serialized result
 * (a command's output, a background job's tail, the browser console), because
 * the marker is what identifies a probe line, not where it was printed. Only
 * probes this run inserted count: a stray line with that shape is not evidence.
 */
export function withProbeOutput<T>(state: DebugRunState, result: T): T {
  if (!state.probes.size || !result || typeof result !== 'object') return result;
  // Every string the result carries, as real text: JSON.stringify would have escaped
  // the newlines and quotes the extraction (and the values shown to the model) rely on.
  const strings: string[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (typeof v === 'string') strings.push(v);
    else if (depth < 4 && v && typeof v === 'object') for (const child of Object.values(v)) collect(child, depth + 1);
  };
  collect(result, 0);
  const found = extractProbeLines(strings.join('\n'));
  const probes: Record<string, ProbeLines & { label: string; path: string }> = {};
  for (const [id, lines] of Object.entries(found)) {
    const rec = state.probes.get(id);
    if (!rec) continue;
    state.probeOutput.set(id, lines);
    probes[id] = { ...lines, label: rec.label, path: `${rec.path}:${rec.line}` };
  }
  return Object.keys(probes).length ? ({ ...(result as object), probes } as T) : result;
}

/** What `probe_output` returns. */
export function probeOutputReport(state: DebugRunState, id?: string): unknown {
  const ids = id ? [id] : [...state.probes.keys()];
  if (id && !state.probes.has(id)) throw new Error(`No probe ${id}. Inserted: ${[...state.probes.keys()].join(', ') || 'none'}.`);
  return {
    probes: ids.map((pid) => {
      const rec = state.probes.get(pid);
      const out = state.probeOutput.get(pid);
      return {
        id: pid,
        at: rec ? `${rec.path}:${rec.line}` : undefined,
        label: rec?.label,
        hypothesis: rec?.hypothesis,
        ...(out ? { firedCount: out.count, values: out.samples } : { note: 'Has not printed anything yet — run the repro (run_command / run_checks) so the line executes.' }),
      };
    }),
  };
}

// ── counterfactual_check ──

export interface CounterfactualArgs {
  path: string;
  kind?: string;
  keep?: string[];
}

const COUNTERFACTUAL_NOTE =
  'Check the output below fails on the ASSERTION you expect (the bug), not on an import or compile error caused by the revert — a test that fails only because a symbol the fix added is missing proves nothing.';

/**
 * Put the fix back out, run the repro, put the fix back. `changed` is the files
 * this turn's writes touched; originals come from the pre-agent content the
 * write gate recorded. The fix is ALWAYS restored (finally), and restoration is
 * verified, because a tool that leaves the user's tree reverted is worse than
 * having no tool at all.
 */
export async function runCounterfactual(
  args: CounterfactualArgs,
  roots: NamedRoot[],
  changed: readonly string[],
  onOutput?: (chunk: string) => void,
  /** The pre-run content of a file by absolute path; the write gate's record by default. */
  originalOf: (absPath: string) => string | undefined = getOriginalContent
): Promise<Record<string, unknown>> {
  const norm = (p: string) => p.replace(/^\.\//, '');
  const keep = new Set([...(args.keep ?? []), args.path].map(norm));
  const files = changed.filter((f) => !keep.has(norm(f)));
  if (!files.length) return { unavailable: 'no file was changed besides the test itself, so there is no fix to take out.' };

  const plan = planVerification(roots, { path: args.path, kind: 'test' });
  assertCommandAllowed(plan.command);

  const reverted: { display: string; restoreTo: string | null }[] = [];
  const failedRestore: string[] = [];
  let exit: { exitCode: number | null; timedOut?: boolean; output?: string } | null = null;
  try {
    for (const display of files) {
      const resolved = resolveAgainstRoots(roots, display);
      if (!resolved) return { unavailable: `cannot resolve ${display}.` };
      const original = originalOf(path.resolve(resolved.root.uri.fsPath, resolved.relPath));
      if (original === undefined) return { unavailable: `no original content was recorded for ${display}, so it cannot be put back.` };
      // '' is a file the run created (its pre-write content is empty): reverting means it is not there.
      const write = await prepareRestore(display, original === '' ? null : original, roots);
      if (!write) continue; // already identical to the original
      await applyWrite(write);
      reverted.push({ display, restoreTo: write.kind === 'create' ? null : write.before });
    }
    if (!reverted.length) return { unavailable: 'the changed files already equal their originals — there is no fix in place.' };
    exit = await executeCommand(plan.command, plan.cwd, undefined, onOutput, true);
  } finally {
    // Always put the fix back, last-reverted first.
    for (const r of [...reverted].reverse()) {
      try {
        const back = await prepareRestore(r.display, r.restoreTo, roots);
        if (back) await applyWrite(back);
      } catch (e) {
        failedRestore.push(`${r.display}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const out = String(exit?.output ?? '');
  return {
    counterfactual: true,
    command: plan.command,
    cwd: plan.displayCwd,
    files: reverted.map((r) => r.display),
    revertedExitCode: exit?.timedOut ? null : exit?.exitCode ?? null,
    timedOut: !!exit?.timedOut,
    output: out.length > 2500 ? '…' + out.slice(-2500) : out,
    restored: failedRestore.length === 0,
    ...(failedRestore.length ? { restoreFailed: failedRestore, warning: 'The fix could NOT be fully restored — tell the user which files, and re-apply your edits.' } : {}),
    note: COUNTERFACTUAL_NOTE,
  };
}

// ── git_bisect ──

const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/;
const BISECT_TIMEOUT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 30_000;

function gitExec(cwd: string, args: string[], timeout: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | string) : 0;
      resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, out: `${stdout}${stderr}`.trimEnd() });
    });
  });
}

export interface BisectArgs {
  good: string;
  bad?: string;
  command: string;
}

/** What the approval card shows for a bisect. */
export function bisectSummary(args: BisectArgs): string {
  return `git bisect ${args.good}..${args.bad || 'HEAD'} running: ${args.command}`;
}

/**
 * `git bisect run` between two commits. Refuses a dirty tree (a checkout would
 * clobber it), validates the refs as plain names so none can be read as an
 * option, always resets to where the user was, and is bounded in time.
 */
export async function runGitBisect(args: BisectArgs, roots: NamedRoot[], approve: () => Promise<void>): Promise<Record<string, unknown>> {
  const cwd = roots[0]?.uri.fsPath;
  if (!cwd) throw new Error('No workspace folder is open.');
  const good = (args.good ?? '').trim();
  const bad = (args.bad ?? 'HEAD').trim() || 'HEAD';
  const command = (args.command ?? '').trim();
  if (!REF_RE.test(good) || !REF_RE.test(bad)) throw new Error('good and bad must be plain commit, tag or branch names.');
  if (!command) throw new Error('command must be non-empty.');
  assertCommandAllowed(command);

  const dirty = await gitExec(cwd, ['status', '--porcelain'], STEP_TIMEOUT_MS);
  if (dirty.out) {
    throw new Error(`git_bisect needs a clean working tree, and this one has changes:\n${dirty.out.slice(0, 400)}\nBisect before you edit or add probes (remove_probes first), or ask the user to commit or stash.`);
  }
  const start = await gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], STEP_TIMEOUT_MS);
  const headName = start.out.trim() === 'HEAD' ? (await gitExec(cwd, ['rev-parse', 'HEAD'], STEP_TIMEOUT_MS)).out.trim() : start.out.trim();

  await approve();

  let log = '';
  try {
    const begun = await gitExec(cwd, ['bisect', 'start', bad, good], STEP_TIMEOUT_MS);
    if (begun.code !== 0) throw new Error(`git bisect start failed: ${begun.out.slice(0, 300)}`);
    const ran = await gitExec(cwd, ['bisect', 'run', 'sh', '-c', command], BISECT_TIMEOUT_MS);
    log = ran.out;
  } finally {
    await gitExec(cwd, ['bisect', 'reset'], STEP_TIMEOUT_MS);
    // bisect reset returns to the starting ref; be sure on a detached start too.
    await gitExec(cwd, ['checkout', '--quiet', headName], STEP_TIMEOUT_MS);
  }

  const first = /([0-9a-f]{7,40}) is the first bad commit/.exec(log)?.[1];
  if (!first) {
    return {
      found: false,
      note: 'Bisect did not isolate a commit — the command may not fail on the bad commit, may pass on every commit, or may not be deterministic. Last output follows.',
      output: log.length > 1500 ? '…' + log.slice(-1500) : log,
    };
  }
  const info = await gitExec(cwd, ['show', '-s', '--date=short', '--format=%h %ad %an — %s', first], STEP_TIMEOUT_MS);
  const files = await gitExec(cwd, ['show', '--stat', '--format=', first], STEP_TIMEOUT_MS);
  return {
    found: true,
    firstBadCommit: first.slice(0, 12),
    commit: info.out,
    filesChanged: files.out.split('\n').slice(0, 25).join('\n'),
    note: 'This commit introduced the failure. Read its diff (git_diff on those files, or run_command git show) and find which line of it is wrong — that is your root cause candidate; confirm it with the repro.',
  };
}
