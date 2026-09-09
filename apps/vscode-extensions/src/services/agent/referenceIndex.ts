/**
 * Provenance for the ids a run actually saw.
 *
 * An answer is prose, so every `#12359` in it has to be turned back into a
 * link by pattern-matching the sentence it sits in — and `#12359` is a pull
 * request in a commit subject and a work item three words later. No pattern
 * can tell those apart, because the distinguishing fact is not in the text:
 * it is in where the id CAME FROM, which the run knew and then threw away.
 *
 * So keep it. Every tool result that carries ids is passed through
 * {@link collectRefs} as it comes back, and the resulting table travels with
 * the message (on its turn summary) to the renderer, which resolves ids by
 * lookup instead of guessing.
 *
 * Two rules keep the table trustworthy:
 *
 *  - A ref is only recorded with the kind its SOURCE gives it — a work item
 *    because an Azure DevOps tool returned it as one, a pull request because
 *    it appears where a merge convention puts one. Nothing here infers a kind
 *    from the shape of a number.
 *  - The table OVERRIDES the renderer's default, it does not gate it. An id
 *    the run never saw still gets the default (work-item) reading, so ids
 *    quoted inside a ticket's own description keep working.
 *
 * The same table is what a later honesty gate needs to spot an id in an answer
 * that no tool in the run ever returned.
 */

/** What an id refers to. `commit` is recorded for provenance; nothing links it (hashes are cited in code spans). */
export type RefKind = 'work-item' | 'pull-request' | 'commit';

export interface RunRef {
  /** The id as it appears in prose, without any `#`: '1384667', '12359', '6d5ba9b81b3'. */
  id: string;
  kind: RefKind;
  /** Canonical URL when the source supplied one; otherwise the renderer builds it from the kind. */
  url?: string;
  /** Short label for the link's hover title. */
  label?: string;
}

/** Belt on the payload: a 20-commit log plus a ticket search is ~50 refs, so this only stops pathological runs. */
const MAX_REFS = 250;

/**
 * Pull-request references, by the merge conventions of the hosting providers —
 * GitHub/GitLab squash (`… (#12359)`), GitHub merge commits (`Merge pull
 * request #123 from …`) and Azure Repos (`Merged PR 12345: …`). These are
 * conventions of the PROVIDER, not of any one repository, which is what keeps
 * this out of guessing-by-shape territory.
 */
const PR_PATTERNS: RegExp[] = [
  /\(#(\d+)\)/g,
  /\bMerge(?:d)? pull request #(\d+)\b/gi,
  /\bMerged PR (\d+)\b/gi,
];

/** `git log --format=%h …` and `git blame` both put the abbreviated hash first on the line. */
const LEADING_HASH_RE = /^\^?([0-9a-f]{7,40})\b/;

/** Azure DevOps work-item urls, for lifting the id back out of a search hit. */
const ADO_URL_ID_RE = /_workitems\/edit\/(\d+)|_apis\/wit\/workItems\/(\d+)/i;
/** The ADO index names each item `ADO-<id>` (see adoWorker). */
const ADO_FILENAME_ID_RE = /\bADO-(\d+)\b/;

/** Text of a tool result, whatever shape the tool returns it in. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const asRecord = result as { text?: unknown; output?: unknown; content?: unknown };
    for (const candidate of [asRecord.text, asRecord.output, asRecord.content]) {
      if (typeof candidate === 'string') return candidate;
    }
  }
  return '';
}

/** Commits and pull requests out of `git log` / `git blame` output. */
function refsFromGitOutput(text: string, prUrlTemplate?: string): RunRef[] {
  const refs: RunRef[] = [];
  for (const line of text.split('\n')) {
    const hash = LEADING_HASH_RE.exec(line);
    // A short hash is hex-only, so a line opening with a decimal id is not one.
    if (hash && /[a-f]/.test(hash[1])) refs.push({ id: hash[1], kind: 'commit' });
    for (const pattern of PR_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of line.matchAll(pattern)) {
        refs.push({
          id: m[1],
          kind: 'pull-request',
          url: prUrlTemplate?.replace('{id}', encodeURIComponent(m[1])),
          label: line.slice(0, 120).trim(),
        });
      }
    }
  }
  return refs;
}

/** A work item the Azure DevOps API returned in full — the strongest provenance there is. */
export function refsFromTicket(ticket: {
  id?: number | string;
  title?: string;
  url?: string;
  parentId?: number | string;
} | null | undefined): RunRef[] {
  if (!ticket?.id) return [];
  const refs: RunRef[] = [{ id: String(ticket.id), kind: 'work-item', url: ticket.url, label: ticket.title }];
  // A parent named by the API is a real id the run learned; it has no url of
  // its own here, so the renderer's work-item url covers it.
  if (ticket.parentId) refs.push({ id: String(ticket.parentId), kind: 'work-item' });
  return refs;
}

/** Work items out of a `search_tickets` result — the id lives in the ADO url, or in the `ADO-<id>` item name. */
function refsFromTicketSearch(result: unknown): RunRef[] {
  const rows = (result as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return [];
  const refs: RunRef[] = [];
  for (const row of rows) {
    const { url, title, source } = (row ?? {}) as { url?: string; title?: string; source?: string };
    const fromUrl = url ? ADO_URL_ID_RE.exec(url) : null;
    const id =
      fromUrl?.[1] ??
      fromUrl?.[2] ??
      ADO_FILENAME_ID_RE.exec(`${title ?? ''} ${source ?? ''}`)?.[1];
    if (id) refs.push({ id, kind: 'work-item', url, label: title });
  }
  return refs;
}

/**
 * Refs a tool result carries. Tools not listed contribute nothing — silence is
 * the right answer for a tool whose output has no id provenance in it, since a
 * missing ref falls back to the default reading rather than losing its link.
 */
export function collectRefs(
  toolName: string,
  result: unknown,
  opts: { prUrlTemplate?: string } = {}
): RunRef[] {
  switch (toolName) {
    case 'git_log':
    case 'git_blame':
      return refsFromGitOutput(resultText(result), opts.prUrlTemplate);
    case 'get_ticket':
      return refsFromTicket(result as Parameters<typeof refsFromTicket>[0]);
    case 'search_tickets':
      return refsFromTicketSearch(result);
    default:
      return [];
  }
}

/**
 * Adds `incoming` to `table` in place, first-writer-wins per (kind, id) so an
 * earlier ref's url/label is never dropped for a later bare one, and capped.
 */
export function mergeRefs(table: RunRef[], incoming: RunRef[]): void {
  for (const ref of incoming) {
    if (table.length >= MAX_REFS) return;
    if (table.some((existing) => existing.id === ref.id && existing.kind === ref.kind)) continue;
    table.push(ref);
  }
}
