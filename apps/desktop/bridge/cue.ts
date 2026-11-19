/**
 * The work-brief icon overlay's page (cue.html). Talks only to the sidecar's
 * /__desktop/cue socket (host/cueHost.ts); asks the shell to grow or shrink
 * its window through a private navigation the shell cancels
 * (workspacegpt://cue/expand | collapse), the same no-IPC signal the main
 * window uses for refresh-layout.
 *
 * The panel is a short conversation: each question goes with the earlier
 * turns, so a follow-up ("and the second one?") knows what it refers to.
 * The conversation lives only in this page; New conversation clears it.
 */
type Status = {
  state: 'empty' | 'building' | 'ready';
  builtAt?: number;
  windowDays: number;
  counts: Record<string, number>;
  notes: string[];
  error?: string;
};
type Source = { tag: string; label?: string; title: string; source?: string; url?: string };
type Result = { ok: boolean; answer: string; spoken: string; sources: Source[]; parts?: Array<string | number>; ms: number };
type Turn = { q: string; a: string };

const w = window as unknown as { __WGPT_DESKTOP__?: { token: string } };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const body = document.body;
const icon = $<HTMLButtonElement>('icon');
const statusLine = $<HTMLSpanElement>('status');
const form = $<HTMLFormElement>('form');
const q = $<HTMLTextAreaElement>('q');
const send = $<HTMLButtonElement>('send');
const thread = $<HTMLDivElement>('thread');
const empty = $<HTMLDivElement>('empty');
const newChat = $<HTMLButtonElement>('newChat');
const iconImg = $<HTMLImageElement>('iconImg');

let ws: WebSocket | undefined;
let seq = 0;
let pending: { id: number; q: string; el: HTMLDivElement } | undefined;
let lastStatus: Status | undefined;
/** Call notes is recording a call (host/cueHost.ts). */
let listening = false;
/** Answered turns of this conversation, sent with each follow-up. */
let turns: Turn[] = [];

/**
 * The icon shows what the brief is doing: thinking while it builds or
 * answers, listening while call notes records a call, ready otherwise
 * (bridge/cue-*.svg, made by scripts/cue-icons.py).
 */
function updateIcon() {
  const busy = pending !== undefined || lastStatus?.state === 'building';
  const src = `/__desktop/cue-${busy ? 'thinking' : listening ? 'listening' : 'ready'}.svg`;
  if (!iconImg.src.endsWith(src)) iconImg.src = src;
}

/** The shell resizes the window; the page only switches which part it draws. */
function setView(view: 'icon' | 'panel') {
  if (body.dataset.view === view) return;
  body.dataset.view = view;
  // Same-window navigation to a scheme the shell intercepts and cancels.
  location.assign(`workspacegpt://cue/${view === 'panel' ? 'expand' : 'collapse'}`);
  if (view === 'panel') {
    syncComposer();
    setTimeout(() => q.focus(), 60);
  }
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
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
  statusLine.textContent =
    s.state === 'building' ? `Reading the last ${s.windowDays} days of your work…`
      : s.state === 'empty' ? (s.error ? `Could not read your work: ${s.error}` : 'Ready to read your work on the first question')
        : `Knows ${total} items · updated ${s.builtAt ? ago(s.builtAt) : ''}${s.notes.length ? ' · some sources not read' : ''}`;
  // The detail stays one hover away.
  statusLine.title = [counts, ...s.notes].filter(Boolean).join('\n');
  icon.title = s.state === 'ready' ? `Ask about my work (${counts}) · drag to move` : 'Ask about my work (drag to move)';
  updateIcon();
}

function scrollDown() {
  thread.scrollTop = thread.scrollHeight;
}

function addUser(text: string) {
  empty.hidden = true;
  newChat.hidden = false;
  const el = document.createElement('div');
  el.className = 'msg user';
  el.textContent = text;
  thread.append(el);
  scrollDown();
}

function addThinking(firstBuild: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'msg bot';
  const dots = document.createElement('span');
  dots.className = 'typing';
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  el.append(dots);
  if (firstBuild) {
    const note = document.createElement('span');
    note.className = 'typing-note';
    note.textContent = 'Reading your work first. The first time takes a minute.';
    el.append(note);
  }
  thread.append(el);
  scrollDown();
  return el;
}

function open(s: Source) {
  if (s.url) ws?.send(JSON.stringify({ t: 'open', url: s.url }));
}

/** An answer: text with numbered citation markers, then one chip per source. */
function fillAnswer(el: HTMLDivElement, r: Result) {
  el.replaceChildren();
  el.classList.toggle('muted', !r.ok);
  const text = document.createElement('div');
  text.className = 'text';
  // The answer's only markup: a **bold** first line, "- " bullets and **bold**
  // words (brief.ts asks for that shape). Built as DOM nodes, never innerHTML.
  let line: HTMLElement | undefined;
  let list: HTMLUListElement | undefined;
  let last: HTMLElement = text;
  const startLine = (raw: string): string => {
    const bullet = /^\s*[-*•]\s+/.exec(raw);
    if (bullet) {
      if (!list) {
        list = document.createElement('ul');
        text.append(list);
      }
      line = document.createElement('li');
      list.append(line);
      return raw.slice(bullet[0].length);
    }
    list = undefined;
    line = document.createElement('p');
    if (/^\s*\*\*/.test(raw) && !text.childElementCount) line.className = 'lead';
    text.append(line);
    return raw;
  };
  const inline = (into: HTMLElement, raw: string) => {
    raw.split(/\*\*(.+?)\*\*/).forEach((bit, i) => {
      if (!bit) return;
      if (i % 2) {
        const b = document.createElement('strong');
        b.textContent = bit;
        into.append(b);
      } else into.append(bit.replace(/\*\*/g, ''));
    });
  };
  // Older hosts send no parts: show the answer as it came.
  for (const part of r.parts ?? [r.answer]) {
    if (typeof part === 'string') {
      part.split('\n').forEach((seg, i) => {
        if (i > 0) line = undefined;
        if (!line) {
          if (!seg.trim()) return;
          seg = startLine(seg);
        }
        inline(line!, seg);
        last = line!;
      });
      continue;
    }
    const s = r.sources[part];
    if (!s) continue;
    const cite = document.createElement('span');
    cite.className = 'cite';
    cite.textContent = String(part + 1);
    cite.title = `${s.label ?? s.tag}: ${s.title}`;
    cite.addEventListener('click', () => open(s));
    // A citation on a line of its own belongs to the line above it.
    (line ?? last).append(cite);
  }
  el.append(text);
  if (r.sources.length) {
    const srcs = document.createElement('div');
    srcs.className = 'srcs';
    r.sources.forEach((s, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.disabled = !s.url;
      chip.title = s.url ? `${s.title}\nOpen in browser` : s.title;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(i + 1);
      const l = document.createElement('span');
      l.className = 'l';
      // Pages and calls read better by their title than by an id.
      l.textContent = s.source === 'confluence' || s.source === 'call' || !s.label ? (s.label && s.source === 'call' ? s.label : s.title) : `${s.label} · ${s.title}`;
      chip.append(n, l);
      chip.addEventListener('click', () => open(s));
      srcs.append(chip);
    });
    el.append(srcs);
  }
  if (r.ok) {
    const tools = document.createElement('div');
    tools.className = 'tools';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn-ghost';
    copy.title = 'Copy answer';
    copy.setAttribute('aria-label', 'Copy answer');
    copy.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" stroke="currentColor" stroke-width="1.8"/></svg>';
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(r.spoken || r.answer).catch(() => undefined));
    tools.append(copy);
    el.append(tools);
  }
  scrollDown();
}

function finish(r: Result) {
  if (!pending) return;
  const { q: asked, el } = pending;
  pending = undefined;
  fillAnswer(el, r);
  if (r.ok) turns.push({ q: asked, a: r.spoken || r.answer });
  syncComposer();
  updateIcon();
}

function syncComposer() {
  send.disabled = pending !== undefined || !q.value.trim();
  q.placeholder = turns.length ? 'Ask a follow-up…' : 'Ask about your work…';
  // Grow with the text, up to the CSS max-height. While the panel is hidden
  // there is nothing to measure; opening it calls this again.
  q.style.height = 'auto';
  if (q.scrollHeight) q.style.height = `${q.scrollHeight}px`;
}

function ask(text: string) {
  if (!text || !ws || ws.readyState !== WebSocket.OPEN || pending !== undefined) return;
  addUser(text);
  const el = addThinking(lastStatus?.state !== 'ready');
  pending = { id: ++seq, q: text, el };
  ws.send(JSON.stringify({ t: 'ask', id: pending.id, q: text, history: turns.slice(-6) }));
  q.value = '';
  syncComposer();
  updateIcon();
}

function newConversation() {
  if (pending) return;
  turns = [];
  thread.querySelectorAll('.msg').forEach((m) => m.remove());
  empty.hidden = false;
  newChat.hidden = true;
  syncComposer();
  q.focus();
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
    else if (msg.t === 'listening') {
      listening = !!msg.on;
      updateIcon();
    } else if (msg.t === 'answer' && msg.id === pending?.id) finish(msg.result);
    else if (msg.t === 'error' && msg.id !== undefined && msg.id === pending?.id) {
      finish({ ok: false, answer: msg.message, spoken: '', sources: [], ms: 0 });
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = undefined;
    finish({ ok: false, answer: 'WorkspaceGPT restarted. Ask again.', spoken: '', sources: [], ms: 0 });
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
newChat.addEventListener('click', newConversation);
for (const b of document.querySelectorAll<HTMLButtonElement>('.suggestion')) {
  b.addEventListener('click', () => ask(b.textContent ?? ''));
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setView('icon');
});
q.addEventListener('input', syncComposer);
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(q.value.trim());
});

// The global hotkey (src-tauri/src/cue.rs): open the panel, or fold it back.
(window as unknown as { __cueToggle?: () => void }).__cueToggle = () => setView(body.dataset.view === 'panel' ? 'icon' : 'panel');

syncComposer();
connect();
// Opened by the hotkey: start as the panel.
if (new URLSearchParams(location.search).get('open') === '1') setView('panel');
