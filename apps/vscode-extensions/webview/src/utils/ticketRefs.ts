/**
 * `#<id>` references in chat text.
 *
 * The agent cites tickets as `#1516750` in prose (the FINAL REPORT FORMAT asks
 * for it). Turning those into links is what lets a reader open the ticket the
 * run was grounded in without going hunting in Azure DevOps — the same
 * affordance `parseFileRef` gives file citations.
 *
 * Two id namespaces share that syntax: a work item and a pull request are both
 * `#12359`, and nothing in the sentence separates them. So the reading is NOT
 * inferred here — the run records what each id it saw refers to (host:
 * services/agent/referenceIndex.ts) and that table arrives on the message's
 * turn summary. The table OVERRIDES the default work-item reading for the ids
 * it knows; anything it has never heard of keeps that default, so an id quoted
 * inside a ticket's own description still links.
 */

import type { RunRef } from '../store/chatStore';

/** Same shape the host falls back to when the API omits `_links.html.href`. */
export function adoWorkItemUrl(orgName: string, projectName: string, id: string | number): string | null {
  if (!orgName || !projectName) return null;
  return `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(
    projectName
  )}/_workitems/edit/${encodeURIComponent(String(id))}`;
}

/** `{id}` in the host's `origin`-derived template → the PR's page on the hosting provider. */
export function pullRequestUrl(template: string | undefined, id: string | number): string | null {
  if (!template) return null;
  return template.replace('{id}', encodeURIComponent(String(id)));
}

/**
 * Either kind of reference. Work-item ids are 4+ digits so ordinary "#3" list
 * references and CSS colors never match; an explicit `PR #<id>` has no digit
 * floor, since PR numbers start at 1. A preceding word character or backtick
 * disqualifies the match (`x#1234`, `` `#1234` `` inside a longer span), and a
 * `#` run is required to be single so a `## 1516750` heading cannot be caught.
 */
const TICKET_ID_RE = /(^|[^\w`#])(?:(?:PR|pull request)\s*#(\d+)|#(\d{4,}))\b/gi;

/**
 * Spans linkification must not touch: fenced code blocks and inline code (a
 * `#1516750` inside a command or a diff stays literal), plus anything already
 * a link — a markdown link, an autolink, or a bare URL. Without that last
 * group an id the model already linked itself gets wrapped twice and renders
 * as `[[#1516750](url)](url)`.
 */
const SKIP_SEGMENT_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>|\bhttps?:\/\/\S+/g;

/** How to link each kind of reference, and what the fallback is for an id with no provenance. */
export interface RefResolver {
  workItemUrl: (id: string) => string | null;
  pullRequestUrl: (id: string) => string | null;
  /** The run's reference table, from the message's turn summary. Absent → every id takes the default reading. */
  refs?: RunRef[];
}

/**
 * The kind to render `id` as: what the run recorded, else work-item.
 *
 * An id the table holds under two kinds means the run saw both a PR and a work
 * item with that number. `marked` (the text said "PR") decides it; otherwise
 * the default wins, since prose overwhelmingly means the ticket.
 */
function resolve(id: string, marked: boolean, resolver: RefResolver): { url: string | null; title?: string } {
  const known = resolver.refs?.filter((ref) => ref.id === id) ?? [];
  const kind = marked
    ? 'pull-request'
    : known.length === 1
      ? known[0].kind
      : known.some((ref) => ref.kind === 'work-item')
        ? 'work-item'
        : (known[0]?.kind ?? 'work-item');
  const recorded = known.find((ref) => ref.kind === kind);
  if (kind === 'commit') return { url: null }; // hashes are cited in code spans; nothing to link
  const url =
    recorded?.url ?? (kind === 'pull-request' ? resolver.pullRequestUrl(id) : resolver.workItemUrl(id));
  return { url, title: recorded?.label };
}

/**
 * Rewrite `#<id>` into a markdown link, outside code only. A `null` url — no
 * Azure DevOps org/project configured, or an `origin` remote on a host with no
 * known PR url shape — leaves the text exactly as the model wrote it.
 */
export function linkifyTicketIds(markdown: string, resolver: RefResolver): string {
  const text = String(markdown ?? '');
  if (!text.includes('#')) return text;

  const linkifySegment = (segment: string): string =>
    segment.replace(TICKET_ID_RE, (match, prefix: string, prId?: string, ticketId?: string) => {
      const id = prId ?? ticketId ?? '';
      const { url, title } = resolve(id, !!prId, resolver);
      if (!url) return match;
      const label = title ? ` "${title.replace(/"/g, '')}"` : '';
      return `${prefix}[#${id}](${url}${label})`;
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
