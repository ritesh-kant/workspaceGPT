import * as fs from 'fs';
import * as net from 'net';

/**
 * The agent's view of the user's own browser.
 *
 * The WorkspaceGPT Chrome extension, running in the profile the user already
 * works in, opens a native-messaging port. Chrome launches a tiny relay for it
 * (apps/desktop/sidecar/browser-relay.ts) whose only job is to pipe that
 * port's stdin/stdout into this socket, byte for byte. So what arrives here is
 * Chrome's own framing — a 4-byte little-endian length, then that many bytes
 * of UTF-8 JSON — in both directions.
 *
 * Nothing starts this in VS Code yet; the desktop sidecar does, after it has
 * registered the relay with Chrome. Until an extension has connected and said
 * hello, `isBrowserConnected()` is false and the browser tools are not offered
 * (toolScope.ts) — availability is a fact about a live connection, never a
 * guess.
 */

/**
 * Chat sessions started from the Chrome side panel (chromeChat.ts). They may read
 * pages but never change one: the panel has no way to show the user what an action did.
 */
export const PANEL_SESSION_PREFIX = 'chrome-';
export const isPanelSession = (sessionId: string): boolean => sessionId.startsWith(PANEL_SESSION_PREFIX);

/** Chrome refuses a message from a native host larger than this. */
const MAX_HOST_TO_BROWSER_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

interface Connection {
  socket: net.Socket;
  buffer: Buffer;
  hello?: { version?: string; userAgent?: string };
}

interface Pending {
  conn: Connection;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Requests that start on the extension's side (the side panel asking a
 * question). Answered with any number of `{type:'event', id, ...}` messages.
 */
export type ExtensionRequestHandler = (method: string, params: any, reply: (event: unknown) => void) => void;
let extensionRequestHandler: ExtensionRequestHandler | undefined;
export function onExtensionRequest(handler: ExtensionRequestHandler): void {
  extensionRequestHandler = handler;
}

let server: net.Server | null = null;
const connections: Connection[] = [];
const pending = new Map<number, Pending>();
let nextId = 1;

/** The connection requests go to: the most recent extension that said hello. */
function activeConnection(): Connection | undefined {
  for (let i = connections.length - 1; i >= 0; i--) {
    if (connections[i].hello && !connections[i].socket.destroyed) return connections[i];
  }
  return undefined;
}

export function isBrowserConnected(): boolean {
  return !!activeConnection();
}

function send(conn: Connection, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_HOST_TO_BROWSER_BYTES) throw new Error('Browser request too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  conn.socket.write(Buffer.concat([header, body]));
}

function onMessage(conn: Connection, msg: any): void {
  if (msg?.type === 'hello') {
    conn.hello = { version: msg.version, userAgent: msg.userAgent };
    console.log(`[browser-bridge] extension ${msg.version ?? '?'} connected`);
    return;
  }
  if (msg?.type === 'ask' && typeof msg.id === 'number') {
    const reply = (event: unknown) => {
      if (conn.socket.destroyed) return;
      try {
        send(conn, { type: 'event', id: msg.id, ...(event as object) });
      } catch (err) {
        console.warn('[browser-bridge] could not reply to the browser:', err);
      }
    };
    if (!extensionRequestHandler) reply({ kind: 'error', message: 'This WorkspaceGPT Desktop cannot answer questions from the browser yet.' });
    else extensionRequestHandler(String(msg.method), msg.params ?? {}, reply);
    return;
  }
  if (msg?.type === 'response' && typeof msg.id === 'number') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
  }
}

function onData(conn: Connection, chunk: Buffer): void {
  conn.buffer = Buffer.concat([conn.buffer, chunk]);
  while (conn.buffer.length >= 4) {
    const len = conn.buffer.readUInt32LE(0);
    if (conn.buffer.length < 4 + len) return;
    const body = conn.buffer.subarray(4, 4 + len).toString('utf8');
    conn.buffer = conn.buffer.subarray(4 + len);
    try {
      onMessage(conn, JSON.parse(body));
    } catch (err) {
      console.warn('[browser-bridge] unparseable message from the browser:', err);
    }
  }
}

function onClose(conn: Connection): void {
  const i = connections.indexOf(conn);
  if (i >= 0) connections.splice(i, 1);
  for (const [id, p] of pending) {
    if (p.conn !== conn) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error('The browser disconnected before answering.'));
  }
}

/**
 * Listen for the relay. Idempotent. A stale socket file left by a crashed run
 * is removed first — the caller holds the profile lock, so no live process can
 * own it.
 */
export function startBrowserBridge(socketPath: string): void {
  if (server) return;
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* no stale socket */
    }
  }
  server = net.createServer((socket) => {
    const conn: Connection = { socket, buffer: Buffer.alloc(0) };
    connections.push(conn);
    socket.on('data', (chunk) => onData(conn, chunk));
    socket.on('close', () => onClose(conn));
    socket.on('error', () => socket.destroy());
  });
  server.on('error', (err) => console.warn('[browser-bridge] socket error:', err));
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    console.log(`[browser-bridge] listening on ${socketPath}`);
  });
}

/** Ask the connected extension to do something. Rejects if none is connected. */
export function browserRequest<T = unknown>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const conn = activeConnection();
  if (!conn) {
    return Promise.reject(
      new Error('No browser is connected. Install the WorkspaceGPT Chrome extension, open WorkspaceGPT Desktop once, and keep it running.')
    );
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    pending.set(id, { conn, resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      send(conn, { type: 'request', id, method, params });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
