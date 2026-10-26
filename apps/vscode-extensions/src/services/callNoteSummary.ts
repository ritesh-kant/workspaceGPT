/**
 * What a call note is for: a short summary, its decisions, and the action items
 * it left (docs/design/call-notes.md). One JSON file beside the transcript,
 * `call-notes/<id>.summary.json`, written once the call has ended. It is never
 * part of the transcript file, so the recorder and the Sessions panel (which
 * only list `*.md`) are untouched; deleting a note deletes this too.
 *
 * The model reads the transcript on this machine's configured chat model and
 * returns JSON; nothing here decides what was said, it only checks that what
 * the model reports is grounded (a ticket id must appear in the transcript).
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { CallNote, CallNoteSummary, formatOffset, listCallNotes, readCallNote, renameCallNote } from './callNotes';

/** `unclear`: the call did not say who; the panel offers it to the user as a suggestion, never as their task. */
export type ActionOwner = 'you' | 'other' | 'unclear';
/** `mine`: the user confirmed a suggested item is theirs (it becomes `open`, owner `you`). */
export type ActionState = 'open' | 'done' | 'dismissed' | 'mine';

export interface CallAction {
  id: string;
  text: string;
  owner: ActionOwner;
  /** Who, when the model named someone other than the user. */
  who?: string;
  due?: string;
  /** `due` as a calendar date (YYYY-MM-DD), when the call named a day. */
  dueDate?: string;
  /** Seconds into the call, so a click can show the moment. */
  at?: number;
  /** A tracker id the transcript names for this item. */
  ticket?: string;
  state?: ActionState;
}

export interface CallSummaryDoc {
  v: 1;
  /** `skipped`: too little was said to be worth a summary; not retried. */
  status: 'done' | 'skipped';
  generatedAt: number;
  tldr?: string;
  /** What matters from this call, a few short lines. */
  highlights?: string[];
  decisions: string[];
  actions: CallAction[];
  topics: string[];
}

export interface PendingAction extends CallAction {
  noteId: string;
  noteTitle: string;
  startedAt: number;
}

export interface CallHighlight {
  text: string;
  noteId: string;
  noteTitle: string;
  startedAt: number;
}

export interface LatestCallSummary {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  tldr: string;
}

const SUFFIX = '.summary.json';
/** Turns and words below which a call is noise or a dropped connection, not a conversation. */
const MIN_TURNS = 4;
const MIN_WORDS = 60;
/** Characters of transcript sent to the model: head and tail are kept past this. */
const MAX_TRANSCRIPT_CHARS = 40_000;
const DEFAULT_TITLE = /^Call on /;
const CLOSED_STATE = /^(closed|done|resolved|removed|completed|cancell?ed)$/i;
const STATE_TTL_MS = 5 * 60_000;

export type Complete = (prompt: string) => Promise<string>;
/** A tracker item's state ("Active", "Closed"), or undefined when it cannot be read. */
export type TicketState = (id: string) => Promise<string | undefined>;

const summaryFile = (dir: string, id: string) => path.join(dir, `${id}${SUFFIX}`);

export async function readCallSummary(dir: string, id: string): Promise<CallSummaryDoc | undefined> {
  try {
    const doc = JSON.parse(await fsp.readFile(summaryFile(dir, id), 'utf8')) as CallSummaryDoc;
    return doc?.v === 1 ? doc : undefined;
  } catch {
    return undefined;
  }
}

async function writeCallSummary(dir: string, id: string, doc: CallSummaryDoc): Promise<void> {
  const file = summaryFile(dir, id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

export async function deleteCallSummary(dir: string, id: string): Promise<void> {
  await fsp.unlink(summaryFile(dir, id)).catch(() => undefined);
}

function transcriptOf(note: CallNote): string {
  const lines = [...note.turns].sort((a, b) => a.at - b.at).map((t) => `[${formatOffset(t.at)}] ${t.speaker === 'you' ? 'You' : 'Others'}: ${t.text}`);
  const text = lines.join('\n');
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const half = MAX_TRANSCRIPT_CHARS / 2;
  return `${text.slice(0, half)}\n[… the middle of the call is omitted …]\n${text.slice(-half)}`;
}

export function buildSummaryPrompt(note: CallNote): string {
  return `Below is the automatic transcript of a work call. "You" is the person who owns these notes (their microphone); "Others" is everyone else on the call, not told apart. The transcript is machine-made: words may be wrong, and lines can be doubled or garbled.

Write notes the owner can act on without reading the transcript. Use only what was said; do not invent decisions, owners, dates or ticket numbers. If something is unclear, leave it out.

Return one JSON object and nothing else (no markdown):
{
  "title": "4-8 words naming what the call was about",
  "tldr": "2-3 sentences: what was discussed and where it ended up",
  "highlights": ["up to 3 things that matter most, each under 14 words, each a fact or a decision from the call"],
  "decisions": ["a decision that was made, one sentence each"],
  "actions": [
    {"text": "what has to be done, starting with a verb", "owner": "you" or "other" or "unclear", "who": "name if owner is other and a name was said, else empty", "due": "when, if said, else empty", "dueDate": "that day as YYYY-MM-DD, worked out from the call date above, else empty", "at": "mm:ss of the line where it was agreed", "ticket": "a ticket or work item number if one was named for this, else empty"}
  ],
  "topics": ["up to 4 short topics"]
}
"owner" is "you" only when "You" took it on, or Others asked "You" to do it; "other" when someone else took it; "unclear" when it was agreed but not who owns it. Empty arrays are fine. If there is no real conversation (noise, a test, one person talking to themselves), return {"empty": true}.

Call date: ${new Date(note.startedAt).toDateString()} (${new Date(note.startedAt).toISOString().slice(0, 10)}).

Transcript:
${transcriptOf(note)}`;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v: unknown, max: number, each: number): string[] =>
  (Array.isArray(v) ? v : []).map((s) => text(s, each)).filter(Boolean).slice(0, max);

function parseOffset(v: unknown): number | undefined {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** The model's JSON, tolerant of fences and chatter around it; undefined when there is none. */
export function parseSummaryReply(raw: string, note: CallNote): { title?: string; doc: Omit<CallSummaryDoc, 'v' | 'status' | 'generatedAt'> } | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let json: any;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object' || json.empty === true) return undefined;
  const spoken = note.turns.map((t) => t.text).join(' ');
  const actions: CallAction[] = (Array.isArray(json.actions) ? json.actions : [])
    .map((a: any): CallAction | undefined => {
      const body = text(a?.text, 240);
      if (!body) return undefined;
      const ticket = text(a?.ticket, 40).replace(/^#/, '');
      const who = text(a?.who, 60);
      const due = text(a?.due, 60);
      const at = parseOffset(a?.at);
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(text(a?.dueDate, 10)) ? text(a?.dueDate, 10) : '';
      return {
        id: '',
        text: body,
        owner: a?.owner === 'you' ? 'you' : a?.owner === 'unclear' ? 'unclear' : 'other',
        ...(who ? { who } : {}),
        ...(due ? { due } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(at !== undefined ? { at } : {}),
        // A ticket the transcript never says is the model's invention: it must not drive auto-resolve.
        ...(ticket && spoken.includes(ticket) ? { ticket } : {}),
      };
    })
    .filter((a: CallAction | undefined): a is CallAction => !!a)
    .slice(0, 12)
    .map((a: CallAction, i: number) => ({ ...a, id: `a${i + 1}` }));
  const tldr = text(json.tldr, 600);
  if (!tldr && !actions.length) return undefined;
  const title = text(json.title, 90);
  return { ...(title ? { title } : {}), doc: { tldr, highlights: list(json.highlights, 3, 140), decisions: list(json.decisions, 8, 240), actions, topics: list(json.topics, 4, 40) } };
}

const inFlight = new Set<string>();

/**
 * Summarizes one finished call. Resolves to the saved doc, or undefined when a
 * summary is already being made or the call is still on. Throws what the model
 * call throws (no model chosen, rate limit): nothing is saved, so a later try
 * starts clean.
 */
export async function summarizeCallNote(dir: string, id: string, complete: Complete, opts: { force?: boolean } = {}): Promise<CallSummaryDoc | undefined> {
  if (inFlight.has(id)) return undefined;
  const note = await readCallNote(dir, id);
  if (!note || note.status !== 'done') return undefined;
  const existing = await readCallSummary(dir, id);
  if (existing && !opts.force) return existing;
  const words = note.turns.reduce((n, t) => n + t.text.split(/\s+/).filter(Boolean).length, 0);
  if (note.turns.length < MIN_TURNS || words < MIN_WORDS) {
    const skipped: CallSummaryDoc = { v: 1, status: 'skipped', generatedAt: Date.now(), decisions: [], actions: [], topics: [] };
    await writeCallSummary(dir, id, skipped);
    return skipped;
  }
  inFlight.add(id);
  try {
    const parsed = parseSummaryReply(await complete(buildSummaryPrompt(note)), note);
    const doc: CallSummaryDoc = parsed
      ? { v: 1, status: 'done', generatedAt: Date.now(), ...parsed.doc }
      : { v: 1, status: 'skipped', generatedAt: Date.now(), decisions: [], actions: [], topics: [] };
    await writeCallSummary(dir, id, doc);
    // The user's own title wins: only the default "Call on …" is replaced.
    if (parsed?.title && DEFAULT_TITLE.test(note.title)) await renameCallNote(dir, id, parsed.title);
    return doc;
  } finally {
    inFlight.delete(id);
  }
}

export const isSummarizing = (id: string): boolean => inFlight.has(id);

/** Finished calls within `days` that have no summary yet, newest first. */
export async function notesNeedingSummary(dir: string, days: number): Promise<CallNoteSummary[]> {
  const since = Date.now() - days * 86_400_000;
  const notes = (await listCallNotes(dir)).filter((n) => n.status === 'done' && n.startedAt >= since);
  const missing: CallNoteSummary[] = [];
  for (const n of notes) if (!(await readCallSummary(dir, n.id))) missing.push(n);
  return missing;
}

export async function setActionState(dir: string, id: string, actionId: string, state: ActionState): Promise<boolean> {
  const doc = await readCallSummary(dir, id);
  const action = doc?.actions.find((a) => a.id === actionId);
  if (!doc || !action) return false;
  if (state === 'mine') {
    action.owner = 'you';
    delete action.state;
  } else if (state === 'open') delete action.state;
  else action.state = state;
  await writeCallSummary(dir, id, doc);
  return true;
}

const stateCache = new Map<string, { at: number; state: string }>();

const MAX_HIGHLIGHTS = 3;

export interface OpenActions {
  actions: PendingAction[];
  /** Agreed on a call but not clearly the user's: offered, never counted as theirs. */
  suggested: PendingAction[];
  highlights: CallHighlight[];
  /** Summarized calls in the window, and when the newest started. */
  calls: number;
  newest?: number;
  latest?: LatestCallSummary;
}

/**
 * The user's open action items from calls in the last `days`, newest call
 * first. An item whose ticket is now closed in the tracker is not open any
 * more; when the tracker cannot say, it stays.
 */
export async function listOpenActions(dir: string, days: number, ticketState?: TicketState): Promise<OpenActions> {
  const since = Date.now() - days * 86_400_000;
  const notes = (await listCallNotes(dir)).filter((n) => n.status === 'done' && n.startedAt >= since);
  const actions: PendingAction[] = [];
  const suggested: PendingAction[] = [];
  const highlights: CallHighlight[] = [];
  let latest: LatestCallSummary | undefined;
  let calls = 0;
  for (const n of notes) {
    const doc = await readCallSummary(dir, n.id);
    if (doc?.status !== 'done') continue;
    calls++;
    if (!latest && doc.tldr) latest = { id: n.id, title: n.title, startedAt: n.startedAt, ...(n.endedAt ? { endedAt: n.endedAt } : {}), tldr: doc.tldr };
    // Two from a call at most, so one long call does not fill the list.
    for (const text of (doc.highlights ?? []).slice(0, 2)) {
      if (highlights.length < MAX_HIGHLIGHTS) highlights.push({ text, noteId: n.id, noteTitle: n.title, startedAt: n.startedAt });
    }
    for (const a of doc.actions) {
      if (a.state) continue;
      const item = { ...a, noteId: n.id, noteTitle: n.title, startedAt: n.startedAt };
      if (a.owner === 'you') actions.push(item);
      else if (a.owner === 'unclear') suggested.push(item);
    }
  }
  const base = { suggested, highlights, calls, ...(notes.length ? { newest: notes[0].startedAt } : {}), latest };
  if (!ticketState) return { actions, ...base };
  const open = await Promise.all(
    actions.map(async (a) => {
      if (!a.ticket) return a;
      const hit = stateCache.get(a.ticket);
      let state: string | undefined;
      if (hit && Date.now() - hit.at < STATE_TTL_MS) state = hit.state;
      else {
        state = await ticketState(a.ticket).catch(() => undefined);
        // Only what the tracker said is remembered: an unreadable ticket is asked again next time.
        if (state) stateCache.set(a.ticket, { at: Date.now(), state });
      }
      return state && CLOSED_STATE.test(state.trim()) ? undefined : a;
    })
  );
  return { actions: open.filter((a): a is PendingAction => !!a), ...base };
}
