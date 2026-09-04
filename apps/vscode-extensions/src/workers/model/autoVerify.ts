/**
 * Auto-verification bookkeeping for the agent loop.
 *
 * `get_diagnostics` only sees what the editor's language server sees: it
 * cannot see a failing assertion, a lint rule the editor does not run, or a
 * type error in a changed file no editor ever opened. So "diagnostics clean"
 * is not "the change works", and a run that stops there ships untested code.
 * The prompt asks the model to run `run_checks` after its edits; models skip
 * it anyway (observed live: finished reports whose Verification section admits
 * the suite was never run).
 *
 * This tracks what the run still owes: for each file it changed, which of
 * lint / typecheck / test has actually been run against the file's CURRENT
 * content. The loop drives it — running the outstanding checks itself as
 * synthetic `run_checks` calls before it will accept a final answer — and
 * this object holds the state that keeps that bounded and honest:
 *
 *  - a write to a file RE-ARMS its checks, which is what turns a failing check
 *    into a fix-then-re-verify cycle instead of a one-shot complaint;
 *  - a check is marked done even when it FAILS, so a check that cannot pass
 *    costs one confront-and-fix cycle rather than looping forever;
 *  - a kind with no runner in this workspace (no "test" script, no eslint
 *    config) is dropped after two refusals instead of one refusal per file;
 *  - only checks that actually EXECUTED count against the budget — the host
 *    replays an identical derived command (a package-wide suite or `tsc`,
 *    shared by every file in a package) rather than running it twice.
 *
 * Pure and vscode-free on purpose: it is unit-tested headlessly.
 */

export type CheckKindName = 'lint' | 'typecheck' | 'test';

export interface PendingCheck {
  path: string;
  kind: CheckKindName;
}

/** Files a runner could plausibly cover — not README.md, not a lockfile. */
export const AUTO_CHECKABLE_FILE_RE = /\.([cm]?[jt]sx?|vue|svelte|py|go|rs|rb|java|kt|cs|php)$/i;

/** lint first (one file, fast), then typecheck (project-wide), then tests. */
export const DEFAULT_CHECK_KINDS: CheckKindName[] = ['lint', 'typecheck', 'test'];

/** Refusals to derive or START a command for a kind before it is written off for the run. */
const DERIVATION_FAILURE_LIMIT = 2;

/**
 * A non-zero exit that means the RUNNER never got going — not that the change
 * is broken. Confronting the model with "your edit broke the lint" when the
 * truth is "this repo has no eslint config" sends it chasing a tooling
 * problem it cannot fix, and it is a failure it cannot verify away either.
 * These are reported as unavailable instead, which also retires the kind
 * after the second one rather than repeating it per file.
 */
const RUNNER_BROKEN_RE =
  /couldn't find a configuration file|no eslint configuration|eslint couldn't find|command not found|is not recognized as an internal|cannot find module|module not found|missing script|ERR_PNPM_NO_SCRIPT|ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT|no tests? (were )?found|no test files found|node_modules.{0,40}(not found|is not installed|missing)|EACCES|ENOENT/i;

export interface AutoVerifyConfig {
  /** Hard ceiling on checks that actually run, over the whole run. */
  limit: number;
  /** Kinds to demand per changed file, in the order they should run. */
  kinds?: CheckKindName[];
  /** Newest N changed files only: a 20-file refactor must not run 60 checks. */
  maxFiles?: number;
  /** Checks per synthetic round, so one round is one round trip. */
  perRound?: number;
}

/**
 * What one finished check means for the run. 'skipped' is "nothing to run for
 * THIS file" (no test file exists for it) — not a failure, and not a broken
 * runner either, so it neither blocks the answer nor retires the kind.
 */
export type CheckVerdict = 'passed' | 'failed' | 'unavailable' | 'skipped';

/** run_checks declined to derive a target — the planner's own wording (verifyTools.ts). */
const NOTHING_TO_RUN_RE = /no test file found for|is .*package directory/i;

/** The shape of a `run_checks` result, as far as this needs to read it. */
export interface CheckResultLike {
  error?: unknown;
  exitCode?: unknown;
  /** Combined stdout+stderr, read only to tell a broken runner from a real failure. */
  output?: unknown;
  /** The runner was killed on the timeout — no verdict either way. */
  timedOut?: unknown;
  /** The host replayed a command already run against this tree — it cost nothing. */
  cached?: unknown;
}

/** Serializable state, for carrying a resumed run's history across the seam. */
export interface AutoVerifySnapshot {
  writtenPaths: string[];
  checksDone: string[];
}

export class AutoVerifyTracker {
  private readonly kinds: CheckKindName[];
  private readonly maxFiles: number;
  private readonly perRound: number;
  private readonly limit: number;
  /** Files whose latest write succeeded, oldest first (deletes drop out). */
  private readonly written = new Set<string>();
  /** `${path}::${kind}` already run against the file's current content. */
  private readonly done = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly derivationFailures = new Map<string, number>();
  private executed = 0;

  constructor(config: AutoVerifyConfig) {
    this.limit = config.limit;
    this.kinds = config.kinds ?? DEFAULT_CHECK_KINDS;
    this.maxFiles = config.maxFiles ?? 3;
    this.perRound = config.perRound ?? 6;
  }

  /** Checks that have really run (replays excluded) — the budget's consumption. */
  get executedChecks(): number {
    return this.executed;
  }

  /**
   * A successful write landed. The file's old check results are void, so
   * re-arm them; a delete takes the file out of scope entirely.
   */
  noteWrite(path: string, opts: { deleted?: boolean } = {}): void {
    if (!path) return;
    // Delete-then-add so insertion order is write order: `pending` works
    // newest-first, and a re-edited file is the newest again.
    this.written.delete(path);
    if (!opts.deleted) this.written.add(path);
    for (const kind of this.kinds) this.done.delete(`${path}::${kind}`);
  }

  /** A check ran for this file (the model's own call, or one of ours). */
  noteCheckRan(path: string, kind: string): void {
    if (path && kind) this.done.add(`${path}::${kind}`);
  }

  /** One of OUR checks is about to run: mark it done and spend the budget. */
  markRunning(path: string, kind: CheckKindName): void {
    this.noteCheckRan(path, kind);
    this.executed++;
  }

  /** Read a finished check's result: refunds a replay, retires a kind with no runner. */
  noteOutcome(kind: CheckKindName, result: CheckResultLike | null | undefined): CheckVerdict {
    if (result?.cached) this.executed--;
    if (result?.error) {
      // A file with no test of its own is a fact about the file, not the
      // runner: the next changed file may well have one. Counting it toward
      // DERIVATION_FAILURE_LIMIT retired tests for the whole run after two
      // untested helpers.
      if (NOTHING_TO_RUN_RE.test(String(result.error))) return 'skipped';
      const seen = (this.derivationFailures.get(kind) ?? 0) + 1;
      this.derivationFailures.set(kind, seen);
      if (seen >= DERIVATION_FAILURE_LIMIT) this.unavailable.add(kind);
      return 'unavailable';
    }
    const exitCode = result?.exitCode;
    if (typeof exitCode !== 'number' || exitCode === 0) return 'passed';
    const output = typeof result?.output === 'string' ? result.output : '';
    if (result?.timedOut || RUNNER_BROKEN_RE.test(output)) {
      const seen = (this.derivationFailures.get(kind) ?? 0) + 1;
      this.derivationFailures.set(kind, seen);
      if (seen >= DERIVATION_FAILURE_LIMIT) this.unavailable.add(kind);
      return 'unavailable';
    }
    return 'failed';
  }

  /** Every check still owed, newest changed file first. */
  pending(): PendingCheck[] {
    const out: PendingCheck[] = [];
    const paths = [...this.written]
      .reverse()
      .filter((p) => AUTO_CHECKABLE_FILE_RE.test(p))
      .slice(0, this.maxFiles);
    for (const path of paths) {
      for (const kind of this.kinds) {
        if (this.unavailable.has(kind)) continue;
        if (!this.done.has(`${path}::${kind}`)) out.push({ path, kind });
      }
    }
    return out;
  }

  /** The next round's worth of checks — empty when there is nothing left to do. */
  nextBatch(): PendingCheck[] {
    const room = this.limit - this.executed;
    if (room <= 0) return [];
    return this.pending().slice(0, Math.min(this.perRound, room));
  }

  /**
   * Nothing left to verify: it all ran, or the budget for it is spent. The
   * budget clause matters — without it, a run whose checks cannot all fit
   * could never reach a final answer.
   */
  settled(): boolean {
    return this.executed >= this.limit || this.pending().length === 0;
  }

  snapshot(): AutoVerifySnapshot {
    return { writtenPaths: [...this.written], checksDone: [...this.done] };
  }

  restore(snapshot: AutoVerifySnapshot): void {
    for (const path of snapshot.writtenPaths) this.written.add(path);
    for (const key of snapshot.checksDone) this.done.add(key);
  }
}
