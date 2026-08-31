/**
 * Deterministic detection of a work-item reference in a user message, so the
 * host can fetch the ticket BEFORE the model runs (see TICKET-ENTRY-POINT-
 * DESIGN.md §3 and the exploration phase's groundingText). The seeded "Work on
 * ticket 1234 (…)" prompt from the My Work panel matches the first pattern;
 * the others cover how people type ticket references by hand.
 *
 * Kept as a pure module (no vscode import) so the headless eval harness can
 * exercise it directly.
 */

const TICKET_REF_PATTERNS: RegExp[] = [
  // "ticket 1324128", "work item #4521", "bug 1234", "story 987654"
  /\b(?:ticket|work\s*item|bug|story|task|issue)\s*#?\s*(\d{3,9})\b/i,
  // Org-prefixed conventions: "TKT-1234", "D2C-987654" (prefix case-sensitive
  // on purpose — "e-123" in prose must not match)
  /\b[A-Z]{2,10}-(\d{3,9})\b/,
  // Bare "#1234" at a word boundary
  /(?:^|[\s(])#(\d{3,9})\b/,
];

/**
 * The work-item ID referenced by the message, or null when it doesn't name
 * one. Only the FIRST reference counts — a message naming several tickets is
 * a comparison/summary question, and pre-fetching one of them would ground
 * the run on an arbitrary pick.
 */
export function detectTicketId(message: string): string | null {
  const text = String(message ?? '');
  let found: string | null = null;
  for (const re of TICKET_REF_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const id = m[1];
    if (found && found !== id) return null; // two different tickets named — ambiguous
    found = found ?? id;
  }
  // A second distinct ID under the SAME pattern also means ambiguity.
  for (const re of TICKET_REF_PATTERNS) {
    const all = [...text.matchAll(new RegExp(re.source, re.flags + 'g'))].map((m) => m[1]);
    if (new Set(all).size > 1) return null;
  }
  return found;
}
