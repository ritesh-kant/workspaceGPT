/**
 * Does this draft message read like a bug report?
 *
 * Used ONLY to offer a "Debug this?" suggestion above the composer. It never
 * switches Debug mode on and never changes what a send does: a pattern over
 * the user's text may add a suggestion, not gate a capability (a miss costs
 * nothing, since "+ → Debug a bug" is always there). Bug TICKETS enter Debug
 * mode from their type instead, which is a fact.
 */
const BUG_REPORT_RE =
  /\b(crash(es|ed|ing)?|throws?|threw|exceptions?|stack ?trace|traceback|regress(ed|ion)|(is|are|was|were|keeps?|started)\s+(broken|failing)|fails?\s+(with|on|when|to)|failing|not working|(does(n'?t| not)|did(n'?t| not)|won'?t|can'?t|cannot)\s+(work|load|save|render|open|start|show|update|return)|bug|wrong (total|value|result|output|count)|(returns?|shows?|gives?|prints?)\s+(undefined|null|nan)|unexpected(ly)?|segfault|null pointer|TypeError|ReferenceError|NullPointerException|500 error)\b/i;

const MIN_CHARS = 12;
const MAX_CHARS = 2000;

export function looksLikeBugReport(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS) return false;
  // A slash command or an @-mention-only draft is not a description of a fault.
  if (t.startsWith('/')) return false;
  return BUG_REPORT_RE.test(t);
}
