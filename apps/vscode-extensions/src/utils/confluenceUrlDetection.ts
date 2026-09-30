/**
 * Deterministic detection of Confluence page URLs in a user message, so the
 * host can fetch the pages BEFORE the model runs — same rationale and shape as
 * `detectTicketId` in `ticketDetection.ts` (see that file's doc comment).
 *
 * Kept as a pure module (no vscode import) so the headless eval harness can
 * exercise it directly.
 */

const CONFLUENCE_URL_PATTERNS: RegExp[] = [
  // https://foo.atlassian.net/wiki/spaces/KEY/pages/123456/Title
  // https://foo.atlassian.net/wiki/spaces/KEY/pages/edit-v2/123456?draftShareId=…
  /https?:\/\/\S*\/wiki\/spaces\/\S+?\/pages\/(?:[a-z][a-z0-9-]*\/)?(\d+)\S*/gi,
  // https://foo.atlassian.net/wiki/pages/viewpage.action?pageId=123456
  /https?:\/\/\S*pageId=(\d+)\S*/gi,
];

/** At most this many linked pages are pre-fetched; the rest the model reads itself. */
const MAX_LINKED_PAGES = 3;

/**
 * The distinct Confluence page ids the message links, in the order they
 * appear. Every linked page is reference material ("convert page A into page
 * B's format" needs both), so none is dropped for being one of several.
 */
export function detectConfluenceUrls(message: string): string[] {
  const text = String(message ?? '');
  const hits: { index: number; id: string }[] = [];
  for (const re of CONFLUENCE_URL_PATTERNS) {
    for (const m of text.matchAll(re)) hits.push({ index: m.index ?? 0, id: m[1] });
  }
  hits.sort((a, b) => a.index - b.index);
  return [...new Set(hits.map((h) => h.id))].slice(0, MAX_LINKED_PAGES);
}
