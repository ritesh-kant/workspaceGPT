/**
 * User memory: short, durable facts about how this person works, written by the
 * agent through `save_memory` and replayed into every system prompt.
 *
 * Cost is the design constraint, so it is bounded by construction: no extra
 * model calls (the agent already has the conversation when it decides to save),
 * no retrieval tool (the whole store IS the prompt block), a hard cap on
 * entries and characters, and a block that is identical between turns so it
 * sits inside the provider's cached prompt prefix.
 *
 * Lives in globalState, on-device. Never holds secrets or knowledge-source
 * content — only preferences, style and working context.
 */

export interface MemoryStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export type MemoryKind = 'preference' | 'style' | 'context';

export interface MemoryEntry {
  name: string;
  kind: MemoryKind;
  text: string;
  updated: string;
}

const KEY = 'workspacegpt.userMemory';
export const MAX_ENTRIES = 25;
export const MAX_TEXT_CHARS = 200;
const MAX_BLOCK_CHARS = 2_400; // ≈ 600 tokens, the most memory can ever add to a turn

const KINDS: readonly MemoryKind[] = ['preference', 'style', 'context'];

/** Looks like a credential — refused so a key pasted into chat is never replayed into prompts. */
const SECRET_LIKE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const ENABLED_KEY = 'workspacegpt.userMemoryEnabled';

/** On unless the user switched it off in Settings → Memory. */
export const memoryEnabled = (store: MemoryStore) => store.get<boolean>(ENABLED_KEY) !== false;
export const setMemoryEnabled = (store: MemoryStore, on: boolean) => store.update(ENABLED_KEY, on);

export async function clearMemories(store: MemoryStore): Promise<void> {
  await store.update(KEY, []);
}

export function listMemories(store: MemoryStore): MemoryEntry[] {
  const raw = store.get<MemoryEntry[]>(KEY);
  return Array.isArray(raw) ? raw.filter((e) => e && typeof e.name === 'string' && typeof e.text === 'string') : [];
}

export interface SaveMemoryArgs {
  name?: unknown;
  kind?: unknown;
  text?: unknown;
  forget?: unknown;
}

/** Upsert by name (so a changed preference replaces the old one, not duplicates it), or forget. */
export async function saveMemory(store: MemoryStore, args: SaveMemoryArgs): Promise<{ ok: boolean; message: string }> {
  const name = slug(String(args?.name ?? ''));
  if (!name) return { ok: false, message: 'name is required (a short label, e.g. "package-manager").' };
  const entries = listMemories(store);

  if (args?.forget) {
    const next = entries.filter((e) => e.name !== name);
    await store.update(KEY, next);
    return { ok: true, message: next.length < entries.length ? `Forgot "${name}".` : `Nothing saved as "${name}".` };
  }

  const text = String(args?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, message: 'text is required.' };
  if (SECRET_LIKE.test(text)) return { ok: false, message: 'Not saved: that looks like a credential. Memory never stores secrets.' };
  const kind = KINDS.includes(args?.kind as MemoryKind) ? (args!.kind as MemoryKind) : 'preference';

  const entry: MemoryEntry = { name, kind, text: text.slice(0, MAX_TEXT_CHARS), updated: new Date().toISOString() };
  const next = [entry, ...entries.filter((e) => e.name !== name)].slice(0, MAX_ENTRIES);
  await store.update(KEY, next);
  return { ok: true, message: `Saved "${name}".` };
}

/**
 * The prompt block. Deterministic ordering (by name) rather than recency, so a
 * save only changes the prompt when the content changed. Absent when empty AND
 * still carries the save instruction, so the first memory can ever be written.
 */
export function userMemoryBlock(store: MemoryStore): string {
  const entries = listMemories(store).sort((a, b) => a.name.localeCompare(b.name));
  let body = '';
  for (const e of entries) {
    const line = `- ${e.name} (${e.kind}): ${e.text}\n`;
    if (body.length + line.length > MAX_BLOCK_CHARS) break;
    body += line;
  }
  return (
    '**About this user (remembered from earlier chats — apply silently; never recite it):**\n' +
    (body || '- (nothing yet)\n') +
    'Call `save_memory` when the user states or corrects a lasting preference, working style or team convention — one short fact, same `name` to update, `forget:true` to remove. ' +
    'Never save one-off task details, anything derivable from the code, Confluence/Jira/Azure DevOps content, or secrets.\n'
  );
}
