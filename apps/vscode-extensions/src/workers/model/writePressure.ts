/**
 * Keeping a run that must CHANGE something from spending its whole budget
 * reading.
 *
 * The failure this exists for (ADO #1534774, observed live 2026-09-05): a
 * ticket run read its way across four sibling mapper files, named the root
 * cause precisely, and ended at the step cap with an untouched working tree
 * and a "Partially done — step limit reached" report. The investigation was
 * correct. The run simply never stopped investigating.
 *
 * Prose alone does not fix that — the commit nudge already asks the model to
 * stop reading, and a model that wants one more search does one more search.
 * So the pressure here is STRUCTURAL, in the same spirit as toolScope.ts:
 * decided from facts about the run (turns spent, writes applied), and applied
 * by changing what the model is offered rather than what it is told.
 *
 * Two mechanisms, in order:
 *   1. Narrowing — past {@link COMMIT_NARROW_AT} of the turn budget with
 *      nothing written, the discovery tools are withdrawn. `read_file`, the
 *      write tools and the checks remain, so the only move that makes progress
 *      is the edit.
 *   2. Reserve — a write that lands near the cap extends it once, so the run
 *      can verify what it just did instead of dying between the edit and the
 *      check. Narrowing without this would only move the failure later.
 *
 * Pure — no worker state — so the arithmetic is pinned by the headless tests.
 */

/**
 * Tools whose job is to find somewhere NEW to look. Withdrawn at the commit
 * point; everything else a run needs to finish (read_file for the exact lines
 * an edit copies, the write tools, the checks, git status/diff for reporting)
 * stays.
 */
export const DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'search_codebase',
  'explore',
  'find_files',
  'find_symbol',
  'find_references',
  'go_to_definition',
  'list_directory',
  'git_log',
  'git_blame',
  'search_docs',
  'get_confluence_page',
  'search_tickets',
  'get_ticket',
  'search_web',
]);

/** Turns guaranteed after the first write, so an edit can always be verified. */
export const VERIFICATION_RESERVE_TURNS = 4;

export interface CommitPressureContext {
  /**
   * The conversation is close enough to filling the context window that this
   * run is genuinely running out of room to look further.
   */
  contextExhausted: boolean;
  /** Consecutive turns that produced no new information (see contextBudget). */
  stagnant: boolean;
  writesApplied: number;
}

/**
 * Should the discovery tools be withdrawn for this round?
 *
 * Asks nothing about what the user typed, and — since the turn cap went away —
 * nothing about how many turns have passed either. Turn count was only ever a
 * proxy: what actually makes more searching pointless is having nowhere left
 * to put the results, or having stopped learning anything from them. Both are
 * measured (contextBudget.ts), so both are facts.
 *
 * The same withdrawal serves either ending. A run that has run out of room and
 * has not converged owes a conclusion, and whether that conclusion is an edit
 * or an answer is the model's call, not the harness's — which is why this
 * needs no notion of "write intent". The earlier version gated on a regex over
 * the prompt, exactly the guess that starved #1534774.
 *
 * One exception, also a fact: a run that has ALREADY written keeps every tool.
 * It is verifying, not stalling, and the completeness reflection may
 * legitimately need to search for other call sites of what it just renamed.
 */
export function shouldNarrowToConclude(ctx: CommitPressureContext): boolean {
  if (ctx.writesApplied > 0) return false;
  return ctx.contextExhausted || ctx.stagnant;
}

/** The offered tools with the discovery set removed. Order is preserved. */
export function narrowToCommitTools<T extends { function: { name: string } }>(
  defs: readonly T[]
): T[] {
  return defs.filter((def) => !DISCOVERY_TOOL_NAMES.has(def.function.name));
}

/**
 * The one-shot cap extension owed to a run whose first write landed too late
 * to verify. Returns the new cap, or the old one when nothing is owed.
 *
 * `hardCap` bounds it: the reserve buys a verification, never a second
 * investigation.
 */
export function capWithVerificationReserve(ctx: {
  turnIndex: number;
  iterationCap: number;
  hardCap: number;
  writesApplied: number;
  /** Already spent? The reserve is granted at most once per run. */
  reserveUsed: boolean;
}): number {
  if (ctx.reserveUsed) return ctx.iterationCap;
  if (ctx.writesApplied <= 0) return ctx.iterationCap;
  const turnsLeft = ctx.iterationCap - ctx.turnIndex - 1;
  if (turnsLeft >= VERIFICATION_RESERVE_TURNS) return ctx.iterationCap;
  const wanted = ctx.turnIndex + 1 + VERIFICATION_RESERVE_TURNS;
  return Math.min(ctx.hardCap, Math.max(ctx.iterationCap, wanted));
}

/**
 * What to tell the model when its tools change under it. Without this it
 * discovers the discovery tools are gone and reports that its tool access was
 * broken or revoked — the exact fabrication the cap-hit prompt already has to
 * argue with.
 *
 * Worded for either ending, because the harness does not claim to know which
 * one this run owes. The model does know, and it is the one being asked.
 */
export const COMMIT_NARROWED_NOTICE =
  'Checkpoint from the harness: the search and exploration tools are now withdrawn for the rest of this run — deliberately, by the harness, because most of the turn budget is spent and this run has not reached a conclusion yet. This is not a fault and nothing is broken: read_file, your edit tools (edit_file/create_file/delete_file) and the checks are all still available and still work. ' +
  'Conclude now from what you already have. If this task needs a code change, state the cause in ONE line with its file:line and make your NEXT tool call an edit — re-read only the exact lines you need to copy for oldString. ' +
  'If it does not need a change, give your final answer now. Either way, do not spend another turn looking for somewhere new to look.';
