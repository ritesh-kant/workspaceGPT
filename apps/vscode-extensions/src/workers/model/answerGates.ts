/**
 * Final-answer failure signatures for the agent loop's honesty gates.
 *
 * Extracted from runAgentLoop (modelWorker.ts) so the headless eval harness
 * can regression-test them against real observed stall answers — every regex
 * here exists because a live run ended with the matching failure, and the
 * cheapest way to keep them honest is to pin the offending transcript text in
 * packages/agent-evals/src/headless/unit-tests.mjs.
 */

/**
 * Which harness the run gets.
 *
 * Every phrase gate in this file was added in response to one observed
 * failure of a 14B-class local model — the comments say so, individually.
 * They earned their place there, and they are the wrong instrument on a
 * capable model: each one that fires spends a whole iteration re-answering,
 * and the prompt scaffolding they need is a tax on every single turn. On
 * ticket #1534774 the arithmetic was stark — a 33-turn cap, and a run that
 * never produced an in-loop answer at all, so not one phrase gate ever ran
 * while the turns drained away.
 *
 * The split is by KIND, not by strictness:
 *
 * - `strong-model` runs the STRUCTURAL gates only — the ones that check
 *   state, which no phrasing can talk its way out of: zero writes on an
 *   implement mandate, a last write that failed, claimed changes with nothing
 *   on disk, zero successful tool results, an empty answer, unverified
 *   writes, and the P2 pacing signal.
 * - `small-model` adds the phrase gates on top: premature ambiguity,
 *   permission-seeking, plan-instead-of-execute, narrated tool plans,
 *   incomplete-answer, the false "no write tool" claim, force-read, and the
 *   blanket completeness reflection.
 *
 * Note what is NOT gated: honesty. A fabricated completion report is caught
 * in both profiles, because "the model is good enough to be trusted" is
 * exactly the assumption that failure violates.
 */
export type HarnessProfile = 'small-model' | 'strong-model';

/**
 * Model families that are commonly run at 7B-32B, where the phrase gates were
 * earned. Matched on the model ID because the PROVIDER is not enough on its
 * own: `isLocalProvider` only detects Ollama, so a qwen-14B served through
 * OpenRouter would otherwise be handed the strong-model harness and lose the
 * gates that exist for exactly it.
 *
 * Deliberately generous, because the two errors are not symmetric: calling a
 * capable model "small" costs some turns and prompt weight (today's
 * behaviour, which shipped for months), while calling a weak model "strong"
 * removes the guardrails holding its run together.
 */
export const SMALL_MODEL_HINT_RE =
  /\b(qwen|qwq|llama|codellama|mistral|mixtral|gemma|phi-?[0-9]|starcoder|stablelm|tinyllama|openhermes|nous-?hermes|dolphin|granite|deepseek-coder|codestral)\b/i;

/**
 * Local (Ollama) runs and small-model IDs get the small-model harness;
 * anything else — the managed provider included — gets the structural one.
 * An explicit override wins over both, which is what lets the eval harness
 * run one ticket under each profile.
 */
export function resolveHarnessProfile(opts: {
  isLocalProvider: boolean;
  modelId?: string | null;
  override?: string | null;
}): HarnessProfile {
  if (opts.override === 'small-model' || opts.override === 'strong-model') return opts.override;
  if (opts.isLocalProvider) return 'small-model';
  if (opts.modelId && SMALL_MODEL_HINT_RE.test(opts.modelId)) return 'small-model';
  return 'strong-model';
}

/** Do the phrasing-based answer gates run in this profile? */
export function phraseGatesEnabled(profile: HarnessProfile): boolean {
  return profile === 'small-model';
}

/**
 * A partial answer that ANNOUNCES remaining work instead of doing it ("the
 * cloudwatch.tf file needs to be examined to see the schedule") — observed
 * live with gemini-2.5-flash, forcing the user to type "continue".
 */
export const INCOMPLETE_ANSWER_RE =
  /\b(needs? to be (examined|checked|read|inspected|verified|investigated|explored)|need(s)? to (examine|check|read|inspect|verify|investigate|explore)|would need to (look|check|read|examine|verify)|further (investigation|examination|analysis|exploration) (is|would be|may be|might be) (needed|required)|next step (is|would be) to|(I|let me|let'?s|let us) (will |shall |now )?(now )?(check|examine|read|look at|inspect|verify|investigate|search|find|locate|update|fix|rename|edit|modify|apply|retry|re-?run)\b|remains? to be (seen|checked|examined|verified)|have (not|n't) (yet )?(checked|examined|read|verified))/i;

/**
 * Ending by asking the user for permission — or offering them a MENU of next
 * steps to pick from — is the same failure as announcing remaining work: the
 * task is not done and the user has to type something to get anything.
 * Observed live as three consecutive "Shall I go ahead?" turns on one ADO bug,
 * later as a ticket run ending with "which of these should I do next?
 * 1. Read deeper… 2. Search Confluence… 3. You point me at a component…",
 * and later still as a fully-investigated run that ended with "I want to
 * confirm the intended per-variant fields with you before changing the data
 * flow" / "Before I make the change I want to confirm two things" — soft
 * confirmation phrasing wrapped around a diff it never applied.
 */
export const PERMISSION_SEEKING_RE =
  /\b(shall i|should i (go ahead|proceed|start|make|apply|implement)|do you want me to|would you like me to|want me to (go ahead|proceed|start|make|apply|implement|fix)|say the word|if you'?d like,? i (can|will)|i can (go ahead and )?(make|apply|implement|start)|ready to (implement|apply|proceed)|awaiting your (approval|confirmation|go)|please confirm|confirm before i|(shall|should) (i|we) (go|proceed)|let me know if you want me to|which (of these|one|option|approach|path) (should|do you|would)|what i need from you|tell me which|pick (one|an option)|recommend option \d|grant me (another|one more) (turn|pass|round)|another turn to (read|confirm|verify|finish)|one more (read|pass|turn|round)|i (want|need|would like|'?d like) to confirm [^.\n!?]{0,100}(with you|before)|confirm (one|two|three|a few|a couple of|these|the following|some) (things|points|details|questions|assumptions)|proposed questions? before)\b/i;

/**
 * Structural markers of an answer that PRESENTS a change instead of making
 * it: a diff fence, a "files to change" list, before/after ("// was:")
 * snippets, an explicit "I have not applied the edit", or "the simplest
 * correct fix is" followed by code it never wrote to disk (all observed live
 * on ticket-1324128 runs). Narrow on purpose — an ordinary read-only
 * explanation containing code must not match, or every "how does X work"
 * answer would trip the gate.
 */
export const CHANGE_PLAN_RE =
  /```diff|^\s*#{1,4}\s*(proposed |suggested |diff |edit |implementation )?(plan|the fix|files? to (change|modify|touch|edit))\b|^\s*\*\*(proposed |suggested |diff |edit |implementation )?(plan|the fix|files? to (change|modify|touch|edit))|\/\/\s*(before|after|was|becomes)\b|^\s*(before|after)\s*(\(|:)|\bhere'?s (the|my) (proposed )?plan\b|\bi have( not|n'?t) (yet )?applied (the|any|this|that) (edit|change|fix|patch|diff)|\bbefore i (edit|apply|make (the|any|this) (change|edit))|\b(the|a) (simplest|minimal|smallest|cleanest|proper|correct|reasonable|sensible)( correct| safe| default)? fix (is|would be|needs to|should)\b|\bwhat the fix (needs|should|must)\b|\bnot yet (patched|applied|implemented)\b|\bmet (after|once) (the )?fix\b/im;

/**
 * Path-like tokens in a final answer — the files a stall answer says it still
 * needs ("I still need to read apps/mms/.../mapProducts.ts"). Requires at
 * least one directory separator so prose like "Node.js" or "package.json"
 * alone doesn't count, and a code-ish extension so URLs and sentence
 * fragments don't. Used by the force-read gate: the harness reads these
 * itself instead of ending the run to ask for another turn.
 */
export function extractAnswerFilePaths(answer: string, cap = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(answer ?? '').matchAll(
    /\b[\w@.-]+(?:\/[\w@.-]+)+\.(?:tsx?|jsx?|mjs|cjs|graphql|gql|json|ya?ml|css|scss|tf|py|go|rs|java|rb)\b/g
  )) {
    const path = m[0];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * An answer that declares the task unclear or blocked while NAMING
 * investigation the model can still do itself — "I have not yet read the PLP
 * components", "I haven't searched Confluence for a design doc", "cannot
 * safely diagnose without reading these". That is not ambiguity, it is an
 * unfinished investigation wearing ambiguity's escape hatch (the seeded
 * ticket prompt allows "say what's unclear instead of guessing", and models
 * take the exit long before the tools are exhausted — observed live on a
 * ticket run that stopped after one list_directory to ask which of three
 * obvious next steps it should take).
 *
 * Deliberately matches only self-serviceable gaps (reading, searching,
 * locating). A genuinely blocked answer — "the ticket doesn't say whether the
 * discount should round up or down" — matches nothing here and passes.
 */
export const PREMATURE_AMBIGUITY_RE =
  /\b(ha(?:ve|s)(?: not|n'?t) (?:yet )?(?:read|searched|explored|looked|located|surfaced|checked|found)|not yet (?:read|searched|explored|checked|located|surfaced)|without (?:reading|searching)|cannot safely (?:diagnose|implement|fix|write)|before i can (?:implement|diagnose|fix|proceed)|i (?:still )?need to (?:read|locate|find|search))\b/i;

/**
 * The valid TERMINAL declarations of a ticket run that ends with zero edits:
 * a "## Blocked" section naming the missing product decision, or a
 * "## No change needed" section citing evidence the code already satisfies
 * the acceptance criteria. Requires a heading or bold marker so prose like
 * "requests are blocked by CORS" never counts — the prompt (buildTicketBlock)
 * teaches the model these exact section names, so the marker is deliberate.
 *
 * Exists because regex-matching stall PHRASING is whack-a-mole: the fourth
 * observed ticket-1324128 stall asked nothing at all — a clean investigation
 * report with an "Assumptions" section describing the fix it never applied.
 * The invariant that survives rephrasing is structural: implement-mandated
 * ticket run + zero writes + no terminal section = stall.
 *
 * The heading must END after the terminal phrase (optionally a colon/dash
 * clause, or "on <decision>") — the sixth observed stall wrote "## Blocked?
 * No." as a heading, which satisfied a bare \b match while declaring the
 * exact opposite.
 */
export const TICKET_TERMINAL_RE =
  /^\s*(#{1,4}|\*\*)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(blocked|no change (is )?needed|nothing to change|already (fixed|implemented|resolved))\s*(\*\*)?\s*([:—–-].*| on .*)?$/imu;

/**
 * A finished run's REPORT, as the FINAL REPORT FORMAT in promptTemplates
 * teaches it: an "Acceptance criteria" or "Verification" section heading
 * (optionally emoji-prefixed). The worker uses it, together with
 * writesApplied > 0 and clean post-write diagnostics, to exempt a completed
 * report from the phrasing gates — a courteous closing under "Notes" ("let
 * me know if you want the AQA sweep pulled into a follow-up") used to match
 * PERMISSION_SEEKING_RE and send a DONE run back to re-verify itself until
 * the step limit, whose forced final answer then headlined "Step limit
 * reached" over a finished task (observed live on ticket 1516750).
 */
export const REPORT_SHAPED_RE =
  /^\s*(#{1,4}|\*\*)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(acceptance criteria|verification)\b/imu;

/**
 * The status heading that opens a FINAL-REPORT-FORMAT answer ("## ✅ Done —",
 * "## 🚫 Blocked —", …). Anchored to a level-2 heading so a "### Notes" line
 * or prose never matches.
 */
export const REPORT_STATUS_HEADING_RE =
  /^##\s+(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(done|partially done|partial|blocked|no change (is )?needed|nothing to change|already (fixed|implemented|resolved)|complete|completed|fixed|implemented)\b.*$/imu;

/**
 * Drop a narrated preamble ahead of the report's status heading — "Diagnostics
 * are clean across the whole Checkout folder. Now let me write the final
 * report." (observed live) — so the webview's status banner is the first thing
 * the user sees. Conservative: only a short, heading-free prefix is removed; a
 * long lead-in is left alone in case it carries something the report does not.
 */
export function stripReportPreamble(answer: string): string {
  const text = String(answer ?? '');
  const m = REPORT_STATUS_HEADING_RE.exec(text);
  if (!m || m.index === 0) return text;
  const preamble = text.slice(0, m.index);
  if (preamble.length > 600 || /^\s*#{1,6}\s/m.test(preamble) || /```/.test(preamble)) return text;
  return text.slice(m.index);
}

/**
 * Does the user's message actually ask for the ticket to be IMPLEMENTED (as
 * the seeded My-Work prompts do), rather than summarized or discussed? Gates
 * the zero-write ticket-completion nudge so "summarize ticket 1234" never
 * gets told to start editing. Deliberately narrow — a false negative just
 * means the structural gate stays quiet and the phrasing gates still apply.
 */
export const IMPLEMENT_MANDATE_RE =
  /\b(implement (the|this|a) (fix|change|ticket|solution)|work on (the |this )?ticket|apply the (fix|change)|fix (the|this) (bug|issue|ticket)|resolve (the|this) (bug|issue|ticket))\b/i;

/**
 * The assistant NARRATING that it has found the cause — the moment a run
 * should stop reading and start editing.
 *
 * Pinned to the observed #1534774 transcript, where the model's own prose
 * between tool calls read "This is the key insight!" (step 50) and "Now I
 * have a complete understanding. The fix needs to clear the storage data…"
 * (step 74), and it then spent the rest of a 33-turn cap reading. Feeds the
 * commit nudge, nothing else: a false positive costs one reminder turn, so
 * this can afford to be generous where the honesty gates cannot.
 */
export const ROOT_CAUSE_NARRATION_RE =
  /\b(root cause (is|was|lies|sits|turns out)|the fix (needs to|is to|would be|should|must)|key insight|complete understanding|now i (fully |finally )?understand (the )?(root cause|bug|problem|issue|why)|now i (can )?see the (full|whole|complete|entire) (picture|flow|chain)|the (bug|problem|issue) is (that|in|the)|that explains (the|why)|this is the (root cause|bug|problem|key insight))\b/i;

/*
 * Calibrated against all 24 prose notes of the #1534774 transcript. Two
 * earlier drafts were too loose to be useful: a bare "this is the" matched
 * "(this is the key flag for the rejection section)" at turn ~5, and a bare
 * "now i understand" matched "Now I understand the architecture. The flow
 * is:" at turn ~10 — both mid-investigation, and either one would have spent
 * the nudge long before the model had anything to commit. Understanding of
 * the CAUSE is the trigger; understanding of the architecture is not.
 */

/**
 * Does this message ask for the workspace to be CHANGED?
 *
 * Separate from IMPLEMENT_MANDATE_RE on purpose. That one is deliberately
 * narrow and gates the ticket-completion nudge, where a false positive would
 * tell "summarize ticket 1234" to start editing; widening it would put that
 * at risk. But narrow also means it misses the most ordinary request there
 * is: "fix the crash in foo.ts" matches none of its alternatives, because
 * "crash" is not in its (bug|issue|ticket) list — so without this, the P2
 * pacing signal and the unfinished-run exit would cover ticket runs and
 * approved plans while leaving hand-typed fix requests exactly as they were.
 *
 * The asymmetry that makes a wider net safe here: a false positive costs one
 * reminder message on a run that was not going to edit anything, while a
 * false negative costs the whole failure mode this exists to catch.
 */
export const WRITE_INTENT_RE =
  /\b(fix|fixing|implement|apply|add|remove|delete|drop|rename|update|refactor|migrate|replace|extract|revert|correct|resolve|patch|wire|hook up|clean up|handle|support|enable|disable|bump|upgrade)\b/i;

/**
 * Interrogatives that make a message a QUESTION about the code rather than an
 * instruction to change it — "how do I fix the crash", "why is the mapper
 * updating the status". Note that polite imperatives are NOT questions
 * whatever their punctuation: "can you fix the crash?" is an instruction, so
 * neither a leading "can" nor a trailing question mark disqualifies a message.
 */
const LEADING_INTERROGATIVE_RE = /^\s*\W*(how|what|why|where|which|when|who|whose|is|are|was|were|does|do|did)\b/i;

export function hasWriteIntent(prompt: string): boolean {
  const p = String(prompt ?? '').trim();
  if (!p) return false;
  if (LEADING_INTERROGATIVE_RE.test(p)) return false;
  return WRITE_INTENT_RE.test(p);
}

/**
 * Should the commit nudge fire on this round, and on which trigger?
 *
 * A pure function so the arithmetic is testable — it decides whether a run
 * gets its one chance to be told "stop reading, start editing", and a silent
 * off-by-one here would be invisible in production. The worker owns the two
 * one-shot flags and passes them back in.
 *
 * `narration` fires the round the model says it found the cause; `budget`
 * fires once the run is deep enough into its turns that reading can no longer
 * pay for itself. They are independent: spending one must not disarm the
 * other (see the flags in runAgentLoop).
 */
export function commitNudgeTriggers(ctx: {
  /** The assistant's prose on this round, alongside its tool calls. */
  assistantProse: string;
  /** Zero-based index of the round just executed. */
  turnIndex: number;
  iterationCap: number;
  writesApplied: number;
  writeIntent: boolean;
  planMode?: boolean;
  budgetExhausted?: boolean;
  narrationUsed: boolean;
  budgetUsed: boolean;
}): { fire: boolean; narration: boolean; budget: boolean; turnsLeft: number } {
  const turnsLeft = ctx.iterationCap - ctx.turnIndex - 1;
  const none = { fire: false, narration: false, budget: false, turnsLeft };
  // Nothing to commit to, nothing left to commit with, or committing is not
  // this turn's job.
  if (ctx.planMode || ctx.budgetExhausted) return none;
  if (!ctx.writeIntent) return none;
  if (ctx.writesApplied > 0) return none;
  if (turnsLeft <= 0) return none;
  // Third round at the earliest: an opening "the problem is probably X" is a
  // hypothesis, and a run pushed to edit on it would skip the investigation
  // that makes the edit correct.
  if (ctx.turnIndex < 2) return none;
  const narration = !ctx.narrationUsed && ROOT_CAUSE_NARRATION_RE.test(ctx.assistantProse || '');
  const budget = !ctx.budgetUsed && ctx.turnIndex >= Math.floor(ctx.iterationCap * 0.6);
  return { fire: narration || budget, narration, budget, turnsLeft };
}

/**
 * A run that was supposed to CHANGE something, ran out of steps or output
 * budget, and changed nothing.
 *
 * Structural on purpose. Every phrase gate in this file missed the #1534774
 * cap-hit answer — premature-ambiguity, permission-seeking, change-plan,
 * incomplete-answer and claims-changes all returned false, and its "## 🚫
 * Blocked" heading additionally satisfied TICKET_TERMINAL_RE, so the harness
 * recorded a legitimate ending and the host's one-shot auto-resume never
 * fired. Matching better phrasing is whack-a-mole; the fact that survives any
 * rephrasing is that the turns ran out with an untouched tree.
 *
 * Only the two zero-write endings that are genuinely FINISHED are spared: a
 * "## No change needed" report is a real answer, so re-running it would just
 * spend a second budget confirming it. A "## Blocked" at the cap is NOT
 * spared — blocked-because-out-of-steps is exactly the failure this catches,
 * and a resumed run is free to conclude Blocked again on its own merits.
 */
export function isUnfinishedWriteRun(
  answer: string,
  ctx: { writesApplied: number; writeIntent: boolean; planMode?: boolean }
): boolean {
  if (ctx.planMode) return false;
  if (ctx.writesApplied > 0) return false;
  if (!ctx.writeIntent) return false;
  return !NO_CHANGE_TERMINAL_RE.test(String(answer ?? ''));
}

/**
 * The one zero-write ending that is finished rather than interrupted — a
 * subset of TICKET_TERMINAL_RE, which also admits "## Blocked".
 */
export const NO_CHANGE_TERMINAL_RE =
  /^\s*(#{1,4}|\*\*)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(no change (is )?needed|nothing to change|already (fixed|implemented|resolved))\b/imu;

/**
 * Is this final answer stall-shaped — any of the four failure signatures?
 * Single source of truth shared by the worker (tags its 'done' message, since
 * only it knows writesApplied) and the host (transcript retention + the
 * autonomous auto-resume decision). The caller supplies the writes guard:
 * a completed run's report legitimately contains plan-ish prose ("// was:"
 * explanations of the applied diff), so shape alone is only meaningful when
 * nothing was written.
 */
export function isStallShapedAnswer(answer: string): boolean {
  const a = String(answer ?? '');
  if (!a.trim()) return false;
  return (
    PREMATURE_AMBIGUITY_RE.test(a) ||
    PERMISSION_SEEKING_RE.test(a) ||
    CHANGE_PLAN_RE.test(a) ||
    INCOMPLETE_ANSWER_RE.test(a)
  );
}

/**
 * An answer NARRATING completed changes ("Changes Made:", "## Implemented
 * fix", "the block is removed", "→ replaced with") — meaningful only when
 * writesApplied === 0, where it is the most dangerous failure of all: a lie.
 * Observed live twice: qwen role-playing a full markdown story of edits it
 * never attempted, and a ticket-1324128 run reporting "## Implemented fix"
 * with per-AC "Met" verdicts while the working tree was untouched. Feeds the
 * phantom-changes confrontation gate AND the delivery-time harness note the
 * model cannot phrase its way around.
 */
export const CLAIMS_CHANGES_RE =
  /\b(changes made|implemented fix|fix (implemented|applied|landed)|i (have )?(successfully )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced|edited|added|introduced|extracted|wired|rewired|refactored|moved)|(has|have) been (\w+ly )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced)|(was|were) (\w+ly )?(changed|renamed|updated|replaced|removed)|successfully (changed|renamed|updated|modified|created|fixed|implemented|applied)|is (now )?(removed|replaced)|now passes)\b|^\s*#{1,4}\s*implemented\b/im;

/**
 * The answer claims a WRITE tool is missing from its tool list ("the
 * edit_file tool has not been exposed to me in this turn", "I cannot make a
 * code change without a write tool"). Observed live as the eighth
 * ticket-1324128 failure: a well-formed "## Blocked" section whose stated
 * blocker was false — edit_file/create_file/delete_file are unconditionally
 * in TOOL_DEFS on every codebase turn. Models reach for this excuse after an
 * empty search result or a failed tool-call parse; either way the correct
 * response is deterministic confrontation, not standing down.
 */
export const MISSING_TOOL_CLAIM_RE =
  /\b(edit_file|create_file|delete_file|write tool|file[- ]write tool|edit tool)\b[^.\n]{0,120}\b(not (been )?(exposed|available|provided|granted)|unavailable|missing|absent|not in (my|the|this) tool)|\b(no|without an?|lacks? an?) (write|edit) tool\b|\bwrite tools? (is|are) not (available|exposed|provided)\b/i;

/**
 * A FINAL-REPORT status heading that asserts the work is DONE. Deliberately
 * excludes the two headings a zero-write run may legitimately end on
 * ("## Blocked", "## No change needed") — those are in REPORT_STATUS_HEADING_RE
 * and TICKET_TERMINAL_RE instead.
 */
export const REPORT_CLAIMS_DONE_RE =
  /^##\s+(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(done|partially done|partial|complete|completed|fixed|implemented)\b/imu;

/**
 * The report's "### Changes" section. FINAL_REPORT_FORMAT says to OMIT it when
 * nothing changed, so its presence is a first-person claim that files were
 * edited — and a cleaner signal than any verb list, since a fabricated report
 * lists its invented files exactly here.
 */
export const REPORT_CHANGES_SECTION_RE =
  /^\s*#{2,4}\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?changes\b/imu;

/** Does this answer claim that files were changed — by prose or by report section? */
export function claimsFileChanges(answer: string): boolean {
  const a = String(answer ?? '');
  return CLAIMS_CHANGES_RE.test(a) || REPORT_CHANGES_SECTION_RE.test(a);
}

/**
 * Is this answer claiming work that no write in this session backs up?
 *
 * The delivery-time honesty stamp used to fire only on runs where writing was
 * already on the table (a ticket implement mandate, an approved plan, or an
 * attempted write). Observed live right after ticket #1534774 stalled: the
 * user asked the plain question "give me all the steps you did to find the
 * root cause and fix it", and the answer was a full "## ✅ Done — fixed"
 * report — invented files, an invented regression test, "12 passed" — on a
 * turn that called no write tool at all. None of the three scope conditions
 * held, so nothing was stamped and a fabricated completion report shipped.
 *
 * So the scope conditions become one of two ways in, not the only way: a
 * report that HEADS ITSELF "Done" while claiming file changes is checkable on
 * its own, whatever kind of turn produced it.
 *
 * The guards are what keep it honest in the other direction:
 * - `planMode` — proposing edits in prose is that mode's whole deliverable.
 * - `priorWritesInSession` — turn 1 applies the fix, turn 2 recaps it truthfully.
 *   That recap has zero writes of its own and must not be called a lie.
 * - `claimsFileChanges` — an answer with no change claim is not stamped even
 *   when it is headed "Done" (a "run the tests" task legitimately ends that
 *   way with an untouched tree).
 */
export function isUnbackedCompletionClaim(
  answer: string,
  ctx: {
    /** Writes applied by THIS worker run. */
    writesApplied: number;
    /** Writes applied by EARLIER turns of this chat session (host-tracked). */
    priorWritesInSession?: number;
    /** Writing was already expected: ticket implement mandate, approved plan, or a write was attempted. */
    writeExpected?: boolean;
    planMode?: boolean;
  }
): boolean {
  const a = String(answer ?? '');
  if (!a.trim()) return false;
  if (ctx.planMode) return false;
  if (ctx.writesApplied > 0) return false;
  if ((ctx.priorWritesInSession ?? 0) > 0) return false;
  if (!claimsFileChanges(a)) return false;
  return !!ctx.writeExpected || REPORT_CLAIMS_DONE_RE.test(a);
}
