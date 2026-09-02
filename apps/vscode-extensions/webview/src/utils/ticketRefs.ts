/**
 * Azure DevOps work-item references in chat text.
 *
 * The agent cites tickets as `#1516750` in prose (the FINAL REPORT FORMAT asks
 * for it). Turning those into links is what lets a reader open the ticket the
 * run was grounded in without going hunting in Azure DevOps — the same
 * affordance `parseFileRef` gives file citations.
 */

/** Same shape the host falls back to when the API omits `_links.html.href`. */
export function adoWorkItemUrl(orgName: string, projectName: string, id: string | number): string | null {
  if (!orgName || !projectName) return null;
  return `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(
    projectName
  )}/_workitems/edit/${encodeURIComponent(String(id))}`;
}

/**
 * Work-item ids are 4+ digits so ordinary "#3" list references and CSS colors
 * never match. A preceding word character or backtick disqualifies the match
 * (`x#1234`, `` `#1234` `` inside a longer span), and a `#` run is required to
 * be single so a `## 1516750` heading cannot be caught.
 */
const TICKET_ID_RE = /(^|[^\w`#])#(\d{4,})\b/g;

/**
 * Spans linkification must not touch: fenced code blocks and inline code (a
 * `#1516750` inside a command or a diff stays literal), plus anything already
 * a link — a markdown link, an autolink, or a bare URL. Without that last
 * group an id the model already linked itself gets wrapped twice and renders
 * as `[[#1516750](url)](url)`.
 */
const SKIP_SEGMENT_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>|\bhttps?:\/\/\S+/g;

/**
 * Rewrite `#<id>` into a markdown link, outside code only. `urlFor` returns
 * null when the workspace has no Azure DevOps org/project configured, in which
 * case the text is left exactly as the model wrote it.
 */
export function linkifyTicketIds(markdown: string, urlFor: (id: string) => string | null): string {
  const text = String(markdown ?? '');
  if (!text.includes('#')) return text;

  const linkifySegment = (segment: string): string =>
    segment.replace(TICKET_ID_RE, (match, prefix: string, id: string) => {
      const url = urlFor(id);
      return url ? `${prefix}[#${id}](${url})` : match;
    });

  let out = '';
  let cursor = 0;
  for (const skip of text.matchAll(SKIP_SEGMENT_RE)) {
    const start = skip.index ?? 0;
    if (start < cursor) continue; // overlapping match (a URL inside a link) — already emitted
    out += linkifySegment(text.slice(cursor, start)) + skip[0];
    cursor = start + skip[0].length;
  }
  return out + linkifySegment(text.slice(cursor));
}
