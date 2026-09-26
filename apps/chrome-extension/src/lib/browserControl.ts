import { handleBrowserRequest } from './browserActions';

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
 * Off until the user turns it on in Settings (BROWSER_CONTROL_KEY), which is
 * also when Chrome asks for BRIDGE_PERMISSIONS. What the agent can do once
 * connected is in browserActions.ts.
 */

export const BROWSER_CONTROL_KEY = 'browserControlEnabled';
export const BRIDGE_STATUS_KEY = 'browserBridgeStatus';
/** Requested from the Settings switch (a user gesture), removed when it is turned off. */
export const BRIDGE_PERMISSIONS: chrome.permissions.Permissions = { permissions: ['nativeMessaging'], origins: ['<all_urls>'] };

export interface BridgeStatus {
  connected: boolean;
  /** Why the last attempt failed — usually that WorkspaceGPT Desktop is not running or not installed. */
  error?: string;
  at: number;
}

const HOST_NAME = 'com.workspacegpt.bridge';
const RETRY_ALARM = 'wgpt-browser-bridge';

let port: chrome.runtime.Port | null = null;

function setStatus(status: Omit<BridgeStatus, 'at'>): void {
  void chrome.storage.local.set({ [BRIDGE_STATUS_KEY]: { ...status, at: Date.now() } });
}

async function isEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(BROWSER_CONTROL_KEY);
  return stored[BROWSER_CONTROL_KEY] === true && (await chrome.permissions.contains(BRIDGE_PERMISSIONS));
}

export async function connectBridge(): Promise<void> {
  if (port || !(await isEnabled())) return;
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
    // "Native host has exited" — the desktop app is not running — or
    // "Specified native messaging host not found" — it was never installed.
    const error = chrome.runtime.lastError?.message;
    if (port === p) port = null;
    setStatus({ connected: false, error: error ?? 'Disconnected' });
  });
  p.postMessage({ type: 'hello', version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
  setStatus({ connected: true });
}

export function disconnectBridge(): void {
  port?.disconnect();
  port = null;
  setStatus({ connected: false, error: 'Turned off' });
}

/** Retry on a timer: the desktop app may start after the browser. An open port keeps the worker alive; a closed one lets it sleep. */
export function installBridge(): void {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) void connectBridge();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(BROWSER_CONTROL_KEY in changes)) return;
    if (changes[BROWSER_CONTROL_KEY].newValue === true) void connectBridge();
    else disconnectBridge();
  });
  // Revoked from chrome://extensions rather than from our switch.
  chrome.permissions.onRemoved.addListener(() => disconnectBridge());
  void connectBridge();
}

// One request at a time: two attaches to the same tab would collide.
let queue: Promise<unknown> = Promise.resolve();

async function onMessage(p: chrome.runtime.Port, msg: any): Promise<void> {
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
