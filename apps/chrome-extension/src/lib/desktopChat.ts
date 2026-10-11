import { CHAT_PORT_NAME } from './bridgeShared';

/** What the desktop streams back for one question. */
export type DesktopEvent =
  | { kind: 'status'; text: string }
  | { kind: 'chunk'; text: string }
  | { kind: 'restart' }
  | { kind: 'done'; text?: string }
  | { kind: 'error'; message: string };

/**
 * Ask WorkspaceGPT Desktop a question. The desktop picks the provider, searches
 * its own index and runs the chat; this only relays (background → native port).
 * Aborting the signal stops the run on the desktop.
 */
export interface TabRef {
  id: number;
  title: string;
  url: string;
}

export async function* askDesktop(
  sessionId: string,
  message: string,
  opts: {
    signal?: AbortSignal;
    /** Earlier turns of a resumed conversation, so the desktop's model has the context again. */
    history?: { role: 'user' | 'assistant'; content: string }[];
    /** The tab the user has open, when they let the panel read it. The desktop agent reads it; it cannot change it. */
    tab?: TabRef;
  } = {},
): AsyncGenerator<DesktopEvent> {
  const { signal, history, tab } = opts;
  const port = chrome.runtime.connect({ name: CHAT_PORT_NAME });
  const queue: DesktopEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const push = (e: DesktopEvent) => {
    queue.push(e);
    wake?.();
  };
  port.onMessage.addListener((m: DesktopEvent & { id: number }) => push(m));
  port.onDisconnect.addListener(() => push({ kind: 'error', message: 'The extension lost its connection. Reopen the panel and try again.' }));
  const onAbort = () => {
    port.postMessage({ id: 2, method: 'chat.stop', params: { sessionId } });
    push({ kind: 'done' });
  };
  signal?.addEventListener('abort', onAbort);
  port.postMessage({ id: 1, method: 'chat', params: { sessionId, message, ...(history?.length ? { history } : {}), ...(tab ? { tab } : {}) } });
  try {
    while (!ended) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      const e = queue.shift();
      if (!e) continue;
      if (e.kind === 'done' || e.kind === 'error') ended = true;
      yield e;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    port.disconnect();
  }
}
