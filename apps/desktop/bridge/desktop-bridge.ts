/**
 * desktop-bridge — lets the unchanged VS Code webview bundle run in a browser
 * tab or the Tauri window.
 *
 * The webview talks to its host through exactly two things (webview/src/vscode.ts):
 * `window.acquireVsCodeApi().postMessage(msg)` out, and `message` events on
 * `window` in. This script provides both over a loopback WebSocket to the
 * sidecar — the same trick as webview/tools/preview.mjs, with a real host on
 * the other end instead of a mock.
 *
 * It also draws the few things VS Code would draw outside the webview:
 * notifications, modal questions, quick picks and input boxes that the
 * extension host asks for through `vscode.window.show*`.
 *
 * Each view runs in its own iframe of the desktop shell (bridge/shell.ts), at
 * /view/<viewType>, with its own socket. Embedded, the bridge also reports
 * every host message to the shell, which reads what it needs for its own
 * chrome (session title, account) — and hands the view's title-bar actions to
 * the shell's header instead of floating them over the view.
 *
 * Token: the Tauri shell injects `window.__WGPT_DESKTOP__ = { token }` with an
 * initialization script into the top frame; a framed view reads it from its
 * parent (same origin). Headless mode passes it in the URL fragment of the
 * shell page (never sent to any server), which keeps it in sessionStorage.
 */

import { MESSAGE_TYPES } from '../../vscode-extensions/constants';

interface DesktopConfig {
  token?: string;
  wsUrl?: string;
}

/** What the shell page exposes to the views it frames (bridge/shell.ts). */
export interface ShellHooks {
  token?: string;
  hostMessage(viewType: string, message: unknown): void;
  toolbar(viewType: string, items: unknown[]): void;
}

interface UiFrame {
  t: 'ui';
  id: number;
  kind: 'message' | 'quickpick' | 'inputbox';
  req: any;
}

(() => {
  const w = window as any;
  if (w.__WGPT_BRIDGE__) return;
  w.__WGPT_BRIDGE__ = true;

  const TOKEN_KEY = 'wgpt.desktop.token';
  const CHAT_VIEW = 'workspacegpt.chatView';
  const viewMatch = /^\/view\/([^/]+)$/.exec(location.pathname);
  const viewType = viewMatch ? decodeURIComponent(viewMatch[1]!) : CHAT_VIEW;
  // The chat keeps the key it had before views were framed, so its restored state survives.
  const STATE_KEY = viewType === CHAT_VIEW ? 'wgpt.desktop.webviewState' : `wgpt.desktop.webviewState:${viewType}`;

  let parentWin: any;
  try {
    // Reading a property throws if the parent is another origin; then we're not embedded.
    parentWin = window.parent !== window && window.parent.location.origin === location.origin ? window.parent : undefined;
  } catch {
    parentWin = undefined;
  }
  const shell = (): ShellHooks | undefined => parentWin?.__wgptShell;
  document.documentElement.setAttribute('data-wgpt-desktop', viewType === CHAT_VIEW ? 'chat' : viewType.replace(/^workspacegpt\./, '').replace(/View$/, ''));
  if (parentWin) document.documentElement.setAttribute('data-wgpt-embedded', '');

  const cfg: DesktopConfig = w.__WGPT_DESKTOP__ ?? parentWin?.__WGPT_DESKTOP__ ?? {};

  let token = cfg.token ?? shell()?.token;
  const fromHash = /(?:^#|&)t=([^&]+)/.exec(location.hash);
  if (fromHash) {
    token = decodeURIComponent(fromHash[1]!);
    history.replaceState(null, '', location.pathname + location.search);
  }
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    /* storage blocked: token lives for this page only */
  }

  const wsBase = cfg.wsUrl ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/__desktop/ws`;

  // ── Socket ──────────────────────────────────────────────────────────────

  /**
   * Hold host messages until the page can hear them. The chat asks for its
   * settings while its bundle is still evaluating, and only attaches the
   * listener that handles the answer when React's first effect runs — which
   * then posts `chat-webview-ready`. Over a loopback socket the answer can
   * land in between and be dropped, leaving the chat on its blank loading
   * screen for good. VS Code's slower channel hides that race; here the
   * bridge waits for the page's own ready signal instead. Views that attach
   * their listener synchronously (Sessions) aren't held.
   */
  const READY_SIGNAL: Record<string, string> = { [CHAT_VIEW]: MESSAGE_TYPES.CHAT_WEBVIEW_READY };
  const HOLD_LIMIT_MS = 15000;
  let held: unknown[] | undefined = READY_SIGNAL[viewType] ? [] : undefined;
  const release = () => {
    if (!held) return;
    const pending = held;
    held = undefined;
    for (const message of pending) deliver(message);
  };
  if (held) {
    setTimeout(() => {
      if (!held) return;
      send({ t: 'page-log', level: 'error', text: `no ${READY_SIGNAL[viewType]} after ${HOLD_LIMIT_MS / 1000}s — delivering ${held.length} held message(s) anyway` });
      release();
    }, HOLD_LIMIT_MS);
  }
  function deliver(message: unknown): void {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
    try {
      shell()?.hostMessage(viewType, message);
    } catch {
      /* the shell's chrome is best-effort; the view itself already has the message */
    }
  }

  let socket: WebSocket | undefined;
  let open = false;
  const outbox: string[] = [];
  let retry = 0;
  let stopped = false;

  function send(frame: unknown): void {
    const data = JSON.stringify(frame);
    if (open && socket) socket.send(data);
    else outbox.push(data);
  }

  function connect(): void {
    if (!token) {
      banner('No access token — open the link the sidecar printed (it ends in #t=…).', 'error');
      return;
    }
    socket = new WebSocket(`${wsBase}?t=${encodeURIComponent(token)}&view=${encodeURIComponent(viewType)}`);
    socket.onopen = () => {
      open = true;
      retry = 0;
      banner(null);
      for (const data of outbox.splice(0)) socket!.send(data);
    };
    socket.onmessage = (ev) => {
      let frame: any;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.t === 'msg') {
        if (held) held.push(frame.d);
        else deliver(frame.d);
      } else if (frame.t === 'ui') showUi(frame as UiFrame);
      else if (frame.t === 'toolbar') {
        const hooks = shell();
        if (hooks) hooks.toolbar(viewType, frame.items ?? []);
        else renderToolbar(frame.items ?? []);
      }
    };
    socket.onclose = (ev) => {
      open = false;
      if (ev.code === 4001) {
        stopped = true;
        banner('WorkspaceGPT is open in another window. Reload this one to take it back.', 'warning');
        return;
      }
      if (stopped) return;
      // 1006 on the very first attempt with a bad token looks the same as a
      // down server; the message says both.
      banner('Disconnected from WorkspaceGPT — reconnecting…', 'warning');
      const delay = Math.min(5000, 250 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  // Page errors go to the sidecar's log: in the Tauri window there is no
  // other place to see them. Capped so a render loop can't flood it.
  let reported = 0;
  const reportToHost = (text: string) => {
    if (reported++ < 50) send({ t: 'page-log', level: 'error', text: text.slice(0, 2000) });
  };
  window.addEventListener('error', (e) => reportToHost(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = (e as PromiseRejectionEvent).reason;
    reportToHost(`unhandled rejection: ${r?.stack ?? r?.message ?? String(r)}`);
  });

  // What the shell calls into: its header buttons run the same title actions.
  w.__wgptBridge = {
    viewType,
    command: (id: string) => send({ t: 'command', id }),
  };

  // ── acquireVsCodeApi ─────────────────────────────────────────────────────

  let acquired = false;
  w.acquireVsCodeApi = () => {
    if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
    acquired = true;
    return {
      postMessage: (message: unknown) => {
        send({ t: 'msg', d: message });
        // The page just attached its listener (see READY_SIGNAL); hand over
        // what arrived meanwhile, after the effect that posted this returns.
        if (held && (message as { type?: string } | null)?.type === READY_SIGNAL[viewType]) setTimeout(release, 0);
      },
      getState: () => {
        try {
          return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') ?? undefined;
        } catch {
          return undefined;
        }
      },
      setState: (state: unknown) => {
        try {
          localStorage.setItem(STATE_KEY, JSON.stringify(state));
        } catch {
          /* ignore */
        }
        return state;
      },
    };
  };

  // ── Chrome drawn outside the React app ──────────────────────────────────

  const css = `
  .wgpt-layer{position:fixed;inset:12px 12px auto auto;z-index:2147483646;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 24px));font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px)}
  .wgpt-toast{background:var(--wgpt-d-card,var(--vscode-editorWidget-background));color:var(--vscode-foreground);border:1px solid var(--wgpt-d-border,var(--vscode-widget-border));border-left:3px solid var(--wgpt-accent);border-radius:10px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.14)}
  .wgpt-toast .wgpt-detail,.wgpt-dialog .wgpt-detail{color:var(--vscode-descriptionForeground);margin-top:4px;white-space:pre-wrap}
  .wgpt-actions{display:flex;gap:6px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
  .wgpt-btn{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;border-radius:7px;padding:5px 12px;cursor:pointer;font:inherit}
  .wgpt-btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
  .wgpt-scrim{position:fixed;inset:0;background:rgba(0,0,0,.32);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
  .wgpt-dialog{width:min(520px,calc(100vw - 32px));background:var(--wgpt-d-card,var(--vscode-editorWidget-background));color:var(--vscode-foreground);border:1px solid var(--wgpt-d-border,var(--vscode-widget-border));border-radius:12px;padding:16px;box-shadow:0 16px 48px rgba(0,0,0,.22);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px)}
  .wgpt-dialog input{width:100%;box-sizing:border-box;margin-top:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-focusBorder));border-radius:8px;padding:7px 10px;font:inherit;outline:none}
  .wgpt-dialog input:focus{border-color:var(--vscode-focusBorder)}
  .wgpt-list{max-height:50vh;overflow:auto;margin-top:8px}
  .wgpt-item{padding:7px 10px;border-radius:7px;cursor:pointer}
  .wgpt-item:hover,.wgpt-item.active{background:var(--vscode-list-hoverBackground)}
  .wgpt-item small{color:var(--vscode-descriptionForeground);margin-left:6px}
  .wgpt-toolbar{position:fixed;top:6px;right:8px;z-index:2147483645;display:flex;gap:2px}
  .wgpt-tool{background:transparent;border:0;border-radius:4px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--vscode-icon-foreground);padding:0}
  .wgpt-tool:hover{background:var(--vscode-toolbar-hoverBackground)}
  .wgpt-tool img{width:16px;height:16px}
  .wgpt-banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:6px 12px;font-family:var(--vscode-font-family);font-size:12px;text-align:center;color:#fff}
  `;

  const accent: Record<string, string> = {
    info: 'var(--vscode-focusBorder)',
    warning: 'var(--vscode-editorWarning-foreground)',
    error: 'var(--vscode-editorError-foreground)',
  };

  let layer: HTMLElement | undefined;
  let bannerEl: HTMLElement | undefined;
  function ensureDom(): void {
    if (layer) return;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    layer = document.createElement('div');
    layer.className = 'wgpt-layer';
    document.body.appendChild(layer);
  }
  const whenBody = (fn: () => void) =>
    document.body ? fn() : document.addEventListener('DOMContentLoaded', fn, { once: true });

  function banner(text: string | null, level: 'warning' | 'error' = 'warning'): void {
    whenBody(() => {
      ensureDom();
      if (!text) {
        bannerEl?.remove();
        bannerEl = undefined;
        return;
      }
      bannerEl ??= document.body.appendChild(document.createElement('div'));
      bannerEl.className = 'wgpt-banner';
      bannerEl.style.background = level === 'error' ? '#b3261e' : '#8a6d00';
      bannerEl.textContent = text;
    });
  }

  const el = (tag: string, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // VS Code draws the view's title-bar actions (New Chat, History, Settings)
  // above the webview; the desktop has no workbench, so they float top-right.
  let toolbarEl: HTMLElement | undefined;
  let toolbarItems: { command: string; title: string; iconLight?: string; iconDark?: string }[] = [];
  function renderToolbar(items: typeof toolbarItems): void {
    toolbarItems = items;
    whenBody(() => {
      ensureDom();
      toolbarEl ??= document.body.appendChild(el('div', 'wgpt-toolbar'));
      toolbarEl.textContent = '';
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      for (const item of items) {
        const b = el('button', 'wgpt-tool') as HTMLButtonElement;
        b.title = item.title;
        b.setAttribute('aria-label', item.title);
        const icon = dark ? item.iconDark : item.iconLight;
        if (icon) {
          const img = el('img') as HTMLImageElement;
          img.src = icon;
          img.alt = '';
          b.appendChild(img);
        } else b.textContent = item.title;
        b.onclick = () => send({ t: 'command', id: item.command });
        toolbarEl.appendChild(b);
      }
    });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => renderToolbar(toolbarItems));

  function reply(id: number, value: unknown): void {
    send({ t: 'ui-result', id, value });
  }

  function showUi(frame: UiFrame): void {
    whenBody(() => {
      ensureDom();
      if (frame.kind === 'message') showMessage(frame);
      else if (frame.kind === 'quickpick') showQuickPick(frame);
      else showInputBox(frame);
    });
  }

  function showMessage({ id, req }: UiFrame): void {
    const items: string[] = req.items ?? [];
    if (req.modal) {
      const scrim = el('div', 'wgpt-scrim');
      const box = el('div', 'wgpt-dialog');
      box.appendChild(el('div', undefined, req.message));
      if (req.detail) box.appendChild(el('div', 'wgpt-detail', req.detail));
      const actions = el('div', 'wgpt-actions');
      const close = (value: string | undefined) => {
        scrim.remove();
        reply(id, value);
      };
      const cancel = el('button', 'wgpt-btn', 'Cancel');
      cancel.onclick = () => close(undefined);
      actions.appendChild(cancel);
      items.forEach((title, i) => {
        const b = el('button', `wgpt-btn${i === 0 ? ' primary' : ''}`, title);
        b.onclick = () => close(title);
        actions.appendChild(b);
      });
      box.appendChild(actions);
      scrim.appendChild(box);
      scrim.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Escape' && close(undefined));
      document.body.appendChild(scrim);
      (actions.lastElementChild as HTMLElement)?.focus();
      return;
    }
    const toast = el('div', 'wgpt-toast');
    toast.style.setProperty('--wgpt-accent', accent[req.severity] ?? accent.info!);
    toast.appendChild(el('div', undefined, req.message));
    if (req.detail) toast.appendChild(el('div', 'wgpt-detail', req.detail));
    const done = (value: string | undefined) => {
      toast.remove();
      if (items.length) reply(id, value);
    };
    const actions = el('div', 'wgpt-actions');
    items.forEach((title) => {
      const b = el('button', 'wgpt-btn primary', title);
      b.onclick = () => done(title);
      actions.appendChild(b);
    });
    const dismiss = el('button', 'wgpt-btn', items.length ? 'Dismiss' : '✕');
    dismiss.onclick = () => done(undefined);
    actions.appendChild(dismiss);
    toast.appendChild(actions);
    layer!.appendChild(toast);
    if (!items.length) setTimeout(() => toast.remove(), 8000);
  }

  function showQuickPick({ id, req }: UiFrame): void {
    const scrim = el('div', 'wgpt-scrim');
    const box = el('div', 'wgpt-dialog');
    if (req.title) box.appendChild(el('div', undefined, req.title));
    const filter = el('input') as HTMLInputElement;
    filter.placeholder = req.placeHolder ?? 'Type to filter';
    box.appendChild(filter);
    const list = el('div', 'wgpt-list');
    box.appendChild(list);
    const close = (value: number[] | undefined) => {
      scrim.remove();
      reply(id, value);
    };
    const render = () => {
      list.textContent = '';
      const q = filter.value.toLowerCase();
      (req.items as { label: string; description?: string; detail?: string }[]).forEach((item, i) => {
        if (q && !`${item.label} ${item.description ?? ''} ${item.detail ?? ''}`.toLowerCase().includes(q)) return;
        const row = el('div', 'wgpt-item', item.label);
        if (item.description) row.appendChild(el('small', undefined, item.description));
        if (item.detail) row.appendChild(el('div', 'wgpt-detail', item.detail));
        row.onclick = () => close([i]);
        list.appendChild(row);
      });
    };
    filter.oninput = render;
    filter.onkeydown = (e) => {
      if (e.key === 'Escape') close(undefined);
      if (e.key === 'Enter') (list.firstElementChild as HTMLElement | null)?.click();
    };
    render();
    scrim.onclick = (e) => e.target === scrim && close(undefined);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    filter.focus();
  }

  function showInputBox({ id, req }: UiFrame): void {
    const scrim = el('div', 'wgpt-scrim');
    const box = el('div', 'wgpt-dialog');
    if (req.title) box.appendChild(el('div', undefined, req.title));
    if (req.prompt) box.appendChild(el('div', 'wgpt-detail', req.prompt));
    const input = el('input') as HTMLInputElement;
    input.type = req.password ? 'password' : 'text';
    input.value = req.value ?? '';
    input.placeholder = req.placeHolder ?? '';
    box.appendChild(input);
    const close = (value: string | undefined) => {
      scrim.remove();
      reply(id, value);
    };
    const actions = el('div', 'wgpt-actions');
    const cancel = el('button', 'wgpt-btn', 'Cancel');
    cancel.onclick = () => close(undefined);
    const ok = el('button', 'wgpt-btn primary', 'OK');
    ok.onclick = () => close(input.value);
    actions.append(cancel, ok);
    box.appendChild(actions);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close(undefined);
    };
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    input.focus();
    input.select();
  }

  // A restarted sidecar prints a new link; pasting it into this tab changes
  // only the fragment, which doesn't reload the page. Take the new token.
  // (Framed views never see a fragment; the shell handles it for them.)
  if (!parentWin) window.addEventListener('hashchange', () => {
    const m = /(?:^#|&)t=([^&]+)/.exec(location.hash);
    if (!m) return;
    token = decodeURIComponent(m[1]!);
    history.replaceState(null, '', location.pathname + location.search);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore */
    }
    // The React app holds state from the old host; start it clean against the new one.
    location.reload();
  });

  connect();
})();
