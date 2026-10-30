/**
 * Fixing what the speech model misheard in a call note (docs/design/call-notes.md).
 *
 * Whisper's prompt holds ~224 tokens, far too few for an organization's names and
 * jargon, so the fix happens after the call: the people and terms in the user's
 * synced Knowledge (read from disk, on this machine) are matched by sound against
 * the words in the transcript, and the few near-misses go to the summary model as
 * candidates. The model says which are real; this file checks its answer. Nothing
 * here rewrites the transcript: corrections are recorded beside it, original kept.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { CallNoteTurn } from './callNotes';

export interface OrgVocabulary {
  /** First and last names from "Assigned To / Created By / Changed By", as written in the index. */
  names: string[];
  /** Capitalized words from item and page titles that recur (product, system and team terms). */
  terms: string[];
}

export interface Correction {
  from: string;
  to: string;
  /** How many times `from` occurs in the transcript. */
  count: number;
}

/** A transcript word and the Knowledge spellings it sounds like. */
export interface Candidate {
  heard: string;
  maybe: string[];
}

const SOURCES = ['ado', 'confluence', 'jira'];
const HEAD_BYTES = 6000;
const MAX_FILES = 6000;
const MAX_CANDIDATES = 30;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; vocab: OrgVocabulary }>();

/** People and terms from the synced Knowledge under `storageRoot` (`ado|confluence|jira/mds/*.md`). */
export async function readOrgVocabulary(storageRoot: string): Promise<OrgVocabulary> {
  const hit = cache.get(storageRoot);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.vocab;
  const names = new Set<string>();
  const termCounts = new Map<string, number>();
  let scanned = 0;
  for (const source of SOURCES) {
    const dir = path.join(storageRoot, source, 'mds');
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.md') || scanned++ >= MAX_FILES) continue;
      const head = await readHead(path.join(dir, file));
      for (const m of head.matchAll(/\*\*(?:Assigned To|Created By|Changed By)\*\* \| ([^|\n]+)\|/g)) {
        const raw = m[1].replace(/\(.*?\)/g, '').trim();
        if (!raw || /^(unassigned|n\/a)$/i.test(raw)) continue;
        const [first, last] = raw.includes(',') ? raw.split(',').reverse().map((s) => s.trim()) : raw.split(/\s+/);
        for (const n of [first, last]) if (n && /^\p{L}{3,}$/u.test(n)) names.add(n);
      }
      const title = /^# (.+)$/m.exec(head)?.[1] ?? '';
      for (const w of title.match(/\b[A-Z][A-Za-z0-9]{3,}\b/g) ?? []) termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
    }
  }
  const vocab = { names: [...names], terms: [...termCounts].filter(([, n]) => n >= 2).map(([w]) => w) };
  cache.set(storageRoot, { at: Date.now(), vocab });
  return vocab;
}

async function readHead(file: string): Promise<string> {
  const fh = await fsp.open(file, 'r').catch(() => undefined);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** A rough sound key: spellings that are said alike ("Prag"/"Parag", "Emplence"/"Amplience") collide. */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  for (const [a, b] of [['ph', 'f'], ['ck', 'k'], ['q', 'k'], ['x', 'ks'], ['z', 's'], ['v', 'b'], ['w', 'b'], ['y', 'i'], ['j', 'g'], ['c', 'k'], ['h', '']]) w = w.split(a).join(b);
  return w.replace(/[aeiou]+/g, 'a').replace(/(.)\1+/g, '$1');
}

/** 1 for equal strings, falling toward 0 as more edits are needed. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

/**
 * Capitalized transcript words (names and terms are written capitalized) that are
 * not in the Knowledge as spelled but sound like something that is. Only a lead:
 * "Thomas" is fine, "Times" is not what anyone meant, and the model decides.
 */
export function correctionCandidates(turns: readonly CallNoteTurn[], vocab: OrgVocabulary): Candidate[] {
  const known = new Map<string, string>();
  for (const v of [...vocab.names, ...vocab.terms]) known.set(v.toLowerCase(), v);
  const byKey = new Map<string, string[]>();
  for (const v of known.values()) {
    const key = phoneticKey(v);
    if (key.length >= 3) byKey.set(key, [...(byKey.get(key) ?? []), v]);
  }
  const keys = [...byKey.keys()];
  // An ordinary word is capitalized only when it opens a sentence ("Thank", "Today") or also appears in lower case;
  // a name or term is capitalized in the middle of one too. Only the latter can be a misheard name.
  const heard = new Map<string, number>();
  const mid = new Set<string>();
  const lower = new Set<string>();
  for (const t of turns) {
    for (const w of t.text.match(/\b[a-z]{4,}\b/g) ?? []) lower.add(w);
    for (const sentence of t.text.split(/(?<=[.?!…])\s+/)) {
      for (const [i, w] of (sentence.match(/\b[A-Z][A-Za-z]{3,}\b/g) ?? []).entries()) {
        heard.set(w, (heard.get(w) ?? 0) + 1);
        if (i > 0 || !sentence.startsWith(w)) mid.add(w);
      }
    }
  }
  const found: (Candidate & { n: number })[] = [];
  for (const [word, n] of heard) {
    if (known.has(word.toLowerCase()) || !mid.has(word) || lower.has(word.toLowerCase())) continue;
    const key = phoneticKey(word);
    if (key.length < 3) continue;
    const maybe = new Set<string>();
    for (const k of keys) if (similarity(key, k) >= 0.75) for (const v of byKey.get(k)!) maybe.add(v);
    if (maybe.size) found.push({ heard: word, maybe: [...maybe].slice(0, 3), n });
  }
  return found.sort((a, b) => b.n - a.n).slice(0, MAX_CANDIDATES).map(({ heard, maybe }) => ({ heard, maybe }));
}

/**
 * Whisper sometimes loops, writing the same sentences over and over. A long line that
 * already occurred among the last few turns is dropped; short ones ("Yeah.") are real repeats.
 */
export function collapseLoops<T extends CallNoteTurn>(turns: readonly T[]): T[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out: T[] = [];
  for (const turn of turns) {
    const text = norm(turn.text);
    const repeated = text.length >= 20 && out.slice(-4).some((t) => norm(t.text) === text);
    if (!repeated) out.push(turn);
  }
  return out;
}

const wordRe = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');

/**
 * The model's proposed fixes, kept only when checkable: `from` is really in the
 * transcript, and `to` is a Knowledge spelling offered as a candidate, a small
 * respelling of `from`, or a word the call itself says elsewhere.
 */
export function acceptCorrections(raw: unknown, turns: readonly CallNoteTurn[], candidates: readonly Candidate[]): Correction[] {
  const spoken = turns.map((t) => t.text).join('\n');
  const offered = new Set(candidates.flatMap((c) => c.maybe.map((m) => m.toLowerCase())));
  const seen = new Set<string>();
  const out: Correction[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const from = typeof c?.from === 'string' ? c.from.replace(/\s+/g, ' ').trim() : '';
    const to = typeof c?.to === 'string' ? c.to.replace(/\s+/g, ' ').trim() : '';
    if (!from || !to || from === to || from.length > 40 || to.length > 40 || seen.has(from)) continue;
    const count = spoken.match(wordRe(from))?.length ?? 0;
    if (!count) continue;
    const grounded =
      offered.has(to.toLowerCase()) ||
      similarity(from.toLowerCase(), to.toLowerCase()) >= 0.6 ||
      (spoken.match(wordRe(to))?.length ?? 0) > 0;
    if (!grounded) continue;
    seen.add(from);
    out.push({ from, to, count });
  }
  return out.slice(0, 20);
}

/** `text` with each correction applied to every whole-word occurrence. */
export function applyCorrections(text: string, corrections: readonly Correction[]): string {
  return corrections.reduce((t, c) => t.replace(wordRe(c.from), c.to), text);
}
