// ../../apps/vscode-extensions/src/workers/model/autoVerify.ts
var AUTO_CHECKABLE_FILE_RE = /\.([cm]?[jt]sx?|vue|svelte|py|go|rs|rb|java|kt|cs|php)$/i;
var DEFAULT_CHECK_KINDS = ["lint", "typecheck", "test"];
var DERIVATION_FAILURE_LIMIT = 2;
var RUNNER_BROKEN_RE = /couldn't find a configuration file|no eslint configuration|eslint couldn't find|command not found|is not recognized as an internal|cannot find module|module not found|missing script|ERR_PNPM_NO_SCRIPT|ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT|no tests? (were )?found|no test files found|node_modules.{0,40}(not found|is not installed|missing)|EACCES|ENOENT/i;
var AutoVerifyTracker = class {
  kinds;
  maxFiles;
  perRound;
  limit;
  /** Files whose latest write succeeded, oldest first (deletes drop out). */
  written = /* @__PURE__ */ new Set();
  /** `${path}::${kind}` already run against the file's current content. */
  done = /* @__PURE__ */ new Set();
  unavailable = /* @__PURE__ */ new Set();
  derivationFailures = /* @__PURE__ */ new Map();
  executed = 0;
  constructor(config) {
    this.limit = config.limit;
    this.kinds = config.kinds ?? DEFAULT_CHECK_KINDS;
    this.maxFiles = config.maxFiles ?? 3;
    this.perRound = config.perRound ?? 6;
  }
  /** Checks that have really run (replays excluded) — the budget's consumption. */
  get executedChecks() {
    return this.executed;
  }
  /**
   * A successful write landed. The file's old check results are void, so
   * re-arm them; a delete takes the file out of scope entirely.
   */
  noteWrite(path, opts = {}) {
    if (!path)
      return;
    this.written.delete(path);
    if (!opts.deleted)
      this.written.add(path);
    for (const kind of this.kinds)
      this.done.delete(`${path}::${kind}`);
  }
  /** A check ran for this file (the model's own call, or one of ours). */
  noteCheckRan(path, kind) {
    if (path && kind)
      this.done.add(`${path}::${kind}`);
  }
  /** One of OUR checks is about to run: mark it done and spend the budget. */
  markRunning(path, kind) {
    this.noteCheckRan(path, kind);
    this.executed++;
  }
  /** Read a finished check's result: refunds a replay, retires a kind with no runner. */
  noteOutcome(kind, result) {
    if (result?.cached)
      this.executed--;
    if (result?.error) {
      const seen = (this.derivationFailures.get(kind) ?? 0) + 1;
      this.derivationFailures.set(kind, seen);
      if (seen >= DERIVATION_FAILURE_LIMIT)
        this.unavailable.add(kind);
      return "unavailable";
    }
    const exitCode = result?.exitCode;
    if (typeof exitCode !== "number" || exitCode === 0)
      return "passed";
    const output = typeof result?.output === "string" ? result.output : "";
    if (result?.timedOut || RUNNER_BROKEN_RE.test(output)) {
      const seen = (this.derivationFailures.get(kind) ?? 0) + 1;
      this.derivationFailures.set(kind, seen);
      if (seen >= DERIVATION_FAILURE_LIMIT)
        this.unavailable.add(kind);
      return "unavailable";
    }
    return "failed";
  }
  /** Every check still owed, newest changed file first. */
  pending() {
    const out = [];
    const paths = [...this.written].reverse().filter((p) => AUTO_CHECKABLE_FILE_RE.test(p)).slice(0, this.maxFiles);
    for (const path of paths) {
      for (const kind of this.kinds) {
        if (this.unavailable.has(kind))
          continue;
        if (!this.done.has(`${path}::${kind}`))
          out.push({ path, kind });
      }
    }
    return out;
  }
  /** The next round's worth of checks — empty when there is nothing left to do. */
  nextBatch() {
    const room = this.limit - this.executed;
    if (room <= 0)
      return [];
    return this.pending().slice(0, Math.min(this.perRound, room));
  }
  /**
   * Nothing left to verify: it all ran, or the budget for it is spent. The
   * budget clause matters — without it, a run whose checks cannot all fit
   * could never reach a final answer.
   */
  settled() {
    return this.executed >= this.limit || this.pending().length === 0;
  }
  snapshot() {
    return { writtenPaths: [...this.written], checksDone: [...this.done] };
  }
  restore(snapshot) {
    for (const path of snapshot.writtenPaths)
      this.written.add(path);
    for (const key of snapshot.checksDone)
      this.done.add(key);
  }
};
export {
  AUTO_CHECKABLE_FILE_RE,
  AutoVerifyTracker,
  DEFAULT_CHECK_KINDS
};
