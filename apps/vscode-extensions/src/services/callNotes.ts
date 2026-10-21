/**
 * Call notes: transcripts of calls the user chose to take notes of
 * (docs/design/call-notes.md). Only the desktop app records them
 * (apps/desktop/sidecar/host/callRecorder.ts writes through this module); this
 * side lists them in the Sessions panel, shows one, and lets the agent read
 * them. In VS Code the folder simply stays empty.
 *
 * One Markdown file per call, under the extension's global storage (never the
 * workspace: the repo may be public, and a call stays on this machine):
 *
 *   call-notes/<id>.md
 *     ---
 *     id: 2026-10-21-1032-k3f9
 *     title: "Call on Tue 21 Oct, 10:32"
 *     started: 2026-10-21T05:02:05.000Z
 *     ended: 2026-10-21T05:32:10.000Z      (absent while recording)
 *     status: recording | done
 *     notice: "Only your side was transcribed: …"   (optional)
 *     ---
 *
 *     [00:12] You: …
 *     [01:04] Others: …
 *
 * Plain Node fs rather than vscode.workspace.fs, as in projectMemory.ts: the
 * desktop sidecar and headless tests use it too.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';

export type CallNoteSpeaker = 'you' | 'others';

export interface CallNoteTurn {
  speaker: CallNoteSpeaker;
  /** Seconds since the recording started. */
  at: number;
  text: string;
}

export interface CallNote {
  id: string;
  title: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  /** Something the reader should know, e.g. that only one side was heard. */
  notice?: string;
  turns: CallNoteTurn[];
}

/** What the Sessions panel lists: everything but the transcript. */
export interface CallNoteSummary {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  status: 'recording' | 'done';
  turnCount: number;
  /** The first words said, for a row's tooltip and the agent's listing. */
  preview: string;
}

const DIR = 'call-notes';
/** Ids are made by the recorder; anything else could name a path outside the folder. */
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const TURN = /^\[(?:(\d+):)?(\d{1,2}):(\d{2})\] (You|Others): (.*)$/;
const SPEAKER_LABEL: Record<CallNoteSpeaker, string> = { you: 'You', others: 'Others' };

export function callNotesDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, DIR);
}

export function isCallNoteId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id);
}

/** A sortable, readable id: local date and time of the start, plus a few random letters. */
export function newCallNoteId(startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${rand}`;
}

export function formatOffset(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** A turn's text on one line: the transcript format is one turn per line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function renderCallNote(note: CallNote): string {
  const head = [
    '---',
    `id: ${note.id}`,
    `title: ${JSON.stringify(oneLine(note.title))}`,
    `started: ${new Date(note.startedAt).toISOString()}`,
    ...(note.endedAt ? [`ended: ${new Date(note.endedAt).toISOString()}`] : []),
    `status: ${note.status}`,
    ...(note.notice ? [`notice: ${JSON.stringify(oneLine(note.notice))}`] : []),
    '---',
    '',
  ];
  const turns = [...note.turns]
    .sort((a, b) => a.at - b.at)
    .map((t) => `[${formatOffset(t.at)}] ${SPEAKER_LABEL[t.speaker]}: ${oneLine(t.text)}`);
  return [...head, ...turns, ''].join('\n');
}

export function parseCallNote(text: string): CallNote | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return undefined;
  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        /* keep it as written */
      }
    }
    fields.set(kv[1], value);
  }
  const id = fields.get('id');
  const startedAt = Date.parse(fields.get('started') ?? '');
  if (!isCallNoteId(id) || Number.isNaN(startedAt)) return undefined;
  const endedAt = Date.parse(fields.get('ended') ?? '');
  const turns: CallNoteTurn[] = [];
  for (const line of m[2].split('\n')) {
    const t = TURN.exec(line.trim());
    if (!t) continue;
    turns.push({
      speaker: t[4] === 'You' ? 'you' : 'others',
      at: Number(t[1] ?? 0) * 3600 + Number(t[2]) * 60 + Number(t[3]),
      text: t[5],
    });
  }
  return {
    id,
    title: fields.get('title') || 'Call',
    startedAt,
    ...(Number.isNaN(endedAt) ? {} : { endedAt }),
    status: fields.get('status') === 'recording' ? 'recording' : 'done',
    ...(fields.get('notice') ? { notice: fields.get('notice') } : {}),
    turns,
  };
}

/** Write-then-rename, so the Sessions panel's watcher never reads half a note. */
export async function writeCallNote(dir: string, note: CallNote): Promise<void> {
  if (!isCallNoteId(note.id)) throw new Error(`invalid call note id: ${note.id}`);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${note.id}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, renderCallNote(note), 'utf8');
  await fsp.rename(tmp, file);
}

export async function readCallNote(dir: string, id: unknown): Promise<CallNote | undefined> {
  if (!isCallNoteId(id)) return undefined;
  try {
    return parseCallNote(await fsp.readFile(path.join(dir, `${id}.md`), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Newest first. */
export async function listCallNotes(dir: string): Promise<CallNoteSummary[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const notes = await Promise.all(
    names.filter((n) => n.endsWith('.md')).map((n) => readCallNote(dir, n.slice(0, -3)))
  );
  return notes
    .filter((n): n is CallNote => !!n)
    .map((n) => ({
      id: n.id,
      title: n.title,
      startedAt: n.startedAt,
      ...(n.endedAt ? { endedAt: n.endedAt } : {}),
      status: n.status,
      turnCount: n.turns.length,
      preview: oneLine(n.turns.map((t) => t.text).join(' ')).slice(0, 160),
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function deleteCallNote(dir: string, id: unknown): Promise<boolean> {
  if (!isCallNoteId(id)) return false;
  try {
    await fsp.unlink(path.join(dir, `${id}.md`));
    return true;
  } catch {
    return false;
  }
}

/** Rename a call; the transcript is untouched. */
export async function renameCallNote(dir: string, id: unknown, title: string): Promise<boolean> {
  const note = await readCallNote(dir, id);
  const clean = oneLine(title).slice(0, 120);
  if (!note || !clean) return false;
  await writeCallNote(dir, { ...note, title: clean });
  return true;
}

/** Whether there is any call note at all: what offers the agent the call-note tools (a fact, not a guess). */
export async function hasCallNotes(dir: string): Promise<boolean> {
  try {
    return (await fsp.readdir(dir)).some((n) => n.endsWith('.md'));
  } catch {
    return false;
  }
}

const MAX_LISTED = 30;
const MAX_MATCH_LINES = 6;

/**
 * `search_call_notes`: the calls, newest first, as one line each. With a
 * query, only calls whose title or transcript holds every word of it, each
 * with its matching lines, so the agent can tell which call to read in full.
 */
export async function searchCallNotes(dir: string, args: { query?: unknown; days?: unknown }): Promise<{ ok: boolean; message: string }> {
  const words = String(args?.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const days = Number(args?.days);
  const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : 0;
  const summaries = (await listCallNotes(dir)).filter((n) => n.startedAt >= since);
  const found: string[] = [];
  for (const summary of summaries) {
    if (found.length >= MAX_LISTED) break;
    const when = new Date(summary.startedAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const length = summary.endedAt ? `${Math.max(1, Math.round((summary.endedAt - summary.startedAt) / 60_000))} min` : 'still recording';
    const head = `- ${summary.id}: "${summary.title}", ${when}, ${length}, ${summary.turnCount} turns`;
    if (!words.length) {
      found.push(summary.preview ? `${head}\n  starts: ${summary.preview}` : head);
      continue;
    }
    const note = await readCallNote(dir, summary.id);
    if (!note) continue;
    const lines = note.turns.map((t) => `[${formatOffset(t.at)}] ${SPEAKER_LABEL[t.speaker]}: ${t.text}`);
    const haystack = `${note.title}\n${lines.join('\n')}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const hits = lines.filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, MAX_MATCH_LINES);
    found.push([head, ...hits.map((h) => `  ${h.length > 300 ? `${h.slice(0, 300)}…` : h}`)].join('\n'));
  }
  if (!found.length) {
    return { ok: true, message: summaries.length ? `No call note matches "${String(args?.query ?? '')}".` : 'There are no call notes yet.' };
  }
  return {
    ok: true,
    message:
      'Call notes (transcripts of calls the user recorded; "You" is the user, "Others" everyone else on the call). Read one in full with read_call_note.\n' +
      found.join('\n'),
  };
}

/** `read_call_note`: one call's whole transcript. */
export async function readCallNoteForAgent(dir: string, id: unknown): Promise<{ ok: boolean; message: string; content?: string }> {
  const note = await readCallNote(dir, id);
  if (!note) return { ok: false, message: `No call note "${String(id ?? '')}". search_call_notes lists them.` };
  return { ok: true, message: `Call note ${note.id}`, content: renderCallNote(note) };
}

/** A turn as the recorder hears it: with its end, which echo detection needs. */
export type HeardTurn = CallNoteTurn & { end?: number };

/** Seconds either side of a "you" turn in which the same words from "others" count as its echo. */
const ECHO_WINDOW_S = 4;
/** Share of a "you" turn's words that must also be in the overlapping "others" turns. */
const ECHO_SHARE = 0.6;
/** Shorter "you" turns ("Yeah", "Hello, guys") are judged by the stricter rule below. */
const ECHO_MIN_WORDS = 3;
/** A short "you" turn is an echo only if "others" said exactly the same words this close to it. */
const SHORT_ECHO_WINDOW_S = 1.5;

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

/**
 * Drops "you" turns that are the call's own audio picked up by the mic (the
 * user on speakers, not headphones): most of their words were said by "others"
 * at the same moment. "Others" is the call app's audio read directly, so when
 * the two disagree about who said it, "others" is right.
 */
export function dropEchoes(turns: readonly HeardTurn[]): CallNoteTurn[] {
  const others = turns.filter((t) => t.speaker === 'others');
  return turns
    .filter((t) => {
      if (t.speaker !== 'you') return true;
      const mine = wordsOf(t.text);
      if (mine.length < ECHO_MIN_WORDS) {
        // Too few words to compare by share: only the same words at the same moment count, so a
        // "Yeah" said in reply is kept.
        const same = mine.join(' ');
        return !others.some((o) => Math.abs(o.at - t.at) <= SHORT_ECHO_WINDOW_S && wordsOf(o.text).join(' ') === same);
      }
      const from = t.at - ECHO_WINDOW_S;
      const to = (t.end ?? t.at + 10) + ECHO_WINDOW_S;
      const heard = new Map<string, number>();
      for (const o of others) {
        if ((o.end ?? o.at + 10) < from || o.at > to) continue;
        for (const w of wordsOf(o.text)) heard.set(w, (heard.get(w) ?? 0) + 1);
      }
      let shared = 0;
      for (const w of mine) {
        const n = heard.get(w) ?? 0;
        if (n > 0) {
          shared++;
          heard.set(w, n - 1);
        }
      }
      return shared / mine.length < ECHO_SHARE;
    })
    .map(({ speaker, at, text }) => ({ speaker, at, text }));
}
