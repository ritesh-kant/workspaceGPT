/**
 * Work brief: a pre-written, on-device record of the user's own work over the
 * last year (tickets, pages, pull requests, calls), so "what did I do on X?"
 * is answered in ONE model call with no tool loop (docs/design/work-brief.md).
 *
 * Pure: no vscode, no network. fetchMyWork.ts fills the items, workBrief.ts
 * stores them and calls the model.
 *
 * Tiers (the year does not fit in one prompt as full cards):
 *  - hot:  updated in the last HOT_DAYS, or known to be open → full card, always in the prompt
 *  - warm: everything else → one line each, always in the prompt
 *  - cold: the full card of a warm item → added per question by a local lookup
 */

export type WorkSource = 'ado' | 'jira' | 'confluence' | 'pr' | 'call';

export interface WorkItem {
  /** The id the model cites, unique in the brief: "ADO #1234", "JIRA ABC-12", "PAGE 98765", "PR github acme/app#7", "CALL <id>". */
  tag: string;
  source: WorkSource;
  /** Bug, Task, Story, Page, Pull request, Call… */
  kind: string;
  title: string;
  url?: string;
  state?: string;
  /**
   * True only when the source says so (Jira status category, PR status, an
   * ADO state we recognise). It can only promote an item to a full card,
   * never hide one.
   */
  open?: boolean;
  /** How the user is involved: assigned, created, changed, contributed, authored, reviewed, attended. */
  roles: string[];
  /** Other people on the item: "Assigned to X", "Created by Y". */
  people?: string[];
  /** Epoch ms. */
  updatedAt: number;
  createdAt?: number;
  /** Project, space or repository. */
  where?: string;
  /** Plain-text detail: description, excerpt, call summary. */
  text?: string;
}

export const HOT_DAYS = 30;
/** Characters of full cards always in the prompt (~20k tokens). */
export const HOT_CHARS = 80_000;
/** Characters of one-line entries always in the prompt (~15k tokens). */
export const LINE_CHARS = 60_000;
/** Detail kept per card. */
export const CARD_TEXT_CHARS = 600;
/** Cold cards added per question. */
export const LOOKUP_LIMIT = 5;
/** Detail kept on a card added for one question (a call's transcript, a long description). */
export const DETAIL_TEXT_CHARS = 3000;
/** Earlier turns of the same conversation sent with a follow-up. */
export const HISTORY_TURNS = 6;

const DAY = 86_400_000;

const day = (ms: number | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
/** Date and time (UTC): several calls or updates on one day must still be told apart, e.g. "my last call". */
const stamp = (ms: number | undefined) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function renderCard(item: WorkItem, textChars = CARD_TEXT_CHARS): string {
  const head = [
    item.kind,
    item.state,
    item.roles.length ? `you: ${item.roles.join(', ')}` : '',
    `updated ${stamp(item.updatedAt)}`,
    item.createdAt ? `created ${stamp(item.createdAt)}` : '',
    item.where,
  ].filter(Boolean).join(' · ');
  const lines = [`[${item.tag}] ${head}`, `Title: ${oneLine(item.title)}`];
  if (item.people?.length) lines.push(item.people.join(' · '));
  const text = item.text ? oneLine(item.text) : '';
  if (text) lines.push(`Detail: ${clip(text, textChars)}`);
  return lines.join('\n');
}

export function renderLine(item: WorkItem): string {
  const meta = [item.kind, item.state, day(item.updatedAt).slice(0, 7)].filter(Boolean).join(' · ');
  const roles = item.roles.length ? ` (you: ${item.roles.join(', ')})` : '';
  return clip(`[${item.tag}] ${meta} · ${oneLine(item.title)}${roles}`, 200);
}

export interface Tiered {
  hot: WorkItem[];
  warm: WorkItem[];
  /** Items with no room even as a line; still reachable through the lookup. */
  unlisted: WorkItem[];
}

/** Newest first; a hot item that overflows the card budget becomes a line. */
export function tierItems(items: readonly WorkItem[], now = Date.now()): Tiered {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  const hot: WorkItem[] = [];
  const warm: WorkItem[] = [];
  const unlisted: WorkItem[] = [];
  let cardChars = 0;
  let lineChars = 0;
  for (const item of sorted) {
    const recent = item.updatedAt >= now - HOT_DAYS * DAY;
    if (recent || item.open) {
      const size = renderCard(item).length + 2;
      if (cardChars + size <= HOT_CHARS) {
        hot.push(item);
        cardChars += size;
        continue;
      }
    }
    const size = renderLine(item).length + 1;
    if (lineChars + size <= LINE_CHARS) {
      warm.push(item);
      lineChars += size;
    } else unlisted.push(item);
  }
  return { hot, warm, unlisted };
}

const STOP = new Set(('the and for with that this from what was were did does have has had are you your our about into over how why who when where which they them then than but not can could would should will just also its it\'s any all one two status update work worked working on in at to of a an is be by me my i we ask said tell give show '
  // Recency and request words match too much text; recency is applied by date instead.
  + 'last latest recent recently today yesterday week month summary summarize summarise').split(' '));

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [])
    .map((w) => w.replace(/[._-]+$/, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** The number a tag ends with ("ADO #1234" → "1234", "JIRA ABC-12" → "abc-12"). */
function tagKeys(tag: string): string[] {
  const keys = [tag.toLowerCase()];
  const last = tag.split(/[\s#!]/).filter(Boolean).pop();
  if (last) keys.push(last.toLowerCase());
  return keys;
}

/**
 * Full cards for items the question points at that are not already cards in
 * the prompt: an id said in the question first, then word overlap with the
 * title and detail (rarer words weigh more). It only ADDS context; nothing
 * the brief already holds is removed.
 */
export function lookupCards(question: string, items: readonly WorkItem[], exclude: ReadonlySet<string>, limit = LOOKUP_LIMIT): WorkItem[] {
  const q = question.toLowerCase();
  const qTokens = new Set(tokens(question));
  const candidates = items.filter((i) => !exclude.has(i.tag));
  if (!candidates.length) return [];
  const docs = candidates.map((item) => new Set(tokens(`${item.kind} ${item.title} ${item.where ?? ''} ${item.text ?? ''}`)));
  const df = new Map<string, number>();
  for (const doc of docs) for (const w of doc) if (qTokens.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = candidates.map((item, i) => {
    let score = 0;
    for (const key of tagKeys(item.tag)) {
      if (key.length >= 3 && new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(q)) {
        score += 100;
        break;
      }
    }
    const title = new Set(tokens(item.title));
    // The kind ("call", "page") names what the item is, not what it is about: an
    // untitled "Call on Mon…" must not outrank a newer call for "my last call".
    for (const w of tokens(item.kind)) title.delete(w);
    for (const w of qTokens) {
      if (!docs[i].has(w)) continue;
      const idf = Math.log(1 + candidates.length / (df.get(w) ?? 1));
      score += idf * (title.has(w) ? 2 : 1);
    }
    return { item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
    .slice(0, limit)
    .map((s) => s.item);
}

export interface PromptInput {
  question: string;
  items: readonly WorkItem[];
  user?: string;
  now?: number;
  builtAt?: number;
  /** What could not be read ("Jira: reconnect…"), so the model can say a source is missing. */
  notes?: string[];
  /** Earlier turns of this conversation, oldest first, for follow-ups. */
  history?: { q: string; a: string }[];
}

export interface BuiltPrompt {
  prompt: string;
  /** Every tag shown to the model; only these become source links. */
  shown: Set<string>;
}

/**
 * One prompt: the stable brief first (so a provider's prompt cache can reuse
 * it across questions), the per-question cards and the question last.
 */
export function buildAnswerPrompt(input: PromptInput): BuiltPrompt {
  const now = input.now ?? Date.now();
  const { hot, warm, unlisted } = tierItems(input.items, now);
  const shown = new Set<string>([...hot, ...warm].map((i) => i.tag));
  const history = (input.history ?? []).slice(-HISTORY_TURNS);
  // A follow-up ("and the second one?") names its subject in the turn before.
  const lookupText = [history[history.length - 1]?.q ?? '', input.question].join(' ');
  // Hot items can be looked up too: their detail card carries far more text than the summary card.
  const extra = lookupCards(lookupText, input.items, new Set());
  for (const item of extra) shown.add(item.tag);
  const parts = [
    `You are ${input.user ? `${input.user}'s` : "the user's"} work memory. They may be in a meeting and need an answer they can say out loud right now.`,
    '',
    'Rules:',
    '- Answer ONLY from the WORK BRIEF below. If it does not contain the answer, reply exactly "Not in your brief." followed by one short line on what to look up.',
    // Read at a glance mid-call: the answer first, then only the specifics worth saying.
    '- Be brief and to the point. First line: the direct answer in bold, under 12 words, e.g. "**It is in review, waiting on QA.**"',
    '- Then, only if it adds something the user would say, up to 3 bullets starting "- ", each under 12 words: the specifics (ids, numbers, names, dates). No filler, no restating the question.',
    '- First person, as the user would say it ("I fixed…", "We agreed…"). No other markdown: no headings, tables or links.',
    '- Cite every item you use by its bracketed id at the end, copied exactly as written in the brief, e.g. [ADO #1234] [PAGE 5521] [PR github org/repo#42].',
    '- Never invent statuses, dates, numbers, names or links. Prefer the newest item when two disagree.',
    '- In a follow-up, use the earlier conversation only to understand what the question refers to; facts still come only from the brief.',
    // Models misjudge "last two weeks" against bare dates; give them the cut-offs.
    `- Check every date against today before calling something recent or old. Last 7 days = on or after ${day(now - 7 * DAY)}; last 14 days = on or after ${day(now - 14 * DAY)}; last 30 days = on or after ${day(now - 30 * DAY)}.`,
    '',
    `Today: ${day(now)} (${new Date(now).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}).${input.builtAt ? ` Brief built: ${new Date(input.builtAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : ''}`,
    ...(input.notes?.length ? ['Sources not read in this brief: ' + input.notes.join(' | ')] : []),
    '',
    `=== WORK BRIEF: RECENT AND OPEN (${hot.length}) ===`,
    ...hot.map(renderCard).join('\n\n').split('\n'),
    '',
    `=== WORK BRIEF: EARLIER THIS YEAR (${warm.length}${unlisted.length ? `, ${unlisted.length} older not listed` : ''}) ===`,
    ...warm.map(renderLine),
  ];
  if (extra.length) {
    parts.push('', '=== DETAIL FOR THIS QUESTION ===', extra.map((i) => renderCard(i, DETAIL_TEXT_CHARS)).join('\n\n'));
  }
  if (history.length) {
    parts.push('', '=== EARLIER IN THIS CONVERSATION ===', ...history.map((t) => `Q: ${oneLine(t.q)}\nA: ${oneLine(t.a)}`));
  }
  parts.push('', `Question: ${input.question.trim()}`);
  return { prompt: parts.join('\n'), shown };
}

export interface AnswerSource {
  tag: string;
  /** Short name for a chip: "#1234", "PAY-77", "app#42", "Call · 16 Nov 18:26", a page title. */
  label: string;
  title: string;
  source: WorkSource;
  url?: string;
}

export function sourceLabel(item: WorkItem): string {
  const last = item.tag.split(' ').slice(1).join(' ');
  switch (item.source) {
    case 'ado': return last;
    case 'jira': return last;
    case 'pr': return last.startsWith('github ') ? last.slice(7).split('/').pop()! : last.replace(/^ado/, 'PR ');
    case 'call': {
      const at = new Date(item.createdAt ?? item.updatedAt);
      return `Call · ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${at.toTimeString().slice(0, 5)}`;
    }
    default: return clip(oneLine(item.title), 40);
  }
}

/** Links only for ids the answer cites AND the prompt showed; a made-up id gets no link. */
const CITE = /\[([^\]\n]{3,80})\]/g;

/** The shown item a bracket in the answer names, or undefined for a made-up id. */
function resolveTag(raw: string, byTag: ReadonlyMap<string, WorkItem>, shown: ReadonlySet<string>): WorkItem | undefined {
  let tag = raw.trim();
  if (!byTag.has(tag)) {
    // Models shorten long ids ("PR #12610" for "PR github org/repo#12610"):
    // link the one shown item that ends with the same id, never a guess between several.
    const tail = tag.split(/\s+/).pop()!.toLowerCase();
    const hits = tail.length >= 3 ? [...shown].filter((t) => {
      const lower = t.toLowerCase();
      if (lower === tail) return true;
      // The id must start at a separator: "#12610" or "12610" matches "…app#12610", "610" does not.
      return lower.endsWith(tail) && (/^[#!/]/.test(tail) || /[\s#!/]/.test(lower.charAt(lower.length - tail.length - 1)));
    }) : [];
    if (hits.length === 1) tag = hits[0];
  }
  return shown.has(tag) ? byTag.get(tag) : undefined;
}

/** Links only for ids the answer cites AND the prompt showed; a made-up id gets no link. */
export function citedSources(answer: string, items: readonly WorkItem[], shown: ReadonlySet<string>): AnswerSource[] {
  const byTag = new Map(items.map((i) => [i.tag, i]));
  const out: AnswerSource[] = [];
  for (const m of answer.matchAll(CITE)) {
    const item = resolveTag(m[1], byTag, shown);
    if (!item || out.some((s) => s.tag === item.tag)) continue;
    out.push({ tag: item.tag, label: sourceLabel(item), title: item.title, source: item.source, ...(item.url ? { url: item.url } : {}) });
  }
  return out;
}

/**
 * The answer as text and citation markers, for display: a bracket that names
 * a shown item becomes its index in `sources`; any other bracket is dropped.
 */
export function answerParts(answer: string, items: readonly WorkItem[], shown: ReadonlySet<string>, sources: readonly AnswerSource[]): Array<string | number> {
  const byTag = new Map(items.map((i) => [i.tag, i]));
  const parts: Array<string | number> = [];
  let at = 0;
  for (const m of answer.matchAll(CITE)) {
    const before = answer.slice(at, m.index).replace(/[ \t]+$/, '');
    if (before) parts.push(before);
    at = m.index! + m[0].length;
    const item = resolveTag(m[1], byTag, shown);
    const index = item ? sources.findIndex((s) => s.tag === item.tag) : -1;
    if (index >= 0 && parts[parts.length - 1] !== index) parts.push(index);
  }
  const rest = answer.slice(at);
  if (rest.trim()) parts.push(rest);
  return parts;
}

/** The answer without its citation brackets or markdown, for reading aloud. */
export function speakable(answer: string): string {
  return answer
    .replace(/\s*\[[^\]\n]{3,80}\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

/** Drop duplicates by tag, newest wins. */
export function dedupe(items: readonly WorkItem[]): WorkItem[] {
  const map = new Map<string, WorkItem>();
  for (const item of items) {
    const prev = map.get(item.tag);
    if (!prev) map.set(item.tag, item);
    else if (item.updatedAt >= prev.updatedAt) map.set(item.tag, { ...item, roles: [...new Set([...prev.roles, ...item.roles])] });
    else map.set(item.tag, { ...prev, roles: [...new Set([...prev.roles, ...item.roles])] });
  }
  return [...map.values()];
}
