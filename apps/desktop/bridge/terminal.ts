/**
 * The shell page's terminal panel: tabs of xterm.js views over the sidecar's
 * PTYs (sidecar/host/terminalHost.ts), on a socket of their own. It draws and
 * forwards keystrokes; what a shell does is the sidecar's.
 *
 * Tab ids are kept in sessionStorage, so reloading the page re-attaches to the
 * same shells (the sidecar replays their scrollback) instead of starting new ones.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

type ToPage =
  | { t: 'out'; id: string; d: string }
  | { t: 'exit'; id: string; code: number | null }
  | { t: 'error'; id: string; message: string };

interface Tab {
  id: string;
  label: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  button: HTMLElement;
  ended: boolean;
}

export interface TerminalPanelOptions {
  getToken: () => string | undefined;
  app: HTMLElement;
  panel: HTMLElement;
  toggle: HTMLElement;
}

const TABS_KEY = 'wgpt.desktop.terminals';
const OPEN_KEY = 'wgpt.desktop.terminalOpen';

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `t${Date.now()}${Math.random().toString(36).slice(2)}`);

export function initTerminalPanel(o: TerminalPanelOptions): { run(command: string): void } {
  const { app, panel, toggle } = o;
  const tabsEl = panel.querySelector<HTMLElement>('.term-tabs')!;
  const bodyEl = panel.querySelector<HTMLElement>('.term-body')!;
  const addBtn = panel.querySelector<HTMLElement>('.term-add')!;
  const maxBtn = panel.querySelector<HTMLElement>('.term-max')!;
  const closeBtn = panel.querySelector<HTMLElement>('.term-close')!;
  const emptyEl = panel.querySelector<HTMLElement>('.term-empty')!;

  const tabs = new Map<string, Tab>();
  let active: string | undefined;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let counter = 0;
  let restored = false;
  let saved: { id: string; label: string }[] = [];

  const read = (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const write = (k: string, v: string) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* storage blocked: tabs just don't survive a reload */
    }
  };
  const persist = () => write(TABS_KEY, JSON.stringify([...tabs.values()].filter((t) => !t.ended).map((t) => ({ id: t.id, label: t.label }))));

  const send = (frame: object) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  const theme = () => ({
    background: css('--wgpt-d-bg', '#1e1e1e'),
    foreground: css('--wgpt-d-fg', '#d4d4d4'),
    cursor: css('--wgpt-d-fg', '#d4d4d4'),
    selectionBackground: css('--wgpt-d-hover', 'rgba(128,128,128,0.35)'),
  });

  function connect(): void {
    const token = o.getToken();
    if (!token || socket) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/__desktop/term?t=${encodeURIComponent(token)}`);
    socket = ws;
    ws.onopen = () => {
      // (Re)open every tab: the sidecar replays a live shell's scrollback.
      for (const t of tabs.values()) {
        if (!t.ended) {
          t.term.reset();
          send({ t: 'open', id: t.id, cols: t.term.cols, rows: t.term.rows });
        }
      }
    };
    ws.onmessage = (ev) => {
      let f: ToPage;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const tab = tabs.get(f.id);
      if (!tab) return;
      if (f.t === 'out') tab.term.write(f.d);
      else if (f.t === 'exit') {
        tab.ended = true;
        tab.button.classList.add('ended');
        tab.term.write(`\r\n\x1b[2m[process exited${f.code ? ` with code ${f.code}` : ''}]\x1b[0m\r\n`);
        persist();
      } else if (f.t === 'error') {
        tab.ended = true;
        tab.term.write(`\x1b[31m${f.message}\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = undefined;
      // A sidecar restart drops the socket; its shells died with it, so the
      // reconnect starts fresh shells in the same tabs.
      if (panelOpen()) {
        clearTimeout(retry);
        retry = setTimeout(connect, 1500);
      }
    };
  }

  const panelOpen = () => !panel.hidden;

  function addTab(id = newId(), label = `Terminal ${++counter}`): void {
    const host = document.createElement('div');
    host.className = 'term-view';
    bodyEl.appendChild(host);
    const term = new Terminal({
      fontFamily: css('--vscode-editor-font-family', 'ui-monospace, Menlo, Consolas, monospace'),
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'term-tab';
    const name = document.createElement('span');
    name.textContent = label;
    const x = document.createElement('span');
    x.className = 'term-tab-x';
    x.textContent = '×';
    x.title = 'Close terminal';
    button.append(name, x);
    tabsEl.appendChild(button);
    const tab: Tab = { id, label, term, fit, host, button, ended: false };
    tabs.set(id, tab);
    term.onData((d) => send({ t: 'in', id, d }));
    term.onResize(({ cols, rows }) => send({ t: 'resize', id, cols, rows }));
    button.onclick = (e) => (e.target === x ? closeTab(id) : select(id));
    select(id);
    persist();
    send({ t: 'open', id, cols: term.cols, rows: term.rows });
  }

  function select(id: string): void {
    active = id;
    for (const t of tabs.values()) {
      const on = t.id === id;
      t.host.hidden = !on;
      t.button.classList.toggle('active', on);
    }
    emptyEl.hidden = tabs.size > 0;
    refit();
    tabs.get(id)?.term.focus();
  }

  function closeTab(id: string): void {
    const t = tabs.get(id);
    if (!t) return;
    send({ t: 'close', id });
    t.term.dispose();
    t.host.remove();
    t.button.remove();
    tabs.delete(id);
    persist();
    const next = [...tabs.keys()].pop();
    if (next) select(next);
    else {
      active = undefined;
      emptyEl.hidden = false;
      setOpen(false);
    }
  }

  function refit(): void {
    const t = active ? tabs.get(active) : undefined;
    if (!t || !panelOpen()) return;
    // Hidden or zero-sized hosts make fit() throw or return 0 cols.
    requestAnimationFrame(() => {
      try {
        if (t.host.clientWidth > 0 && t.host.clientHeight > 0) {
          t.fit.fit();
          // A tab restored while the panel was hidden was laid out at zero size;
          // fit() is a no-op when the grid matches, so repaint explicitly.
          t.term.refresh(0, t.term.rows - 1);
        }
      } catch {
        /* not laid out yet */
      }
    });
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    app.classList.toggle('term-open', open);
    if (!open) app.classList.remove('term-max');
    toggle.classList.toggle('active', open);
    write(OPEN_KEY, open ? '1' : '0');
    if (open) {
      connect();
      // xterm measures its cells when it opens, which a hidden host cannot give
      // it — so restored tabs are created now, with the panel on screen.
      if (!restored) {
        restored = true;
        for (const s of saved) addTab(s.id, s.label);
      }
      if (tabs.size === 0) addTab();
      else refit();
      if (active) tabs.get(active)?.term.focus();
    }
  }

  addBtn.onclick = () => addTab();
  maxBtn.onclick = () => {
    app.classList.toggle('term-max');
    refit();
  };
  // Closing the panel keeps the shells running; closing a tab ends its shell.
  closeBtn.onclick = () => setOpen(false);
  toggle.onclick = () => setOpen(!panelOpen());
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '`') {
      e.preventDefault();
      setOpen(!panelOpen());
    }
  });
  new ResizeObserver(refit).observe(bodyEl);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    for (const t of tabs.values()) t.term.options.theme = theme();
  });

  // The tabs the last page had; the sidecar re-attaches them when the panel first opens.
  try {
    const parsed = JSON.parse(read(TABS_KEY) ?? '[]');
    if (Array.isArray(parsed)) saved = parsed.filter((s) => s && typeof s.id === 'string' && typeof s.label === 'string');
  } catch {
    /* ignore a corrupt value */
  }
  counter = saved.length;
  if (read(OPEN_KEY) === '1') setOpen(true);

  /** Types a command into the active shell (opening the panel/tab if needed) and presses Enter. */
  return {
    run(command) {
      if (!panelOpen()) setOpen(true);
      else if (tabs.size === 0) addTab();
      const t = active ? tabs.get(active) : undefined;
      if (!t || t.ended) {
        addTab();
      }
      const id = active;
      if (!id) return;
      // A fresh shell may still be starting; the PTY buffers input until it reads.
      send({ t: 'in', id, d: command.replace(/\r?\n/g, '\r') + '\r' });
      tabs.get(id)?.term.focus();
    },
  };
}
