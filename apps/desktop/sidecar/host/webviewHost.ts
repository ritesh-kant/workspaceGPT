/**
 * A webview view (the chat, or the Sessions list), with its iframe's host
 * channel replaced by a WebSocket.
 *
 * The extension's providers get a WebviewView exactly as in VS Code: they set
 * `webview.html` (via their own templates, CSP and all), subscribe to
 * `onDidReceiveMessage`, and call `postMessage`. Here those land on whichever
 * page is connected for that view — the desktop shell loads each view in its
 * own iframe at /view/<viewType>.
 *
 * One page owns a view at a time. A newer connection (reload, second tab)
 * takes over and the older one is closed with 4001 — two live chat UIs would
 * both write the session's history, which is the stale-webview overwrite bug.
 */
import type { WebSocket } from 'ws';
import * as path from 'node:path';
import { EventEmitter, Uri } from '../vscode-compat/types';
import type { DesktopUi, InputBoxRequest, QuickPickRequest, ShowMessageRequest } from '../vscode-compat/runtime';
import type { DiffAction, DiffFrame } from './diffPanel';

export const WS_CLOSE_SUPERSEDED = 4001;

/** Wire format. `msg` carries the extension's own messages verbatim. */
export type HostToPage =
  | { t: 'msg'; d: unknown }
  | { t: 'ui'; id: number; kind: 'message'; req: ShowMessageRequest }
  | { t: 'ui'; id: number; kind: 'quickpick'; req: QuickPickRequest }
  | { t: 'ui'; id: number; kind: 'inputbox'; req: InputBoxRequest }
  | { t: 'ui-cancel'; id: number }
  | { t: 'toolbar'; items: unknown[] }
  | DiffFrame;
export type PageToHost =
  | { t: 'msg'; d: unknown }
  | { t: 'ui-result'; id: number; value: unknown }
  | { t: 'command'; id: string }
  | { t: 'page-log'; level: 'error' | 'info'; text: string }
  | { t: 'diff-action'; file: string; action: DiffAction; idx?: number };

const MAX_QUEUED = 2000;
/** How long a question asked with no page connected waits for one. */
const ASK_WAIT_MS = 30_000;

export class ViewSurface {
  html = '';
  options: Record<string, unknown> = {};
  private socket: WebSocket | undefined;
  private queue: string[] = [];
  private readonly received = new EventEmitter<unknown>();
  private readonly visibility = new EventEmitter<void>();
  private readonly disposed = new EventEmitter<void>();
  /** A page connected — the host re-sends desktop chrome (title actions) to it. */
  readonly attached = new EventEmitter<void>();
  /** Every message the extension posts to this view, as posted (host/notifier.ts watches it). */
  readonly posted = new EventEmitter<unknown>();
  /** A window.show* question is being put to the user (its text). */
  readonly asked = new EventEmitter<string>();
  /** Title-bar button clicks from the page; the host decides which ids it honours. */
  readonly commandRequested = new EventEmitter<string>();
  /** A button on the diff review panel (host/diffPanel.ts). */
  readonly diffActionRequested = new EventEmitter<{ file: string; action: DiffAction; idx?: number }>();
  private uiSeq = 0;
  private pendingUi = new Map<number, (value: unknown) => void>();
  /** The `ui` frame behind each pending question, for a page that takes over. */
  private pendingUiFrames = new Map<number, string>();
  /**
   * Rewrites what the extension posts to this view before the page sees it —
   * the desktop's chance to present the same data differently without
   * touching the extension. Messages still arrive in the order posted.
   */
  outgoing?: (message: unknown) => unknown | Promise<unknown>;
  private outgoingChain: Promise<unknown> = Promise.resolve();
  /** Messages delivered each way, for the Diagnostics readout. */
  stats = { toPage: 0, fromPage: 0, dropped: 0 };

  /** `vscode.Webview`. */
  readonly webview;
  /** `vscode.WebviewView`. */
  readonly view;

  constructor(
    readonly viewType: string,
    private readonly origin: () => string,
    private readonly allowedRoots: () => string[]
  ) {
    // Accessors read through `self`: `this` inside an object-literal getter is the literal.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.webview = {
      get html(): string {
        return self.html;
      },
      set html(value: string) {
        self.html = value;
      },
      get options() {
        return self.options;
      },
      set options(value: Record<string, unknown>) {
        self.options = value;
      },
      get cspSource(): string {
        const o = self.origin();
        // http for assets, ws for the bridge socket — the template drops this
        // into every directive of its CSP, connect-src included.
        return `${o} ${o.replace(/^http/, 'ws')}`;
      },
      // encodeURI leaves ? and # alone; in an install path ("…/C#/…") they would end the URL's path.
      asWebviewUri: (uri: Uri) => Uri.parse(`${self.origin()}/_res${encodeURI(uri.path).replace(/[?#]/g, encodeURIComponent)}`),
      postMessage: (message: unknown) => {
        self.posted.fire(message);
        const rewrite = self.outgoing;
        if (!rewrite) return Promise.resolve(self.post({ t: 'msg', d: message }));
        const next = self.outgoingChain.then(async () => {
          let out = message;
          try {
            out = await rewrite(message);
          } catch (err) {
            console.warn(`[desktop] ${viewType}: rewriting an outgoing message failed, sending it as-is:`, err);
          }
          return self.post({ t: 'msg', d: out });
        });
        self.outgoingChain = next;
        return next;
      },
      onDidReceiveMessage: self.received.event,
    };
    this.view = {
      viewType,
      webview: this.webview,
      title: 'WorkspaceGPT' as string | undefined,
      description: undefined as string | undefined,
      badge: undefined as unknown,
      get visible(): boolean {
        return self.connected;
      },
      onDidChangeVisibility: self.visibility.event,
      onDidDispose: self.disposed.event,
      show: (_preserveFocus?: boolean) => undefined,
    };
  }

  get connected(): boolean {
    return !!this.socket && this.socket.readyState === 1;
  }

  isServableResource(fsPath: string): boolean {
    const resolved = path.resolve(fsPath);
    return this.allowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  private post(frame: HostToPage): boolean {
    const data = JSON.stringify(frame);
    if (this.connected) {
      this.socket!.send(data);
      this.stats.toPage++;
      return true;
    }
    // Nobody connected yet (startup) or between reloads: hold messages for the
    // next page rather than dropping them, as a VS Code webview queues them.
    if (frame.t === 'msg') {
      if (this.queue.length >= MAX_QUEUED) {
        this.queue.shift();
        this.stats.dropped++;
      }
      this.queue.push(data);
    }
    return false;
  }

  attach(socket: WebSocket): void {
    const previous = this.socket;
    this.socket = socket;
    if (previous && previous !== socket) {
      previous.close(WS_CLOSE_SUPERSEDED, 'superseded by a newer window');
    }
    socket.on('message', (raw) => this.onFrame(String(raw)));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Any dialog that page was showing is gone; resolve as "dismissed".
      for (const [, resolve] of this.pendingUi) resolve(undefined);
      this.pendingUi.clear();
      this.pendingUiFrames.clear();
      this.visibility.fire();
    });
    const queued = this.queue;
    this.queue = [];
    for (const data of queued) {
      socket.send(data);
      this.stats.toPage++;
    }
    // The superseded page's close handler bails (it is no longer this.socket),
    // so its open questions would never settle: ask them again here.
    for (const data of this.pendingUiFrames.values()) socket.send(data);
    this.attached.fire();
    this.visibility.fire();
  }

  /** Desktop-only frames (not extension messages): sent if connected, never queued. */
  sendControl(frame: HostToPage): void {
    if (this.connected) this.socket!.send(JSON.stringify(frame));
  }

  private onFrame(raw: string): void {
    let frame: PageToHost;
    try {
      frame = JSON.parse(raw);
    } catch {
      console.warn('[desktop] ignoring a non-JSON frame from the page');
      return;
    }
    if (frame.t === 'msg') {
      this.stats.fromPage++;
      this.received.fire(frame.d);
    } else if (frame.t === 'ui-result') {
      const resolve = this.pendingUi.get(frame.id);
      this.pendingUi.delete(frame.id);
      this.pendingUiFrames.delete(frame.id);
      resolve?.(frame.value);
    } else if (frame.t === 'command' && typeof frame.id === 'string') {
      this.commandRequested.fire(frame.id);
    } else if (frame.t === 'diff-action' && typeof frame.file === 'string' && typeof frame.action === 'string') {
      this.diffActionRequested.fire({ file: frame.file, action: frame.action, idx: frame.idx });
    } else if (frame.t === 'page-log' && typeof frame.text === 'string') {
      (frame.level === 'error' ? console.warn : console.log)(`[page ${this.viewType}] ${frame.text.slice(0, 2000)}`);
    }
  }

  /** The DesktopUi the compat module's window.show* calls use. */
  readonly ui: DesktopUi = {
    showMessage: (req) => {
      const tag = `[desktop:${req.severity}]`;
      console.log(tag, req.message);
      // A plain notification with no buttons resolves at once, like a VS Code
      // toast nobody clicks; only questions wait for an answer.
      if (!req.items.length && !req.modal) {
        this.sendUi('message', req);
        return Promise.resolve(undefined);
      }
      return this.ask('message', req) as Promise<string | undefined>;
    },
    showQuickPick: (req) => this.ask('quickpick', req) as Promise<number[] | undefined>,
    showInputBox: (req) => this.ask('inputbox', req) as Promise<string | undefined>,
  };

  private sendUi(kind: 'message' | 'quickpick' | 'inputbox', req: any): number {
    const id = ++this.uiSeq;
    if (this.connected) {
      this.socket!.send(JSON.stringify({ t: 'ui', id, kind, req }));
    }
    return id;
  }

  private async ask(kind: 'message' | 'quickpick' | 'inputbox', req: any): Promise<unknown> {
    this.asked.fire(String(req.message ?? req.title ?? req.prompt ?? req.placeHolder ?? 'A question is waiting'));
    // Questions asked during startup (e.g. "Confluence connection expired —
    // Reconnect?") would otherwise be lost: the extension activates before
    // the window connects. VS Code shows them regardless, so wait a little.
    if (!this.connected && !(await this.whenConnected(ASK_WAIT_MS))) {
      console.log(`[desktop] ${kind} asked with no window connected for ${ASK_WAIT_MS / 1000}s — treated as dismissed`);
      return undefined;
    }
    const id = this.sendUi(kind, req);
    this.pendingUiFrames.set(id, JSON.stringify({ t: 'ui', id, kind, req }));
    return new Promise((resolve) => this.pendingUi.set(id, resolve));
  }

  private whenConnected(timeoutMs: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(false);
      }, timeoutMs);
      const sub = this.attached.event(() => {
        clearTimeout(timer);
        sub.dispose();
        resolve(true);
      });
    });
  }

  dispose(): void {
    this.disposed.fire();
    this.socket?.close(1001, 'sidecar shutting down');
  }
}

export function createViewSurface(viewType: string, origin: () => string, allowedRoots: () => string[]): ViewSurface {
  return new ViewSurface(viewType, origin, allowedRoots);
}
