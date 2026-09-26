/**
 * What WorkspaceGPT Desktop's agent can do in this browser — the same kind of
 * control Claude in Chrome and Codex have: open and navigate tabs, read a page
 * as text or as an element tree with refs, screenshot it, click, type, press
 * keys, scroll, hover, drag, fill form fields, run JavaScript, and read the
 * console and network log.
 *
 * Input goes through chrome.debugger (the DevTools protocol), so clicks and
 * keys are real input events every site accepts. Chrome shows "WorkspaceGPT
 * started debugging this browser" while a tab is attached; we attach on first
 * use and detach after IDLE_DETACH_MS, and if the user clicks Cancel on that
 * bar we stay off the tab for CANCEL_COOLDOWN_MS.
 *
 * Reading works on any tab. ACTING (navigate, click, type, fill, eval, close)
 * works only on tabs in the agent's own "WorkspaceGPT" tab group — the tabs it
 * opened — and on the tab the user is looking at, which is how the user points
 * at one. Element refs come from browser_read_tree and live in the page's
 * isolated world, so they last until the page navigates.
 */

const GROUP_TITLE = 'WorkspaceGPT';
const MAX_TEXT_CHARS = 100_000;
// Leaves room for JSON escaping under the agent's 20k-per-result cap, so the
// tree arrives whole with its own `truncated` flag instead of cut mid-line.
const DEFAULT_TREE_CHARS = 10_000;
const MAX_LOG_TEXT = 500;
const CDP_TIMEOUT_MS = 15_000;
const IDLE_DETACH_MS = 5 * 60_000;
const CANCEL_COOLDOWN_MS = 10 * 60_000;
const MAX_LOG_ENTRIES = 300;
const MAX_BODY_CHARS = 20_000;
const MAX_EVAL_CHARS = 20_000;
const IS_MAC = /Mac/.test(navigator.userAgent);

interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  at: number;
}
interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  at: number;
}
interface Session {
  console: ConsoleEntry[];
  network: Map<string, NetworkEntry>;
  idle?: ReturnType<typeof setTimeout>;
  /** An alert/confirm/prompt/beforeunload the page is showing. It blocks the page until answered. */
  dialog?: { type: string; message: string };
}

/**
 * Thrown when a page is showing a JavaScript dialog. While one is open the page
 * runs nothing — no scripts, no input — so every call would otherwise hang.
 */
class DialogOpenError extends Error {}

function dialogMessage(dialog: { type: string; message: string }): string {
  return (
    `The page is showing ${/^[aeiou]/.test(dialog.type) ? 'an' : 'a'} ${dialog.type} dialog: "${dialog.message.slice(0, 300)}". It blocks the page until answered. ` +
    'Answer it with browser_act action "dialog" and accept true (OK) or false (Cancel) — ask the user first if OK would do something hard to undo.'
  );
}

/** Callbacks for calls in flight on a tab, woken when a dialog opens there. */
const dialogWaiters = new Map<number, Set<() => void>>();

const sessions = new Map<number, Session>();
const cancelledAt = new Map<number, number>();

// Refs are numbered across ALL tabs, so ref_12 names one element in one tab;
// refOwner remembers which. Without it every page counted from ref_1, and a
// ref read in one tab clicked the same-numbered element in another.
const NEXT_REF_KEY = 'wgptNextRef';
const MAX_REF_OWNERS = 20_000;
const refOwner = new Map<string, number>();

async function nextRefStart(): Promise<number> {
  const stored = await chrome.storage.session.get(NEXT_REF_KEY).catch(() => ({}) as Record<string, unknown>);
  return Number(stored[NEXT_REF_KEY]) || 1;
}

function rememberRefs(tabId: number, tree: string, next: number): void {
  for (const m of tree.matchAll(/\[(ref_\d+)\]/g)) {
    refOwner.delete(m[1]);
    refOwner.set(m[1], tabId);
  }
  while (refOwner.size > MAX_REF_OWNERS) refOwner.delete(refOwner.keys().next().value!);
  void chrome.storage.session.set({ [NEXT_REF_KEY]: next }).catch(() => undefined);
}

// ── Debugger sessions ──────────────────────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  const session = source.tabId !== undefined ? sessions.get(source.tabId) : undefined;
  if (!session) return;
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushLog(session, {
        level: params.type,
        text: (params.args ?? []).map(formatRemoteObject).join(' '),
        url: params.stackTrace?.callFrames?.[0]?.url,
        at: Date.now(),
      });
      break;
    case 'Runtime.exceptionThrown':
      pushLog(session, {
        level: 'error',
        text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'Uncaught exception',
        url: params.exceptionDetails?.url,
        at: Date.now(),
      });
      break;
    case 'Page.javascriptDialogOpening':
      session.dialog = { type: params.type, message: String(params.message ?? '') };
      dialogWaiters.get(source.tabId!)?.forEach((wake) => wake());
      break;
    case 'Page.javascriptDialogClosed':
      session.dialog = undefined;
      break;
    case 'Log.entryAdded':
      pushLog(session, { level: params.entry.level, text: params.entry.text, url: params.entry.url, at: Date.now() });
      break;
    case 'Network.requestWillBeSent':
      session.network.set(params.requestId, {
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        at: Date.now(),
      });
      while (session.network.size > MAX_LOG_ENTRIES) session.network.delete(session.network.keys().next().value!);
      break;
    case 'Network.responseReceived': {
      const entry = session.network.get(params.requestId);
      if (entry) {
        entry.status = params.response.status;
        entry.mimeType = params.response.mimeType;
      }
      break;
    }
    case 'Network.loadingFailed': {
      const entry = session.network.get(params.requestId);
      if (entry) entry.failed = params.errorText;
      break;
    }
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const session = sessions.get(source.tabId);
  if (session?.idle) clearTimeout(session.idle);
  sessions.delete(source.tabId);
  if (reason === 'canceled_by_user') cancelledAt.set(source.tabId, Date.now());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  cancelledAt.delete(tabId);
  for (const [ref, owner] of refOwner) if (owner === tabId) refOwner.delete(ref);
});

function pushLog(session: Session, entry: ConsoleEntry): void {
  if (entry.text.length > MAX_LOG_TEXT) entry.text = `${entry.text.slice(0, MAX_LOG_TEXT)}…`;
  session.console.push(entry);
  if (session.console.length > MAX_LOG_ENTRIES) session.console.splice(0, session.console.length - MAX_LOG_ENTRIES);
}

function formatRemoteObject(o: any): string {
  if (o == null) return String(o);
  if ('value' in o) return typeof o.value === 'string' ? o.value : JSON.stringify(o.value);
  const preview = o.preview;
  if (o.type === 'object' && preview?.properties) {
    const isArray = preview.subtype === 'array';
    const inner = preview.properties
      .map((p: any) => `${isArray ? '' : `${p.name}: `}${p.type === 'string' ? JSON.stringify(p.value) : p.value}`)
      .join(', ');
    const more = preview.overflow ? ', …' : '';
    return isArray ? `[${inner}${more}]` : `{${inner}${more}}`;
  }
  return o.unserializableValue ?? o.description ?? o.type ?? '';
}

async function attach(tabId: number): Promise<Session> {
  let session = sessions.get(tabId);
  if (!session) {
    const cancelled = cancelledAt.get(tabId);
    if (cancelled && Date.now() - cancelled < CANCEL_COOLDOWN_MS) {
      throw new Error(
        'The user stopped WorkspaceGPT from controlling this tab (Cancel on Chrome\'s debugging bar). Ask them in chat before trying again.'
      );
    }
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      const message = errorText(err);
      // Still attached from before the service worker restarted: take it over.
      if (!/already attached/i.test(message)) throw new Error(`Cannot control this tab: ${message}`);
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
      await chrome.debugger.attach({ tabId }, '1.3');
    }
    session = { console: [], network: new Map() };
    sessions.set(tabId, session);
    // retried=true: a failure here must not re-enter attach().
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable'].map((m) => cdp(tabId, m, {}, true).catch(() => undefined)));
    // The agent's window usually sits behind the user's, and Chrome throttles a
    // covered window: each click took ~5.5s there, ~0.4s with the page told it
    // has focus (measured on macOS, Chrome 133).
    await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }, true).catch(() => undefined);
  }
  if (session.idle) clearTimeout(session.idle);
  session.idle = setTimeout(() => {
    // Chrome fires no onDetach for a detach we ask for, so forget the session here.
    sessions.delete(tabId);
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
  }, IDLE_DETACH_MS);
  return session;
}

async function cdp<T = any>(tabId: number, method: string, params: object = {}, retried = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  try {
    return await Promise.race([
      chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), CDP_TIMEOUT_MS);
        // A dialog opened by this very input would hold the command until answered.
        wake = () => {
          const dialog = sessions.get(tabId)?.dialog;
          if (dialog) reject(new DialogOpenError(dialogMessage(dialog)));
        };
        if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
        dialogWaiters.get(tabId)!.add(wake);
      }),
    ]);
  } catch (err) {
    // Detached without an event reaching us (our own detach, a restart): attach again once.
    if (!retried && /not attached/i.test(errorText(err))) {
      sessions.delete(tabId);
      await attach(tabId);
      return cdp<T>(tabId, method, params, true);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (wake) dialogWaiters.get(tabId)?.delete(wake);
  }
}

/** Throws the dialog message if the tab is showing one (known only while attached). */
function assertNoDialog(tabId: number): void {
  const dialog = sessions.get(tabId)?.dialog;
  if (dialog) throw new DialogOpenError(dialogMessage(dialog));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Tabs: which one, and may the agent act on it ───────────────────────────

async function agentGroupId(): Promise<number | undefined> {
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return group?.id;
}

/** Models sometimes send numbers as strings; a tabId that is present must never fall back to the user's tab. */
function tabIdOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = Number(value);
  if (!Number.isInteger(id)) throw new Error(`tabId must be a tab id from browser_list_tabs, not "${String(value)}".`);
  return id;
}

async function resolveTab(rawTabId?: unknown): Promise<chrome.tabs.Tab> {
  const tabId = tabIdOf(rawTabId);
  if (tabId !== undefined) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab;
}

/**
 * Make an agent tab the one its window shows: only a showing tab is painted,
 * so a background one could not be screenshotted and its input would stall.
 * It is the agent's own tab, so switching to it is the agent's business.
 */
async function showAgentTab(tab: chrome.tabs.Tab): Promise<chrome.tabs.Tab> {
  if (tab.active) return tab;
  const shown = await chrome.tabs.update(tab.id!, { active: true });
  await sleep(300);
  return shown ?? tab;
}

/** The tab to act on, or an error the model can act on: its own group, or the tab the user is looking at. */
async function actTab(tabId?: unknown): Promise<chrome.tabs.Tab> {
  const tab = await resolveTab(tabId);
  const cancelled = cancelledAt.get(tab.id!);
  if (cancelled && Date.now() - cancelled < CANCEL_COOLDOWN_MS) {
    throw new Error('The user stopped WorkspaceGPT from controlling this tab (Cancel on Chrome\'s debugging bar). Ask them in chat before trying again.');
  }
  const groupId = await agentGroupId();
  if (groupId !== undefined && tab.groupId === groupId) return showAgentTab(tab);
  const focused = await chrome.windows.getLastFocused().catch(() => undefined);
  if (tab.active && tab.windowId === focused?.id) return tab;
  throw new Error(
    'WorkspaceGPT acts only on tabs in its own "WorkspaceGPT" tab group or on the tab the user is looking at. ' +
      'Open the page with browser_open_tab, or ask the user to switch to that tab.'
  );
}

function checkUrl(url: unknown): string {
  const value = String(url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Not a URL: "${value}". Pass a full http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http(s) URLs can be opened, not ${parsed.protocol}`);
  return parsed.href;
}

/** Wait for a tab to finish loading after something that may navigate it. */
async function settle(tabId: number, timeoutMs: number, minWaitMs = 0): Promise<void> {
  const start = Date.now();
  if (minWaitMs) await sleep(minWaitMs);
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.status === 'complete' || sessions.get(tabId)?.dialog) return;
    await sleep(200);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function tabSummary(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  return { tabId, url: tab.url, title: tab.title };
}

// ── Page-side functions (run inside the page via chrome.scripting) ─────────
// Each must be self-contained: chrome.scripting serializes the function body.

function pageReadText() {
  return { url: location.href, title: document.title, text: (document.body && document.body.innerText) || '' };
}

function pageTree(filter: string, query: string, maxChars: number, startAt: number) {
  const w = window as any;
  // WeakRefs: a long-lived app page must not keep every element it ever showed alive.
  const refs: Map<string, WeakRef<Element>> = (w.__wgptRefs ||= new Map());
  const ids: WeakMap<Element, string> = (w.__wgptIds ||= new WeakMap());
  w.__wgptNext = Math.max(w.__wgptNext || 1, startAt);
  const refOf = (el: Element) => {
    let ref = ids.get(el);
    if (!ref) {
      ref = `ref_${w.__wgptNext++}`;
      ids.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  };
  const clip = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'clickable',
  ]);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'META', 'LINK', 'IFRAME']);
  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      if (type === 'hidden') return null;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) return 'button';
      return 'textbox';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG' && (el as HTMLImageElement).alt) return 'img';
    if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
    const tabindex = el.getAttribute('tabindex');
    if ((tabindex !== null && tabindex !== '-1') || el.hasAttribute('onclick')) return 'clickable';
    return null;
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (text.trim()) return text;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels[0]) return labels[0].innerText;
    const attr = el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title');
    if (attr) return attr;
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el as HTMLInputElement).type)) return (el as HTMLInputElement).value;
    return (el as HTMLElement).innerText || el.textContent || '';
  };
  const vh = innerHeight;
  const vw = innerWidth;
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  const q = query.trim().toLowerCase();
  const emit = (line: string) => {
    if (q && !line.toLowerCase().includes(q)) return;
    if (chars + line.length > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };
  const visit = (node: Node, depth: number) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (filter !== 'all') return;
      const text = clip(node.textContent ?? '', 200);
      if (text.length > 1) emit(`${'  '.repeat(depth)}text "${text}"`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP.has(el.tagName.toUpperCase())) return;
    if (
      typeof (el as any).checkVisibility === 'function' &&
      !(el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      // A display: contents wrapper has no box of its own, but its children do.
      getComputedStyle(el).display !== 'contents'
    ) {
      return;
    }
    const role = roleOf(el);
    let childDepth = depth;
    if (role && (INTERACTIVE.has(role) || role === 'heading' || role === 'img' || filter === 'all')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        const level = el.getAttribute('aria-level') ?? (/^H[1-6]$/.test(el.tagName) ? el.tagName[1] : '');
        const parts = [`${'  '.repeat(depth)}${role === 'heading' ? `heading(${level})` : role}`];
        const name = clip(nameOf(el), 80);
        if (name) parts.push(`"${name.replace(/"/g, "'")}"`);
        if (el.tagName === 'A') parts.push(`→ ${clip(el.getAttribute('href') ?? '', 80)}`);
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) parts.push(el.checked ? 'checked' : 'unchecked');
        else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          parts.push(el instanceof HTMLInputElement && el.type === 'password' ? `value=${el.value ? '"••••"' : '""'} (password)` : `value="${clip(el.value, 60)}"`);
        } else if (el instanceof HTMLSelectElement) parts.push(`selected="${clip(el.selectedOptions[0]?.text ?? '', 60)}"`);
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
        if (el.getAttribute('aria-expanded')) parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) parts.push('(offscreen)');
        parts.push(`[${refOf(el)}]`);
        emit(parts.join(' '));
        childDepth = depth + 1;
        // An interactive element's name already carries its text.
        if (INTERACTIVE.has(role)) {
          if (el.tagName === 'SELECT') return;
          for (const child of Array.from(el.children)) visit(child, childDepth);
          return;
        }
      }
    }
    const root = (el as HTMLElement).shadowRoot;
    if (root) for (const child of Array.from(root.childNodes)) visit(child, childDepth);
    for (const child of Array.from(el.childNodes)) visit(child, childDepth);
  };
  if (document.body) visit(document.body, 0);
  return {
    url: location.href,
    title: document.title,
    tree: lines.join('\n'),
    truncated,
    next: w.__wgptNext as number,
    viewport: { width: vw, height: vh, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight },
  };
}

function pageRefPoint(ref: string, scroll: string) {
  const el: Element | undefined = (window as any).__wgptRefs?.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: `${ref} is not on the page any more (it changed or navigated). Call browser_read_tree again for fresh refs.` };
  if (scroll !== 'none') el.scrollIntoView({ block: scroll as ScrollLogicalPosition, inline: scroll as ScrollLogicalPosition, behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Inside a web component the document only sees the host; ask the element's own root.
  const root = el.getRootNode() as Document | ShadowRoot;
  const top = (typeof root.elementFromPoint === 'function' ? root : document).elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? top.tagName.toLowerCase() : undefined;
  const label = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { x, y, desc: `${el.tagName.toLowerCase()}${label ? ` "${label}"` : ''}`, covered, password: el instanceof HTMLInputElement && el.type === 'password' };
}

/** What has focus in this frame: 'password', another 'field', a child 'frame', or 'none'. */
function pageFocusKind() {
  if (!document.hasFocus()) return 'none';
  // Focus inside a web component shows up as its host; follow it down.
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (el instanceof HTMLInputElement && el.type === 'password') return 'password';
  if (el instanceof HTMLIFrameElement || el?.tagName === 'FRAME') return 'frame';
  return 'field';
}

/**
 * Is a password field focused in ANY frame? Login and payment forms often live
 * in iframes, and an iframe in another process reports its focus a moment
 * after the click that gave it — so "focus went into a child frame" with no
 * child answering yet is asked again, and refused if it never settles.
 */
async function focusedIsPassword(tabId: number): Promise<boolean> {
  assertNoDialog(tabId);
  for (let attempt = 0; attempt < 6; attempt++) {
    let kinds: unknown[];
    try {
      kinds = (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageFocusKind })).map((f) => f.result);
    } catch {
      return true; // could not look: refuse rather than type blind
    }
    if (kinds.includes('password')) return true;
    if (kinds.includes('field')) return false;
    if (!kinds.includes('frame')) return false;
    await sleep(150);
  }
  return true;
}

function pageFill(ref: string, value: string) {
  const el: Element | undefined = (window as any).__wgptRefs?.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: `${ref} is not on the page any more. Call browser_read_tree again for fresh refs.` };
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  const fire = (target: Element) => {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (el instanceof HTMLInputElement && el.type === 'password') return { error: 'Refusing to fill a password field. Ask the user to type it themselves.' };
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = ['true', 'on', 'checked', 'yes', '1'].includes(String(value).toLowerCase());
    if (el.checked !== want) el.click();
    return { ok: true, detail: `${el.type} ${el.checked ? 'checked' : 'unchecked'}` };
  }
  if (el instanceof HTMLSelectElement) {
    const options = Array.from(el.options);
    const wanted = String(value).trim().toLowerCase();
    const option = options.find((o) => o.value === String(value)) ?? options.find((o) => o.text.trim().toLowerCase() === wanted);
    if (!option) return { error: `No option "${value}". Options: ${options.map((o) => o.text.trim()).slice(0, 30).join(' | ')}` };
    el.value = option.value;
    fire(el);
    return { ok: true, detail: `selected "${option.text.trim()}"` };
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus();
    // The prototype's own setter, not the element's: frameworks that track the
    // value (React) then see a real change and fire their onChange.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    fire(el);
    return { ok: true, detail: `filled ${el.tagName.toLowerCase()}` };
  }
  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, String(value));
    return { ok: true, detail: 'filled editable text' };
  }
  return { error: `${el.tagName.toLowerCase()} is not a form field. Use browser_act "click" then "type" instead.` };
}

async function inPage<T, A extends unknown[]>(tabId: number, func: (...args: A) => T, args: A): Promise<T> {
  assertNoDialog(tabId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('the page did not respond in 15s — it may be showing a dialog (alert/confirm) or be busy')),
          CDP_TIMEOUT_MS
        );
      }),
    ]);
    return frame.result as T;
  } catch (err) {
    assertNoDialog(tabId);
    // chrome://, the Web Store and other extensions' pages cannot be scripted.
    throw new Error(`Cannot read this tab: ${errorText(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Input ──────────────────────────────────────────────────────────────────

const MODIFIER_BITS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** Editing shortcuts macOS routes through menu commands rather than key events. */
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

interface KeyPress {
  def: { key: string; code: string; keyCode: number; text?: string };
  modifiers: number;
  typesText: boolean;
  commandKey?: string;
}

/** Windows virtual-key codes for US punctuation (a char code here would be a different key: "." is 46, Delete). */
const PUNCTUATION_KEYCODES: Record<string, number> = {
  ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191,
  '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222,
  '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48,
};

function parseCombo(combo: string): KeyPress {
  // "+" alone, or "shift++", is the plus key itself.
  const plus = combo === '+' || combo.endsWith('++');
  const parts = (plus ? combo.slice(0, -1) : combo).split('+').map((p) => p.trim()).filter(Boolean);
  const main = plus ? '+' : (parts.pop() ?? '');
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIER_BITS[m.toLowerCase()];
    if (bit === undefined) throw new Error(`Unknown modifier "${m}" in "${combo}".`);
    modifiers |= bit;
  }
  let def = KEYS[main.toLowerCase()];
  if (!def && main.length === 1) {
    const upper = main.toUpperCase();
    const alnum = /[A-Z0-9]/.test(upper);
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(main) ? `Digit${main}` : '';
    // shift+a types "A", as it would on a keyboard.
    const char = modifiers & 8 && /[a-z]/.test(main) ? upper : main;
    def = { key: char, code, keyCode: alnum ? upper.charCodeAt(0) : (PUNCTUATION_KEYCODES[main] ?? 0), text: char };
  }
  if (!def) throw new Error(`Unknown key "${main}". Use names like Enter, Tab, Escape, Backspace, ArrowDown, or single characters.`);
  // Only macOS routes editing shortcuts through commands; elsewhere the key
  // event itself does it, and sending both would paste or undo twice.
  const commandKey = IS_MAC && modifiers & 4 ? MAC_COMMANDS[main.toLowerCase()] : undefined;
  const typesText = !!def.text && (modifiers & ~8) === 0;
  return { def, modifiers, typesText, commandKey };
}

async function pressCombo(tabId: number, press: KeyPress): Promise<void> {
  const { def, modifiers, typesText, commandKey } = press;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: typesText ? 'keyDown' : 'rawKeyDown',
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
    text: typesText ? def.text : undefined,
    commands: commandKey ? [commandKey] : undefined,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
}

async function mouseClick(tabId: number, x: number, y: number, button: 'left' | 'right', count: number): Promise<void> {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= count; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i });
  }
}

interface ActParams {
  tabId?: unknown;
  action?: string;
  ref?: string;
  x?: unknown;
  y?: unknown;
  toRef?: string;
  toX?: unknown;
  toY?: unknown;
  text?: string;
  keys?: string;
  value?: unknown;
  direction?: string;
  amount?: number;
  accept?: unknown;
}

/** A point to act at: a ref (scrolled into view first) or explicit viewport coordinates from a screenshot. */
async function target(
  tabId: number,
  ref?: string,
  rawX?: unknown,
  rawY?: unknown,
  scroll: 'center' | 'nearest' | 'none' = 'center'
): Promise<{ x: number; y: number; desc: string; covered?: string; password?: boolean }> {
  if (ref) {
    const point = await inPage(tabId, pageRefPoint, [ref, scroll]);
    if ('error' in point) throw new Error(point.error);
    return point;
  }
  // Numbers may arrive as strings; an absent coordinate must not become 0.
  const x = rawX === undefined || rawX === null || rawX === '' ? NaN : Number(rawX);
  const y = rawY === undefined || rawY === null || rawY === '' ? NaN : Number(rawY);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, desc: `(${Math.round(x)}, ${Math.round(y)})` };
  throw new Error('Pass a ref from browser_read_tree, or x and y from browser_screenshot.');
}

/** The tab a ref belongs to, checked against an explicit tabId; with no tabId, the ref's own tab. */
function tabForRefs(p: ActParams): number | undefined {
  const requested = tabIdOf(p.tabId);
  for (const ref of [p.ref, p.toRef]) {
    const owner = ref ? refOwner.get(ref) : undefined;
    if (owner === undefined) continue;
    if (requested !== undefined && owner !== requested) {
      throw new Error(`${ref} belongs to tab ${owner}, not tab ${requested}. Pass tabId ${owner}, or read tab ${requested}'s tree for its own refs.`);
    }
    return owner;
  }
  return requested;
}

async function act(p: ActParams): Promise<unknown> {
  const tab = await actTab(tabForRefs(p));
  const tabId = tab.id!;
  await attach(tabId);
  const action = p.action ?? '';
  let detail = '';
  if (action === 'dialog') {
    const dialog = sessions.get(tabId)?.dialog;
    if (!dialog) throw new Error('No dialog is open on this tab.');
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
      accept: p.accept === true || String(p.accept).toLowerCase() === 'true',
      promptText: typeof p.text === 'string' ? p.text : undefined,
    });
    sessions.get(tabId)!.dialog = undefined;
    await settle(tabId, 10_000, 200);
    return { ...(await tabSummary(tabId)), detail: `${p.accept === true || String(p.accept) === 'true' ? 'accepted' : 'dismissed'} ${dialog.type} "${dialog.message.slice(0, 120)}"` };
  }
  assertNoDialog(tabId);
  try {
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const t = await target(tabId, p.ref, p.x, p.y);
      await mouseClick(tabId, t.x, t.y, action === 'right_click' ? 'right' : 'left', action === 'double_click' ? 2 : 1);
      detail = `${action.replace('_', ' ')} ${t.desc}${t.covered ? ` (covered by <${t.covered}> — the click landed on that)` : ''}`;
      // A click may start a navigation; give it a moment, then wait for the load.
      await settle(tabId, 10_000, 300);
      break;
    }
    case 'hover': {
      const t = await target(tabId, p.ref, p.x, p.y);
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
      detail = `hovered ${t.desc}`;
      break;
    }
    case 'type': {
      if (typeof p.text !== 'string' || !p.text) throw new Error('"type" needs text.');
      if (p.ref) {
        const t = await target(tabId, p.ref);
        if (t.password) throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
        await mouseClick(tabId, t.x, t.y, 'left', 1);
      }
      if (await focusedIsPassword(tabId)) throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
      await cdp(tabId, 'Input.insertText', { text: p.text });
      detail = `typed ${p.text.length} characters`;
      break;
    }
    case 'key': {
      if (!p.keys) throw new Error('"key" needs keys, e.g. "Enter" or "cmd+a" or "Tab Tab Enter".');
      const presses = p.keys.split(/\s+/).filter(Boolean).map(parseCombo);
      for (const press of presses) {
        // Focus can move mid-sequence (Tab), so check before every key that types.
        if (press.typesText && press.def.key !== '\r' && (await focusedIsPassword(tabId))) {
          throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
        }
        await pressCombo(tabId, press);
      }
      detail = `pressed ${p.keys}`;
      await settle(tabId, 10_000, 200);
      break;
    }
    case 'scroll': {
      if (p.ref && !p.direction) {
        const t = await target(tabId, p.ref);
        detail = `scrolled ${t.desc} into view`;
        break;
      }
      const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
      const vp = metrics.cssVisualViewport;
      const at = p.ref || (p.x !== undefined && p.y !== undefined) ? await target(tabId, p.ref, p.x, p.y) : { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
      const ticks = Math.max(1, Math.min(Number(p.amount) || 3, 20));
      const dir = (p.direction ?? 'down').toLowerCase();
      const deltaX = dir === 'left' ? -100 * ticks : dir === 'right' ? 100 * ticks : 0;
      const deltaY = dir === 'up' ? -100 * ticks : dir === 'down' ? 100 * ticks : 0;
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY });
      await sleep(300);
      detail = `scrolled ${dir} ${ticks}`;
      break;
    }
    case 'drag': {
      // Bringing the target into view can scroll the source; measure the source last, without scrolling again.
      let from = await target(tabId, p.ref, p.x, p.y);
      const to = await target(tabId, p.toRef, p.toX, p.toY, 'nearest');
      if (p.ref) from = await target(tabId, p.ref, undefined, undefined, 'none');
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        await cdp(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + ((to.x - from.x) * i) / 10,
          y: from.y + ((to.y - from.y) * i) / 10,
          button: 'left',
          buttons: 1,
        });
      }
      await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      detail = `dragged ${from.desc} to ${to.desc}`;
      break;
    }
    case 'fill': {
      if (!p.ref) throw new Error('"fill" needs a ref from browser_read_tree.');
      const res = await inPage(tabId, pageFill, [p.ref, String(p.value ?? '')]);
      if ('error' in res) throw new Error(res.error);
      detail = res.detail;
      break;
    }
    default:
      throw new Error(`Unknown action "${action}". Use click, double_click, right_click, hover, type, key, scroll, drag, fill, dialog or wait.`);
  }
  } catch (err) {
    // The action worked — it opened a dialog. Say so; the dialog is the page's answer.
    if (!(err instanceof DialogOpenError)) throw err;
    return { ...(await tabSummary(tabId)), detail: `${detail || action} → ${err.message}`, dialogOpen: true };
  }
  return { ...(await tabSummary(tabId)), detail };
}

// ── Screenshots ────────────────────────────────────────────────────────────

async function screenshot(tabId?: unknown) {
  let tab = await resolveTab(tabId);
  const groupId = await agentGroupId();
  if (groupId !== undefined && tab.groupId === groupId) tab = await showAgentTab(tab);
  // Only a tab a window is showing is painted; a background tab comes back blank or not at all.
  if (!tab.active) {
    throw new Error('Only the tab showing in its window can be captured. Omit tabId for the tab the user is looking at, or ask them to switch to it.');
  }
  const id = tab.id!;
  await attach(id);
  const metrics = await cdp(id, 'Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  assertNoDialog(id);
  // Device pixels per CSS pixel, from the browser (a page can overwrite window.devicePixelRatio).
  const dpr = metrics.visualViewport?.clientWidth && vp.clientWidth ? metrics.visualViewport.clientWidth / vp.clientWidth : 1;
  // Clip to the visible viewport at CSS-pixel scale, so a point in the image
  // is the same x/y browser_act dispatches.
  const shot = await cdp<{ data: string }>(id, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 70,
    clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr },
  });
  return {
    tabId: id,
    url: tab.url,
    title: tab.title,
    width: Math.round(vp.clientWidth),
    height: Math.round(vp.clientHeight),
    dataUrl: `data:image/jpeg;base64,${shot.data}`,
  };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function handleBrowserRequest(method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'tabs.list': {
      const [tabs, groupId, focused] = await Promise.all([
        chrome.tabs.query({}),
        agentGroupId(),
        chrome.windows.getLastFocused().catch(() => undefined),
      ]);
      return {
        tabs: tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          title: t.title,
          url: t.url,
          active: t.active,
          userIsLookingAt: t.active && t.windowId === focused?.id,
          inAgentGroup: groupId !== undefined && t.groupId === groupId,
        })),
      };
    }
    case 'tabs.open': {
      const url = checkUrl(params.url);
      const groupId = await agentGroupId();
      let tab: chrome.tabs.Tab;
      if (groupId !== undefined) {
        const group = await chrome.tabGroups.get(groupId);
        tab = await chrome.tabs.create({ windowId: group.windowId, url, active: true });
        await chrome.tabs.group({ tabIds: tab.id!, groupId });
      } else {
        // First tab: its own window, so the agent never rearranges the user's.
        const win = await chrome.windows.create({ url, focused: false });
        tab = win.tabs![0];
        const newGroup = await chrome.tabs.group({ tabIds: tab.id!, createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(newGroup, { title: GROUP_TITLE, color: 'blue' });
      }
      await settle(tab.id!, 30_000, 300);
      return tabSummary(tab.id!);
    }
    case 'tabs.close': {
      const closeId = tabIdOf(params.tabId);
      if (closeId === undefined) throw new Error('browser_close_tab needs a tabId.');
      const tab = await chrome.tabs.get(closeId);
      const groupId = await agentGroupId();
      if (groupId === undefined || tab.groupId !== groupId) throw new Error('WorkspaceGPT closes only tabs in its own "WorkspaceGPT" group.');
      await chrome.tabs.remove(tab.id!);
      return { closed: tab.id };
    }
    case 'page.navigate': {
      const tab = await actTab(params.tabId);
      const where = String(params.url ?? '').trim();
      if (where === 'back') await chrome.tabs.goBack(tab.id!);
      else if (where === 'forward') await chrome.tabs.goForward(tab.id!);
      else await chrome.tabs.update(tab.id!, { url: checkUrl(where) });
      await settle(tab.id!, 30_000, 300);
      return tabSummary(tab.id!);
    }
    case 'page.read': {
      const tab = await resolveTab(params.tabId);
      const page = await inPage(tab.id!, pageReadText, []);
      return {
        tabId: tab.id,
        url: page.url,
        title: page.title,
        text: page.text.slice(0, MAX_TEXT_CHARS),
        truncated: page.text.length > MAX_TEXT_CHARS,
      };
    }
    case 'page.tree': {
      const tab = await resolveTab(params.tabId);
      const filter = params.filter === 'all' ? 'all' : 'interactive';
      const maxChars = Math.max(1000, Math.min(Number(params.maxChars) || DEFAULT_TREE_CHARS, 60_000));
      const { next, ...tree } = await inPage(tab.id!, pageTree, [filter, String(params.query ?? ''), maxChars, await nextRefStart()]);
      rememberRefs(tab.id!, tree.tree, next);
      return {
        tabId: tab.id,
        ...tree,
        ...(tree.truncated ? { note: 'Cut short. Pass query to find a specific element, or scroll and read again.' } : {}),
      };
    }
    case 'page.screenshot':
      return screenshot(params.tabId);
    case 'page.act':
      return act(params);
    case 'page.eval': {
      const tab = await actTab(params.tabId);
      await attach(tab.id!);
      assertNoDialog(tab.id!);
      const r = await cdp(tab.id!, 'Runtime.evaluate', {
        expression: String(params.expression ?? ''),
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'Evaluation failed');
      let value = JSON.stringify(r.result?.value ?? r.result?.description ?? null) ?? 'undefined';
      const truncated = value.length > MAX_EVAL_CHARS;
      if (truncated) value = value.slice(0, MAX_EVAL_CHARS);
      return { ...(await tabSummary(tab.id!)), result: value, truncated };
    }
    case 'page.console': {
      const tab = await resolveTab(params.tabId);
      const session = await attach(tab.id!);
      const pattern = params.pattern ? String(params.pattern).toLowerCase() : '';
      const entries = session.console
        .filter((e) => !params.onlyErrors || e.level === 'error')
        .filter((e) => !pattern || e.text.toLowerCase().includes(pattern))
        .slice(-(Number(params.limit) || 50));
      if (params.clear) session.console.length = 0;
      return {
        tabId: tab.id,
        url: tab.url,
        entries,
        note: 'Messages from when WorkspaceGPT started watching this tab (plus what the page had already logged). Reload the page (browser_navigate to its URL) to capture a fresh load.',
      };
    }
    case 'page.network': {
      const tab = await resolveTab(params.tabId);
      const session = await attach(tab.id!);
      if (params.requestId) {
        const body = await cdp(tab.id!, 'Network.getResponseBody', { requestId: String(params.requestId) });
        const text = body.base64Encoded ? '[binary body]' : String(body.body ?? '');
        return { requestId: params.requestId, body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
      }
      const pattern = params.urlPattern ? String(params.urlPattern).toLowerCase() : '';
      const requests = Array.from(session.network.values())
        .filter((e) => !pattern || e.url.toLowerCase().includes(pattern))
        .slice(-(Number(params.limit) || 50));
      return {
        tabId: tab.id,
        url: tab.url,
        requests,
        note: 'Only requests since WorkspaceGPT started watching this tab. Reload the page to capture from the start; pass requestId for a response body.',
      };
    }
    default:
      throw new Error(`Unknown browser method: ${method}`);
  }
}
