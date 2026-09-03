/**
 * Deterministic detection of a Confluence page URL in a user message, so the
 * host can fetch the page BEFORE the model runs — same rationale and shape as
 * `detectTicketId` in `ticketDetection.ts` (see that file's doc comment).
 *
 * Kept as a pure module (no vscode import) so the headless eval harness can
 * exercise it directly.
 */

const CONFLUENCE_URL_PATTERNS: RegExp[] = [
  // https://foo.atlassian.net/wiki/spaces/KEY/pages/123456/Title
  /https?:\/\/\S*\/wiki\/spaces\/\S+\/pages\/(\d+)\S*/i,
  // https://foo.atlassian.net/wiki/pages/viewpage.action?pageId=123456
  /https?:\/\/\S*pageId=(\d+)\S*/i,
];

/**
 * The Confluence page id referenced by the message, or null when it doesn't
 * name one. Only the FIRST reference counts — same ambiguity contract as
 * `detectTicketId`: a message naming several pages is a comparison/summary
 * question, not a single page to ground the run on.
 */
export function detectConfluenceUrl(message: string): string | null {
  const text = String(message ?? '');
  let found: string | null = null;
  for (const re of CONFLUENCE_URL_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const id = m[1];
    if (found && found !== id) return null; // two different pages named — ambiguous
    found = found ?? id;
  }
  for (const re of CONFLUENCE_URL_PATTERNS) {
    const all = [...text.matchAll(new RegExp(re.source, re.flags + 'g'))].map((m) => m[1]);
    if (new Set(all).size > 1) return null;
  }
  return found;
}
