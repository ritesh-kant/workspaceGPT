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
  /\b(changes made|implemented fix|fix (implemented|applied|landed)|i (have )?(successfully )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced|edited)|(has|have) been (\w+ly )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced)|(was|were) (\w+ly )?(changed|renamed|updated|replaced|removed)|successfully (changed|renamed|updated|modified|created|fixed|implemented|applied)|is (now )?(removed|replaced)|now passes)\b|^\s*#{1,4}\s*implemented\b/im;

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
