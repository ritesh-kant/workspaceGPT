import { handleBrowserRequest } from './browserActions';
import { BRIDGE_STATUS_KEY, BridgeStatus, CHAT_PORT_NAME } from './bridgeShared';

/**
 * Lets WorkspaceGPT Desktop's agent use the tabs in THIS profile — the one
 * the user is already signed in to — without a separate sandbox browser.
 *
 * The service worker opens a native-messaging port to `com.workspacegpt.bridge`.
 * Chrome launches the desktop's relay for it (registered by the desktop app),
 * and the relay pipes the port into the running agent. Requests come in as
 * { type: 'request', id, method, params }, answers go back as
 * { type: 'response', id, result | error }.
 *
 * Always on: there is no switch, the bridge connects whenever the worker runs. What the agent can do once
 * connected is in browserActions.ts.
 */


const HOST_NAME = 'com.workspacegpt.bridge';
const RETRY_ALARM = 'wgpt-browser-bridge';

let port: chrome.runtime.Port | null = null;

/** Side-panel questions in flight to the desktop, by the id the desktop knows them under. */
const asks = new Map<number, { panel: chrome.runtime.Port; panelId: number; sessionId?: string }>();
let nextAskId = 1;

function failAsks(message: string, only?: (a: { panel: chrome.runtime.Port }) => boolean): void {
  for (const [id, a] of asks) {
    if (only && !only(a)) continue;
    asks.delete(id);
    try {
      a.panel.postMessage({ id: a.panelId, kind: 'error', message });
    } catch {
      /* the panel is gone */
    }
  }
}

function setStatus(status: Omit<BridgeStatus, 'at'>): void {
  void chrome.storage.local.set({ [BRIDGE_STATUS_KEY]: { ...status, at: Date.now() } });
}

export async function connectBridge(): Promise<void> {
  if (port) return;
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    setStatus({ connected: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  port = p;
  p.onMessage.addListener((msg) => void onMessage(p, msg));
  p.onDisconnect.addListener(() => {
    failAsks('WorkspaceGPT Desktop stopped answering. Is it still running?');
    // "Native host has exited" — the desktop app is not running — or
    // "Specified native messaging host not found" — it was never installed.
    const error = chrome.runtime.lastError?.message;
    if (port === p) port = null;
    setStatus({ connected: false, error: error ?? 'Disconnected' });
  });
  p.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
  setStatus({ connected: true });
}

/** Retry on a timer: the desktop app may start after the browser. An open port keeps the worker alive; a closed one lets it sleep. */
export function installBridge(): void {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) void connectBridge();
  });
  void connectBridge();
}

// One request at a time: two attaches to the same tab would collide.
let queue: Promise<unknown> = Promise.resolve();

async function onMessage(p: chrome.runtime.Port, msg: any): Promise<void> {
  if (msg?.type === 'event' && typeof msg.id === 'number') {
    // The desktop's answer to a side-panel question: pass it on, and forget the ask once it ends.
    const a = asks.get(msg.id);
    if (!a) return;
    const { type: _type, id: _id, ...event } = msg;
    try {
      a.panel.postMessage({ id: a.panelId, ...event });
    } catch {
      asks.delete(msg.id);
    }
    if (msg.kind === 'done' || msg.kind === 'error') asks.delete(msg.id);
    return;
  }
  if (msg?.type !== 'request' || typeof msg.id !== 'number') return;
  const run = () => handleBrowserRequest(String(msg.method), msg.params ?? {});
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  try {
    p.postMessage({ type: 'response', id: msg.id, result: await result });
  } catch (err) {
    p.postMessage({ type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The side panel asks its questions here instead of holding a model: the
 * desktop picks the provider and runs the chat. Panel → { id, method, params };
 * answers come back as { id, kind: status | chunk | restart | done | error, ... }.
 */
export function installChatRelay(): void {
  chrome.runtime.onConnect.addListener((panel) => {
    if (panel.name !== CHAT_PORT_NAME) return;
    panel.onMessage.addListener(async (msg: { id: number; method: string; params?: { sessionId?: string } }) => {
      // The panel asking to be connected now rather than at the next 30s retry.
      if (msg.method === 'connect') {
        await connectBridge();
        return;
      }
      if (!port) await connectBridge();
      if (!port) {
        const stored = await chrome.storage.local.get(BRIDGE_STATUS_KEY);
        const why = (stored[BRIDGE_STATUS_KEY] as BridgeStatus | undefined)?.error;
        panel.postMessage({ id: msg.id, kind: 'error', message: `Not connected to WorkspaceGPT Desktop${why ? ` — ${why.replace(/\.+$/, '')}` : ''}.` });
        return;
      }
      const askId = nextAskId++;
      asks.set(askId, { panel, panelId: msg.id, sessionId: msg.params?.sessionId });
      port.postMessage({ type: 'ask', id: askId, method: msg.method, params: msg.params ?? {} });
    });
    // Closing the panel stops what it asked for, so a run isn't left going with nobody reading.
    panel.onDisconnect.addListener(() => {
      for (const [id, a] of asks) {
        if (a.panel !== panel) continue;
        asks.delete(id);
        if (a.sessionId) port?.postMessage({ type: 'ask', id: nextAskId++, method: 'chat.stop', params: { sessionId: a.sessionId } });
      }
    });
  });
}
