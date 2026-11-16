/**
 * The work-brief icon overlay's page (cue.html). Talks only to the sidecar's
 * /__desktop/cue socket (host/cueHost.ts); asks the shell to grow or shrink
 * its window through a private navigation the shell cancels
 * (workspacegpt://cue/expand | collapse), the same no-IPC signal the main
 * window uses for refresh-layout.
 */
type Status = {
  state: 'empty' | 'building' | 'ready';
  builtAt?: number;
  windowDays: number;
  counts: Record<string, number>;
  notes: string[];
  error?: string;
};
type Result = { ok: boolean; answer: string; spoken: string; sources: { tag: string; title: string; url?: string }[]; ms: number };

const w = window as unknown as { __WGPT_DESKTOP__?: { token: string } };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const body = document.body;
const icon = $<HTMLButtonElement>('icon');
const statusLine = $<HTMLParagraphElement>('status');
const form = $<HTMLFormElement>('form');
const q = $<HTMLTextAreaElement>('q');
const send = $<HTMLButtonElement>('send');
const answer = $<HTMLDivElement>('answer');
const sources = $<HTMLDivElement>('sources');

let ws: WebSocket | undefined;
let seq = 0;
let pending: number | undefined;
let lastStatus: Status | undefined;

/** The shell resizes the window; the page only switches which part it draws. */
function setView(view: 'icon' | 'panel') {
  if (body.dataset.view === view) return;
  body.dataset.view = view;
  // Same-window navigation to a scheme the shell intercepts and cancels.
  location.assign(`workspacegpt://cue/${view === 'panel' ? 'expand' : 'collapse'}`);
  if (view === 'panel') setTimeout(() => q.focus(), 60);
}

const SOURCE_NAMES: Record<string, [string, string]> = {
  ado: ['ticket', 'tickets'], jira: ['issue', 'issues'], confluence: ['page', 'pages'], pr: ['PR', 'PRs'], call: ['call', 'calls'],
};
const counted = (k: string, n: number) => `${n} ${SOURCE_NAMES[k]?.[n === 1 ? 0 : 1] ?? k}`;

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function renderStatus(s: Status) {
  lastStatus = s;
  body.dataset.state = s.error && s.state !== 'building' ? 'error' : s.state;
  const counts = Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => counted(k, n)).join(' · ');
  const text =
    s.state === 'building' ? `Building your brief from the last ${s.windowDays} days…`
      : s.state === 'empty' ? (s.error ? `Could not build: ${s.error}` : `No brief yet. Ask a question to build it (last ${s.windowDays} days).`)
        : `${counts || 'No items'} · built ${s.builtAt ? ago(s.builtAt) : ''}${s.notes.length ? ` · ${s.notes.length} source${s.notes.length > 1 ? 's' : ''} not read` : ''}`;
  statusLine.textContent = text;
  statusLine.title = s.notes.join('\n');
  icon.title = s.state === 'ready' ? `Ask about my work (${counts})` : 'Ask about my work';
}

function renderResult(r: Result) {
  answer.classList.toggle('muted', !r.ok);
  answer.textContent = r.answer;
  sources.replaceChildren(...r.sources.map((s) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = s.tag;
    chip.title = s.title;
    chip.disabled = !s.url;
    chip.addEventListener('click', () => s.url && ws?.send(JSON.stringify({ t: 'open', url: s.url })));
    return chip;
  }));
}

// Headless (no shell): the token rides in the fragment, as on the shell page.
const fromHash = /(?:^#|&)t=([^&]+)/.exec(location.hash);
const hashToken = fromHash ? decodeURIComponent(fromHash[1]!) : undefined;
if (fromHash) history.replaceState(null, '', location.pathname + location.search);

function connect() {
  const token = w.__WGPT_DESKTOP__?.token ?? hashToken;
  if (!token) {
    statusLine.textContent = 'Open WorkspaceGPT to use this.';
    return;
  }
  const sock = new WebSocket(`ws://${location.host}/__desktop/cue?t=${encodeURIComponent(token)}`);
  ws = sock;
  sock.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.t === 'status') renderStatus(msg.status);
    else if (msg.t === 'answer' && msg.id === pending) {
      pending = undefined;
      send.disabled = false;
      renderResult(msg.result);
    } else if (msg.t === 'error' && (msg.id === undefined || msg.id === pending)) {
      if (msg.id !== undefined) {
        pending = undefined;
        send.disabled = false;
      }
      renderResult({ ok: false, answer: msg.message, spoken: '', sources: [], ms: 0 });
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = undefined;
    if (pending !== undefined) {
      pending = undefined;
      send.disabled = false;
      renderResult({ ok: false, answer: 'WorkspaceGPT restarted. Ask again.', spoken: '', sources: [], ms: 0 });
    }
    setTimeout(connect, 2000);
  };
}

// The icon is both a button and a handle: a press that moves a few pixels
// starts a native window drag (the same start_dragging command
// data-tauri-drag-region uses, allowed by capabilities/window-drag.json);
// a press that doesn't is a click. A drag region on the icon itself would
// start dragging on mousedown and swallow every click.
const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke(cmd: string): Promise<unknown> } }).__TAURI_INTERNALS__;
let press: { x: number; y: number } | undefined;
let dragged = false;
icon.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  dragged = false;
});
document.addEventListener('mousemove', (e) => {
  if (!press || !(e.buttons & 1) || dragged) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 4) return;
  dragged = true;
  press = undefined;
  void tauri?.invoke('plugin:window|start_dragging').catch(() => undefined);
});
document.addEventListener('mouseup', () => {
  press = undefined;
});

icon.addEventListener('click', () => {
  // The end of a drag can still arrive as a click; it must not open the panel.
  if (dragged) {
    dragged = false;
    return;
  }
  setView('panel');
  ws?.send(JSON.stringify({ t: 'status' }));
});
$('close').addEventListener('click', () => setView('icon'));
$('refresh').addEventListener('click', () => ws?.send(JSON.stringify({ t: 'refresh' })));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setView('icon');
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = q.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN || pending !== undefined) return;
  pending = ++seq;
  send.disabled = true;
  sources.replaceChildren();
  answer.classList.add('muted');
  answer.textContent = lastStatus?.state === 'ready' ? 'Thinking…' : 'Building your brief first. This takes a minute the first time…';
  ws.send(JSON.stringify({ t: 'ask', id: pending, q: text }));
});

connect();
