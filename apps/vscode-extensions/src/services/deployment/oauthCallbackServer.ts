import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';

/**
 * Shared loopback-callback helper for browser-based connect flows (GitHub App
 * install, Vercel OAuth). Mirrors the mechanism in ConfluenceAuthService, but
 * provider-agnostic: it opens a URL, waits for the redirect to a local
 * `127.0.0.1:<port><path>`, validates `state`, and hands back the full set of
 * query params (so callers can read `code`, `installation_id`, etc.).
 */
export interface CallbackResult {
  params: URLSearchParams;
}

export interface WaitForCallbackOptions {
  port: number;
  path: string;
  /** CSRF token echoed back via `?state=`; validated if provided. */
  state?: string;
  /** Builds the URL to open in the browser (usually from `state`). */
  buildAuthUrl: () => string;
  /** Overall timeout; defaults to 5 minutes. */
  timeoutMs?: number;
}

export class OAuthCallbackServer {
  private server: http.Server | null = null;
  private pendingReject: ((reason?: unknown) => void) | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  static generateState(): string {
    const array = new Uint8Array(32);
    crypto.randomFillSync(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Open the browser, wait for the loopback redirect, return its query params. */
  waitForCallback(opts: WaitForCallbackOptions): Promise<CallbackResult> {
    const { port, path, state, buildAuthUrl } = opts;
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

    return new Promise<CallbackResult>((resolve, reject) => {
      this.timeout = setTimeout(() => {
        this.cleanup();
        reject(new Error('Authorization timed out. Please try again.'));
      }, timeoutMs);

      this.pendingReject = reject;

      const finish = (fn: () => void) => {
        this.cleanup();
        fn();
      };

      this.server = http.createServer((req, res) => {
        if (req.method && req.method !== 'GET') {
          res.writeHead(405);
          res.end();
          return;
        }
        const url = new URL(req.url || '', `http://127.0.0.1:${port}`);
        if (url.pathname !== path) {
          res.writeHead(404);
          res.end();
          return;
        }

        const params = url.searchParams;
        const error = params.get('error');
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.errorHtml(params.get('error_description') || error));
          finish(() => reject(new Error(`Authorization error: ${error}`)));
          return;
        }

        if (state && params.get('state') !== state) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.errorHtml('State mismatch — possible CSRF.'));
          finish(() => reject(new Error('OAuth state mismatch. Please try again.')));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.successHtml());
        finish(() => resolve({ params }));
      });

      // Open the browser only once the socket is actually bound.
      this.server.on('listening', () => {
        vscode.env.openExternal(vscode.Uri.parse(buildAuthUrl()));
      });

      // A prior, not-yet-released callback server may still hold the port for a
      // moment (e.g. a re-click after closing the browser tab). Retry the bind a
      // few times before giving up with an actionable message.
      const maxBindAttempts = 5;
      const bindRetryDelayMs = 300;
      let bindAttempts = 0;

      const attemptListen = () => {
        bindAttempts++;
        this.server!.listen(port, '127.0.0.1');
      };

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && bindAttempts < maxBindAttempts) {
          setTimeout(attemptListen, bindRetryDelayMs);
          return;
        }
        const message =
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use. Another connect attempt may still be open — close any leftover "WorkspaceGPT — Connected" browser tab, wait a few seconds, and try again. If it persists, find the process with \`lsof -i :${port}\`.`
            : `Failed to start callback server: ${err.message}`;
        finish(() => reject(new Error(message)));
      });

      attemptListen();
    });
  }

  /** Abort a pending flow (e.g. user cancelled). */
  cancel(): void {
    if (this.pendingReject) {
      this.pendingReject(new Error('Authorization cancelled.'));
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.pendingReject = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private successHtml(): string {
    return this.page('✅', 'Connected!', 'You can close this tab and return to VS Code.', '#4ecca3');
  }

  private errorHtml(message: string): string {
    return this.page('❌', 'Connection failed', message, '#e74c3c');
  }

  private page(icon: string, title: string, body: string, color: string): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WorkspaceGPT</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 40px; background: #16213e; border-radius: 16px;">
    <div style="font-size: 64px; margin-bottom: 16px;">${escapeHtml(icon)}</div>
    <h1 style="color: ${escapeHtml(color)}; margin-bottom: 8px;">${escapeHtml(title)}</h1>
    <p style="color: #a0a0a0;">${escapeHtml(body)}</p>
  </div>
</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
