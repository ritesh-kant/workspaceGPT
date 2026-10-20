/**
 * Project memory: what WorkspaceGPT has learned about ONE repository — team
 * conventions, decisions and their reasons, where things live in Knowledge.
 * The user memory (userMemory.ts) is about the person and fits in 2,400
 * characters; this is about the project and needs room, so it is files.
 *
 * Layout, under the extension's global storage (never the workspace — the
 * repo may be public, and memory stays on this machine):
 *
 *   memory/<repoKey>/MEMORY.md     one line per topic, generated on every write
 *   memory/<repoKey>/<name>.md     frontmatter (name, description, kind,
 *                                  updated, source?) + the note itself
 *
 * `repoKey` comes from the git common dir, so every worktree and subfolder of
 * one clone shares one store. The index is what goes into the prompt
 * (capped); a topic file is read on demand with `read_memory`.
 *
 * Plain Node fs rather than vscode.workspace.fs: it runs the same in the
 * desktop sidecar and in headless tests, and the store is never a workspace file.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { SECRET_LIKE, slug } from './userMemory';

export type ProjectMemoryKind = 'preference' | 'convention' | 'reference' | 'decision';
export type ProjectMemorySourceType = 'confluence' | 'ado' | 'jira' | 'file' | 'run';

export interface ProjectMemorySource {
  type: ProjectMemorySourceType;
  id: string;
  version?: string;
}

export interface ProjectMemoryEntry {
  name: string;
  description: string;
  kind: ProjectMemoryKind;
  updated: string;
  source?: ProjectMemorySource;
  body: string;
}

export const MAX_PROJECT_ENTRIES = 50;
export const MAX_DESCRIPTION_CHARS = 150;
export const MAX_BODY_CHARS = 4_000;
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 8_192; // ≈ 2k tokens, the most the project index can add to a turn

const INDEX_FILE = 'MEMORY.md';
const KINDS: readonly ProjectMemoryKind[] = ['preference', 'convention', 'reference', 'decision'];
const SOURCE_TYPES: readonly ProjectMemorySourceType[] = ['confluence', 'ado', 'jira', 'file', 'run'];

/**
 * The repository's shared git dir: `.git` itself for a normal clone, or what a
 * worktree's `.git` file points at, followed through its `commondir`. Read from
 * disk rather than by spawning git, so it is cheap and needs no git binary.
 */
function gitCommonDir(folder: string): string | undefined {
  let dir = path.resolve(folder);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (pointer) {
        const gitDir = path.resolve(dir, pointer[1].trim());
        try {
          return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {
          return gitDir; // a submodule: its own git dir is the common one
        }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** `<readable name>-<hash>`: one key per repository, shared by its worktrees; a folder outside git keys on itself. */
export function repoKeyFor(folder: string): string {
  const common = gitCommonDir(folder);
  const anchor = realpath(common ?? folder);
  const label = slug(path.basename(common ? path.dirname(anchor) : anchor)) || 'project';
  return `${label}-${createHash('sha256').update(anchor).digest('hex').slice(0, 12)}`;
}

/** Where `folder`'s project memory lives, under the extension's global storage path. */
export function projectMemoryDir(globalStoragePath: string, folder: string): string {
  return path.join(globalStoragePath, 'memory', repoKeyFor(folder));
}

/** Same discipline as historyService's writeFileAtomic: temp file, then rename. */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** One write at a time per store, so two sessions saving at once cannot interleave an index rebuild. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(dir) ?? Promise.resolve()).then(fn, fn);
  queues.set(dir, next.catch(() => undefined));
  return next;
}

function serialize(e: ProjectMemoryEntry): string {
  // Strings are JSON-quoted, which is also valid YAML, so a ":" in a description cannot break the frontmatter.
  const lines = ['---', `name: ${e.name}`, `description: ${JSON.stringify(e.description)}`, `kind: ${e.kind}`, `updated: ${e.updated}`];
  if (e.source) lines.push(`source: ${JSON.stringify(e.source)}`);
  return `${lines.join('\n')}\n---\n\n${e.body}\n`;
}

function parseTopic(text: string): ProjectMemoryEntry | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return undefined;
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = /^["{]/.test(raw) ? JSON.parse(raw) : raw;
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  const name = typeof meta.name === 'string' ? slug(meta.name) : '';
  if (!name) return undefined;
  return {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    kind: KINDS.includes(meta.kind as ProjectMemoryKind) ? (meta.kind as ProjectMemoryKind) : 'convention',
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    ...(normalizeSource(meta.source) && { source: normalizeSource(meta.source) }),
    body: m[2].trim(),
  };
}

function normalizeSource(raw: unknown): ProjectMemorySource | undefined {
  const s = raw as Partial<Record<keyof ProjectMemorySource, unknown>> | undefined;
  if (!s || typeof s !== 'object' || !SOURCE_TYPES.includes(s.type as ProjectMemorySourceType)) return undefined;
  const id = String(s.id ?? '').trim().slice(0, 300);
  if (!id) return undefined;
  const version = s.version === undefined || s.version === null ? '' : String(s.version).trim().slice(0, 60);
  return { type: s.type as ProjectMemorySourceType, id, ...(version && { version }) };
}

/** Every topic in the store, by name. A missing store is an empty one. */
export async function listProjectMemories(dir: string): Promise<ProjectMemoryEntry[]> {
  let files: string[];
  try {
    files = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const entries: ProjectMemoryEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f === INDEX_FILE) continue;
    const entry = parseTopic(await fsp.readFile(path.join(dir, f), 'utf8').catch(() => ''));
    if (entry && `${entry.name}.md` === f) entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** The index is derived, never edited in place: rebuilt from the topic files after every change. */
async function rebuildIndex(dir: string): Promise<void> {
  const entries = await listProjectMemories(dir);
  const lines = entries.map((e) => `- [${e.name}](${e.name}.md) (${e.kind}): ${e.description}`);
  await writeFileAtomic(path.join(dir, INDEX_FILE), lines.length ? `${lines.join('\n')}\n` : '');
}

export interface SaveProjectMemoryArgs {
  name?: unknown;
  kind?: unknown;
  text?: unknown;
  description?: unknown;
  source?: unknown;
  forget?: unknown;
}

/** Upsert a topic by name, or forget it. Refuses credentials, and refuses a new topic once the store is full. */
export function saveProjectMemory(dir: string, args: SaveProjectMemoryArgs): Promise<{ ok: boolean; message: string }> {
  const name = slug(String(args?.name ?? ''));
  if (!name) return Promise.resolve({ ok: false, message: 'name is required (a short label, e.g. "release-branching").' });
  const file = path.join(dir, `${name}.md`);

  if (args?.forget) {
    return serialized(dir, async () => {
      const existed = fs.existsSync(file);
      await fsp.rm(file, { force: true });
      if (existed) await rebuildIndex(dir);
      return { ok: true, message: existed ? `Forgot project memory "${name}".` : `Nothing saved as "${name}" in project memory.` };
    });
  }

  const body = String(args?.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) return Promise.resolve({ ok: false, message: 'text is required.' });
  const description = (String(args?.description ?? '').trim() || body.split('\n')[0]).replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION_CHARS);
  if (SECRET_LIKE.test(`${name}\n${description}\n${body}`)) {
    return Promise.resolve({ ok: false, message: 'Not saved: that looks like a credential. Memory never stores secrets.' });
  }
  const kind = KINDS.includes(args?.kind as ProjectMemoryKind) ? (args!.kind as ProjectMemoryKind) : 'convention';
  const source = normalizeSource(args?.source);
  const entry: ProjectMemoryEntry = {
    name,
    description,
    kind,
    updated: new Date().toISOString(),
    ...(source && { source }),
    body: body.slice(0, MAX_BODY_CHARS),
  };

  return serialized(dir, async () => {
    if (!fs.existsSync(file) && (await listProjectMemories(dir)).length >= MAX_PROJECT_ENTRIES) {
      return {
        ok: false,
        message: `Not saved: project memory is full (${MAX_PROJECT_ENTRIES} topics). Update an existing topic by its name, or forget one first.`,
      };
    }
    await writeFileAtomic(file, serialize(entry));
    await rebuildIndex(dir);
    return { ok: true, message: `Saved "${name}" to project memory.` };
  });
}

/** One topic file, whole — what `read_memory` returns. No name returns the full, uncapped index. */
export async function readProjectMemory(dir: string, rawName: unknown): Promise<{ ok: boolean; message: string; content?: string }> {
  const name = slug(String(rawName ?? ''));
  if (!name) {
    const index = await fsp.readFile(path.join(dir, INDEX_FILE), 'utf8').catch(() => '');
    return index.trim() ? { ok: true, message: 'Project memory index.', content: index } : { ok: false, message: 'Project memory is empty.' };
  }
  const text = await fsp.readFile(path.join(dir, `${name}.md`), 'utf8').catch(() => undefined);
  if (text !== undefined) return { ok: true, message: `Project memory "${name}".`, content: text };
  const names = (await listProjectMemories(dir)).map((e) => e.name);
  return {
    ok: false,
    message: names.length
      ? `No project memory named "${name}". Saved topics: ${names.join(', ')}.`
      : 'Project memory is empty.',
  };
}

export async function clearProjectMemories(dir: string): Promise<void> {
  await serialized(dir, () => fsp.rm(dir, { recursive: true, force: true }));
}

/**
 * The prompt block: the index, cut at whole lines to MAX_INDEX_LINES /
 * MAX_INDEX_BYTES. Built once at run start and passed to the worker, so a save
 * mid-run never changes the cached prefix of the turns that follow it. Still
 * carries the save instruction when empty, so the first topic can be written.
 */
export async function projectMemoryBlock(dir: string): Promise<string> {
  const index = await fsp.readFile(path.join(dir, INDEX_FILE), 'utf8').catch(() => '');
  const lines = index.split('\n').filter((l) => l.trim());
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (shown >= MAX_INDEX_LINES || Buffer.byteLength(body + line + '\n') > MAX_INDEX_BYTES) break;
    body += `${line}\n`;
    shown++;
  }
  if (shown < lines.length) body += `- (+${lines.length - shown} more topics not listed; read_memory with no name gives the full index)\n`;
  return (
    '**About this project (remembered from earlier runs in this repository — an index; call `read_memory` with a name for the full note):**\n' +
    (body || '- (nothing yet)\n') +
    'Call `save_memory` with `scope:"project"` for a lasting fact about this repository or team that a future run here will need: a convention, a decision and its reason, where something lives. ' +
    'Give a one-line `description`, and a `source` when it came from Confluence, Jira, Azure DevOps or a file. Same `name` updates it. ' +
    'Point to Knowledge rather than copying it; never save one-off task details or secrets.\n'
  );
}
