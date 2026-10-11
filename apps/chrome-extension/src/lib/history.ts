/**
 * The side panel's own conversation list, in this browser's extension storage.
 * The desktop keeps no copy: these chats never leave the machine, and they
 * survive a desktop restart. Resuming one re-seeds the desktop's model history
 * (see askDesktop's `history`).
 */

export interface StoredMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** The page the question was asked about, shown as a note under it. */
  tab?: { title: string; url: string };
}

export interface StoredChat {
  id: string;
  title: string;
  updatedAt: number;
  messages: StoredMessage[];
}

const KEY = 'wgptChats';
/** Oldest conversations drop off beyond this, well inside chrome.storage.local's quota. */
const MAX_CHATS = 40;

const titleOf = (messages: StoredMessage[]): string => {
  const first = messages.find((m) => m.role === 'user')?.content.trim().split('\n')[0] ?? 'New chat';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
};

export async function listChats(): Promise<StoredChat[]> {
  const stored = await chrome.storage.local.get(KEY);
  const chats = (stored[KEY] as StoredChat[] | undefined) ?? [];
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveChat(id: string, messages: StoredMessage[]): Promise<void> {
  // An unanswered or failed last turn is not worth keeping as a half-conversation.
  const kept = messages.filter((m, i) => !(i === messages.length - 1 && m.role === 'assistant' && !m.content));
  if (!kept.some((m) => m.role === 'user')) return;
  const others = (await listChats()).filter((c) => c.id !== id);
  const next = [{ id, title: titleOf(kept), updatedAt: Date.now(), messages: kept }, ...others].slice(0, MAX_CHATS);
  await chrome.storage.local.set({ [KEY]: next });
}

export async function deleteChat(id: string): Promise<void> {
  const next = (await listChats()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [KEY]: next });
}
