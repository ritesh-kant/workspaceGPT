/**
 * Loopback HTTP + WebSocket server: the desktop shell page, each webview view
 * it frames, their assets, and the bridge socket.
 *
 *   /                     the shell (sidebar + main pane), bridge/shell.html
 *   /view/<viewType>      that view's own HTML with the bridge injected
 *   /__desktop/ws?view=   one socket per view page
 *
 * Security (DESKTOP-TAURI-PLAN.md, Decision 3):
 *  - bound to 127.0.0.1 only, on a random port;
 *  - Host header must be our own loopback authority (blocks DNS rebinding);
 *  - the socket needs the per-launch token AND an allowed Origin, so another
 *    site open in the user's browser can't drive the agent even if it finds
 *    the port;
 *  - files are served only from the extension's own directory.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { ViewSurface } from './webviewHost';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface ServerOptions {
  port: number;
  token: string;
  /** Every view the shell can frame, by viewType. */
  surfaces: Map<string, ViewSurface>;
  /** Files served under /__desktop/ (shell.html, bridge.js, theme.css, …). */
  desktopAssetsDir: string;
  /** Extra Origins allowed to open the socket (Tauri's custom-protocol origins). */
  extraOrigins: string[];
  log?: (line: string) => void;
}

export interface DesktopServer {
  port: number;
  origin: string;
  close(): Promise<void>;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Put the bridge, theme and desktop skin ahead of everything, so
 * acquireVsCodeApi exists before the app's module script runs. The skin comes
 * before the view's own styles in source order and wins by specificity
 * (`html[data-wgpt-desktop] …`), which the bridge sets before first paint.
 */
function injectDesktop(html: string): string {
  const tags =
    `<link rel="stylesheet" href="/__desktop/theme.css">` +
    `<link rel="stylesheet" href="/__desktop/skin.css">` +
    `<script src="/__desktop/bridge.js"></script>`;
  const out = html.replace(/<head[^>]*>/i, (open) => `${open}${tags}`);
  return out === html ? tags + html : out;
}

export function startServer(opts: ServerOptions): Promise<DesktopServer> {
  let port = opts.port;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...opts.extraOrigins]);

  const server = http.createServer((req, res) => {
    if (!hosts().has(req.headers.host ?? '')) {
      res.writeHead(421).end('misdirected request');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const send = (status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
      res.end(body);
    };

    // Only our own shell may frame a view (and nothing may frame the shell).
    const pageHeaders = (ancestors: string) => ({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `frame-ancestors ${ancestors}`,
    });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      send(200, fs.readFileSync(path.join(opts.desktopAssetsDir, 'shell.html')), MIME['.html'], pageHeaders("'none'"));
      return;
    }

    if (url.pathname.startsWith('/view/')) {
      let viewId: string;
      try {
        viewId = decodeURIComponent(url.pathname.slice('/view/'.length));
      } catch {
        send(400, 'bad path');
        return;
      }
      const surface = opts.surfaces.get(viewId);
      if (!surface) {
        send(404, 'no such view');
        return;
      }
      if (!surface.html) {
        send(503, 'This view is still starting — reload in a moment.');
        return;
      }
      send(200, injectDesktop(surface.html), MIME['.html'], pageHeaders("'self'"));
      return;
    }

    if (url.pathname.startsWith('/__desktop/')) {
      const name = path.basename(url.pathname);
      const file = path.join(opts.desktopAssetsDir, name);
      if (!/^[\w.-]+$/.test(name) || !fs.existsSync(file)) {
        send(404, 'not found');
        return;
      }
      send(200, fs.readFileSync(file), MIME[path.extname(name)] ?? 'application/octet-stream', { 'Cache-Control': 'no-store' });
      return;
    }

    if (url.pathname.startsWith('/_res/')) {
      let fsPath: string;
      try {
        fsPath = decodeURIComponent(url.pathname.slice('/_res'.length));
      } catch {
        send(400, 'bad path');
        return;
      }
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(fsPath)) fsPath = fsPath.slice(1);
      if (![...opts.surfaces.values()].some((s) => s.isServableResource(fsPath)) || !fs.existsSync(fsPath) || !fs.statSync(fsPath).isFile()) {
        send(404, 'not found');
        return;
      }
      send(200, fs.readFileSync(fsPath), MIME[path.extname(fsPath).toLowerCase()] ?? 'application/octet-stream');
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    send(404, 'not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const origin = req.headers.origin ?? '';
    const reject = (code: number, why: string) => {
      opts.log?.(`[desktop] refused socket (${why}) from origin "${origin}"`);
      socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/__desktop/ws') return reject(404, 'Not Found');
    if (!hosts().has(req.headers.host ?? '')) return reject(421, 'Misdirected Request');
    if (!origins().has(origin)) return reject(403, 'Forbidden Origin');
    if (!tokenMatches(url.searchParams.get('t'), opts.token)) return reject(401, 'Unauthorized');
    const viewType = url.searchParams.get('view') ?? '';
    const surface = opts.surfaces.get(viewType);
    if (!surface) return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      opts.log?.(`[desktop] ${viewType} connected (${origin})`);
      surface.attach(ws);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            wss.clients.forEach((c) => c.terminate());
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
