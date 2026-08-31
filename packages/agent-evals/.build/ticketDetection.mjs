// ../../apps/vscode-extensions/src/utils/ticketDetection.ts
var TICKET_REF_PATTERNS = [
  // "ticket 1324128", "work item #4521", "bug 1234", "story 987654"
  /\b(?:ticket|work\s*item|bug|story|task|issue)\s*#?\s*(\d{3,9})\b/i,
  // Org-prefixed conventions: "TKT-1234", "D2C-987654" (prefix case-sensitive
  // on purpose — "e-123" in prose must not match)
  /\b[A-Z]{2,10}-(\d{3,9})\b/,
  // Bare "#1234" at a word boundary
  /(?:^|[\s(])#(\d{3,9})\b/
];
function detectTicketId(message) {
  const text = String(message ?? "");
  let found = null;
  for (const re of TICKET_REF_PATTERNS) {
    const m = re.exec(text);
    if (!m)
      continue;
    const id = m[1];
    if (found && found !== id)
      return null;
    found = found ?? id;
  }
  for (const re of TICKET_REF_PATTERNS) {
    const all = [...text.matchAll(new RegExp(re.source, re.flags + "g"))].map((m) => m[1]);
    if (new Set(all).size > 1)
      return null;
  }
  return found;
}
export {
  detectTicketId
};
