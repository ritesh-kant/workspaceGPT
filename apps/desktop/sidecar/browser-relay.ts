/**
 * Native-messaging host for the WorkspaceGPT Chrome extension.
 *
 * Chrome starts a fresh copy of this every time the extension calls
 * `connectNative`, with the port on stdin/stdout. It is not the desktop app —
 * it only pipes those bytes into the socket the running sidecar listens on
 * (services/browser/browserBridge.ts), unchanged, so both ends keep speaking
 * Chrome's own length-prefixed framing and this file never parses anything.
 *
 *   node browser-relay.js <socket path> <chrome-extension://id/>
 *
 * If the desktop app is not running the connect fails, this exits, and the
 * extension sees a disconnect and tries again later.
 */
import * as net from 'node:net';

const socketPath = process.argv[2];
if (!socketPath) process.exit(2);

const socket = net.connect(socketPath);
socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
