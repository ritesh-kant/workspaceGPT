// ../../apps/vscode-extensions/src/workers/model/answerGates.ts
var INCOMPLETE_ANSWER_RE = /\b(needs? to be (examined|checked|read|inspected|verified|investigated|explored)|need(s)? to (examine|check|read|inspect|verify|investigate|explore)|would need to (look|check|read|examine|verify)|further (investigation|examination|analysis|exploration) (is|would be|may be|might be) (needed|required)|next step (is|would be) to|(I|let me|let'?s|let us) (will |shall |now )?(now )?(check|examine|read|look at|inspect|verify|investigate|search|find|locate|update|fix|rename|edit|modify|apply|retry|re-?run)\b|remains? to be (seen|checked|examined|verified)|have (not|n't) (yet )?(checked|examined|read|verified))/i;
var PERMISSION_SEEKING_RE = /\b(shall i|should i (go ahead|proceed|start|make|apply|implement)|do you want me to|would you like me to|want me to (go ahead|proceed|start|make|apply|implement|fix)|say the word|if you'?d like,? i (can|will)|i can (go ahead and )?(make|apply|implement|start)|ready to (implement|apply|proceed)|awaiting your (approval|confirmation|go)|please confirm|confirm before i|(shall|should) (i|we) (go|proceed)|let me know if you want me to|which (of these|one|option|approach|path) (should|do you|would)|what i need from you|tell me which|pick (one|an option)|recommend option \d|grant me (another|one more) (turn|pass|round)|another turn to (read|confirm|verify|finish)|one more (read|pass|turn|round)|i (want|need|would like|'?d like) to confirm [^.\n!?]{0,100}(with you|before)|confirm (one|two|three|a few|a couple of|these|the following|some) (things|points|details|questions|assumptions)|proposed questions? before)\b/i;
var CHANGE_PLAN_RE = /```diff|^\s*#{1,4}\s*(proposed |suggested |diff |edit |implementation )?(plan|the fix|files? to (change|modify|touch|edit))\b|^\s*\*\*(proposed |suggested |diff |edit |implementation )?(plan|the fix|files? to (change|modify|touch|edit))|\/\/\s*(before|after|was|becomes)\b|^\s*(before|after)\s*(\(|:)|\bhere'?s (the|my) (proposed )?plan\b|\bi have( not|n'?t) (yet )?applied (the|any|this|that) (edit|change|fix|patch|diff)|\bbefore i (edit|apply|make (the|any|this) (change|edit))|\b(the|a) (simplest|minimal|smallest|cleanest|proper|correct|reasonable|sensible)( correct| safe| default)? fix (is|would be|needs to|should)\b|\bwhat the fix (needs|should|must)\b|\bnot yet (patched|applied|implemented)\b|\bmet (after|once) (the )?fix\b/im;
function extractAnswerFilePaths(answer, cap = 3) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of String(answer ?? "").matchAll(
    /\b[\w@.-]+(?:\/[\w@.-]+)+\.(?:tsx?|jsx?|mjs|cjs|graphql|gql|json|ya?ml|css|scss|tf|py|go|rs|java|rb)\b/g
  )) {
    const path = m[0];
    if (seen.has(path))
      continue;
    seen.add(path);
    out.push(path);
    if (out.length >= cap)
      break;
  }
  return out;
}
var PREMATURE_AMBIGUITY_RE = /\b(ha(?:ve|s)(?: not|n'?t) (?:yet )?(?:read|searched|explored|looked|located|surfaced|checked|found)|not yet (?:read|searched|explored|checked|located|surfaced)|without (?:reading|searching)|cannot safely (?:diagnose|implement|fix|write)|before i can (?:implement|diagnose|fix|proceed)|i (?:still )?need to (?:read|locate|find|search))\b/i;
var TICKET_TERMINAL_RE = /^\s*(#{1,4}|\*\*)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(blocked|no change (is )?needed|nothing to change|already (fixed|implemented|resolved))\s*(\*\*)?\s*([:—–-].*| on .*)?$/imu;
var REPORT_SHAPED_RE = /^\s*(#{1,4}|\*\*)\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(acceptance criteria|verification)\b/imu;
var REPORT_STATUS_HEADING_RE = /^##\s+(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(done|partially done|partial|blocked|no change (is )?needed|nothing to change|already (fixed|implemented|resolved)|complete|completed|fixed|implemented)\b.*$/imu;
function stripReportPreamble(answer) {
  const text = String(answer ?? "");
  const m = REPORT_STATUS_HEADING_RE.exec(text);
  if (!m || m.index === 0)
    return text;
  const preamble = text.slice(0, m.index);
  if (preamble.length > 600 || /^\s*#{1,6}\s/m.test(preamble) || /```/.test(preamble))
    return text;
  return text.slice(m.index);
}
var IMPLEMENT_MANDATE_RE = /\b(implement (the|this|a) (fix|change|ticket|solution)|work on (the |this )?ticket|apply the (fix|change)|fix (the|this) (bug|issue|ticket)|resolve (the|this) (bug|issue|ticket))\b/i;
function isStallShapedAnswer(answer) {
  const a = String(answer ?? "");
  if (!a.trim())
    return false;
  return PREMATURE_AMBIGUITY_RE.test(a) || PERMISSION_SEEKING_RE.test(a) || CHANGE_PLAN_RE.test(a) || INCOMPLETE_ANSWER_RE.test(a);
}
var CLAIMS_CHANGES_RE = /\b(changes made|implemented fix|fix (implemented|applied|landed)|i (have )?(successfully )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced|edited)|(has|have) been (\w+ly )?(changed|renamed|updated|modified|created|fixed|implemented|applied|removed|replaced)|(was|were) (\w+ly )?(changed|renamed|updated|replaced|removed)|successfully (changed|renamed|updated|modified|created|fixed|implemented|applied)|is (now )?(removed|replaced)|now passes)\b|^\s*#{1,4}\s*implemented\b/im;
var MISSING_TOOL_CLAIM_RE = /\b(edit_file|create_file|delete_file|write tool|file[- ]write tool|edit tool)\b[^.\n]{0,120}\b(not (been )?(exposed|available|provided|granted)|unavailable|missing|absent|not in (my|the|this) tool)|\b(no|without an?|lacks? an?) (write|edit) tool\b|\bwrite tools? (is|are) not (available|exposed|provided)\b/i;
export {
  CHANGE_PLAN_RE,
  CLAIMS_CHANGES_RE,
  IMPLEMENT_MANDATE_RE,
  INCOMPLETE_ANSWER_RE,
  MISSING_TOOL_CLAIM_RE,
  PERMISSION_SEEKING_RE,
  PREMATURE_AMBIGUITY_RE,
  REPORT_SHAPED_RE,
  REPORT_STATUS_HEADING_RE,
  TICKET_TERMINAL_RE,
  extractAnswerFilePaths,
  isStallShapedAnswer,
  stripReportPreamble
};
