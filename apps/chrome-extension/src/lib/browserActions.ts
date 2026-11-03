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
const MAX_SHOT_EDGE = 1568;
const MAX_SHOT_PIXELS = 1_150_000;
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
/** Screenshot pixels per CSS pixel of each tab's last screenshot, so browser_act x/y map back to the page. */
const shotScale = new Map<number, number>();
// What happened to the debugger on a tab, said when an attach is refused there, so the
// error shows whether we were attached before the page loaded and why Chrome let go.
const attachTrail = new Map<number, string[]>();

function trail(tabId: number, what: string): void {
  const list = attachTrail.get(tabId) ?? [];
  list.push(`${new Date().toISOString().slice(11, 19)} ${what}`);
  attachTrail.set(tabId, list.slice(-6));
}

// Tabs we hold the debugger on, kept across a service-worker restart. Chrome refuses a
// fresh attach once another extension has a frame on the page, even to the extension that
// is already attached, so after a restart we take the old attachment over instead.
const ATTACHED_KEY = 'wgptAttachedTabs';

async function attachedTabs(): Promise<number[]> {
  const stored = await chrome.storage.session.get(ATTACHED_KEY).catch(() => ({}) as Record<string, unknown>);
  return Array.isArray(stored[ATTACHED_KEY]) ? (stored[ATTACHED_KEY] as number[]) : [];
}

async function markAttached(tabId: number, on: boolean): Promise<void> {
  const next = (await attachedTabs()).filter((id) => id !== tabId);
  if (on) next.push(tabId);
  await chrome.storage.session.set({ [ATTACHED_KEY]: next }).catch(() => undefined);
}

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
  void markAttached(source.tabId, false);
  trail(source.tabId, `Chrome detached us (${reason})`);
  if (reason === 'canceled_by_user') cancelledAt.set(source.tabId, Date.now());
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
  void markAttached(tabId, false);
  attachTrail.delete(tabId);
  shotScale.delete(tabId);
  pageModeTabs.delete(tabId);
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

/**
 * Chrome refuses to attach the debugger to a tab that has another extension's frame on it,
 * and drops a debugger already attached when such a frame appears: LastPass's field menu
 * (webclient-infield.html) did both on mms.com — attached on about:blank, detached two seconds
 * into the load. Which tabs get such a frame is up to that extension, so the tools then work
 * through the page instead (attachOrPage). Names the extension, by title when Chrome has one.
 */
async function foreignExtensions(): Promise<string> {
  const targets = await chrome.debugger.getTargets().catch(() => [] as chrome.debugger.TargetInfo[]);
  // Its frame is listed as type "other" with no extensionId, so the id is read from the URL.
  const hostOf = (url: string) => url.replace('chrome-extension://', '').split('/')[0];
  const found = targets.filter((t) => t.type !== 'worker' && t.type !== 'background_page' && t.url.startsWith('chrome-extension://') && hostOf(t.url) !== chrome.runtime.id);
  return [...new Set(found.map((t) => `${t.title && !t.title.startsWith('chrome-extension://') ? `"${t.title}" ` : ''}${hostOf(t.url)} (${t.url.split('/').pop()})`))].join(', ');
}

async function foreignExtensionHint(tabId: number): Promise<string> {
  const who = await foreignExtensions();
  const history = attachTrail.get(tabId);
  const earlier = history?.length ? ` On this tab: ${history.join('; ')}.` : '';
  return `.${who ? ` Another extension has a frame on this page: ${who}.` : ''}${earlier} This is Chrome's restriction, not a fault in the page. Call the tool again: it then works through the page instead of the debugger.`;
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
    // Still attached from before the service worker restarted: take that over without a new attach.
    const stillAttached =
      (await attachedTabs()).includes(tabId) && (await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}).then(() => true, () => false));
    if (!stillAttached) {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (err) {
        const message = errorText(err);
        if (/different extension/i.test(message)) throw new Error(`Cannot control this tab: ${message}${await foreignExtensionHint(tabId)}`);
        if (!/already attached/i.test(message)) throw new Error(`Cannot control this tab: ${message}`);
        await chrome.debugger.detach({ tabId }).catch(() => undefined);
        await chrome.debugger.attach({ tabId }, '1.3');
      }
    }
    await markAttached(tabId, true);
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
    void markAttached(tabId, false);
    void chrome.debugger.detach({ tabId }).catch(() => undefined);
  }, IDLE_DETACH_MS);
  return session;
}

/** Tabs Chrome would not let us debug, with whose frame was in the way; their tools work through the page. */
const pageModeTabs = new Map<number, string>();

/**
 * Attach the debugger, or — when Chrome refuses because another extension has a frame on the
 * tab — say so and start recording the page's requests and console from inside it, so the
 * tools can carry on through the page. Any other refusal is still an error.
 */
async function attachOrPage(tabId: number): Promise<boolean> {
  try {
    await attach(tabId);
    pageModeTabs.delete(tabId);
    return true;
  } catch (err) {
    if (!/different extension/i.test(errorText(err))) throw err;
    pageModeTabs.set(tabId, (await foreignExtensions()) || 'another extension');
    await inPage(tabId, pageInstallRecorder, [MAX_BODY_CHARS], 'MAIN').catch(() => undefined);
    return false;
  }
}

function pageModeNote(tabId: number): string {
  return (
    `Chrome would not let WorkspaceGPT debug this tab: another extension has a frame on it (${pageModeTabs.get(tabId) ?? 'unknown'}). ` +
    'This ran through the page instead: clicks and keys are synthetic events a few sites ignore, drag and dialogs are unavailable, and console/network hold only what happened since WorkspaceGPT started recording on this page. ' +
    'If a site ignores these clicks, ask the user with ask_user to turn that extension off for this site.'
  );
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
  if (tab.url && !/^(https?|file):/i.test(tab.url)) {
    throw new Error(
      `This tab is a ${tab.url.split(':')[0]}:// page, which Chrome does not let any extension control. ` +
        'Open the page you want with browser_open_tab (or call browser_list_tabs and pass the tabId of an http(s) tab).'
    );
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
async function settle(tabId: number, timeoutMs: number, minWaitMs = 0): Promise<boolean> {
  const start = Date.now();
  if (minWaitMs) await sleep(minWaitMs);
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.status === 'complete' || sessions.get(tabId)?.dialog) return true;
    await sleep(200);
  }
  return false;
}

/**
 * A tab still loading after `settle` timed out is usually waiting on the user: Chrome's
 * own sign-in prompt (HTTP basic auth) holds the load and cannot be seen or answered from
 * the page. Said in the result so the model leaves the tab open and asks, rather than
 * reading a blank page and closing it.
 */
const WAITING_ON_USER =
  'The page has not finished loading. A tab stuck like this is usually showing Chrome\'s own sign-in prompt (HTTP basic auth) or a slow server. ' +
  'Only the user can answer that prompt: leave this tab open, ask them with ask_user to sign in in it, and continue once they answer. Do not close the tab.';

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

async function inPage<T, A extends unknown[]>(
  tabId: number,
  func: (...args: A) => T,
  args: A,
  world: chrome.scripting.ExecutionWorld = 'ISOLATED'
): Promise<Awaited<T>> {
  assertNoDialog(tabId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [frame] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func, args, world }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('the page did not respond in 15s — it may be showing a dialog (alert/confirm) or be busy')),
          CDP_TIMEOUT_MS
        );
      }),
    ]);
    return frame.result as Awaited<T>;
  } catch (err) {
    assertNoDialog(tabId);
    // chrome://, the Web Store and other extensions' pages cannot be scripted.
    const text = errorText(err);
    // Chrome swapped the page for its own error page: not reachable from this Chrome (VPN, DNS, a refused or cancelled sign-in), not a bug in the page.
    const hint = /showing error page/i.test(text)
      ? ' Chrome is showing its own error page for this address: the site is not reachable from this Chrome, or a sign-in was refused. Leave the tab open, tell the user what you saw and ask them with ask_user to open the site in it (VPN, sign-in) — do not close it.'
      : '';
    throw new Error(`Cannot read this tab: ${text}${hint}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Pointer, probes and the no-debugger path (page-side) ───────────────────

/**
 * The cursor drawn on the agent's tab so the user can watch where it acts. It sits in a closed
 * shadow root with pointer-events: none, so it never takes a click or shows in elementFromPoint.
 */
function pagePointer(x: number, y: number, kind: string) {
  const w = window as any;
  if (kind === 'remove') {
    w.__wgptPointer?.remove();
    w.__wgptPointer = undefined;
    return;
  }
  if (!w.__wgptPointer?.isConnected) {
    const host = document.createElement('wgpt-pointer');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<style>.c{position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;transition:transform .35s cubic-bezier(.2,.7,.3,1),opacity .2s;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}' +
      '.r{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #4f7cff;opacity:0;pointer-events:none}' +
      '.r.on{animation:p .5s ease-out}@keyframes p{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.7)}}</style>' +
      '<div class="r"></div><svg class="c" viewBox="0 0 24 24"><path d="M4 2l16 9-7 1.7L9.6 20z" fill="#4f7cff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    (document.documentElement || document.body).appendChild(host);
    const cursor = root.querySelector('.c') as SVGElement;
    cursor.style.transform = `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`;
    void cursor.getBoundingClientRect();
    w.__wgptPointer = host;
    w.__wgptPointerRoot = root;
  }
  const root: ShadowRoot = w.__wgptPointerRoot;
  const cursor = root.querySelector('.c') as SVGElement;
  if (kind === 'hide') {
    cursor.style.opacity = '0';
    return;
  }
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
  if (kind === 'click') {
    const ring = root.querySelector('.r') as HTMLElement;
    setTimeout(() => {
      ring.style.left = `${x}px`;
      ring.style.top = `${y}px`;
      ring.classList.remove('on');
      void ring.offsetWidth;
      ring.classList.add('on');
    }, 350);
  }
}

/** What is at a point, and a signature of the page to tell afterwards whether an action changed anything. */
function pageProbe(x: number | null, y: number | null) {
  let hit: string | undefined;
  if (x !== null && y !== null) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    const named = el?.closest('a,button,input,select,textarea,label,summary,[role],[onclick]') ?? el;
    if (named) {
      const label = ((named as HTMLElement).innerText || named.getAttribute('aria-label') || named.getAttribute('placeholder') || (named as HTMLInputElement).value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      hit = `${named.tagName.toLowerCase()}${label ? ` "${label}"` : ''}`;
    }
  }
  let focus = document.activeElement;
  while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
  return { hit, url: location.href, size: document.body ? document.body.innerHTML.length : 0, focus: focus ? focus.tagName.toLowerCase() : '' };
}

/** A click, hover or right-click as DOM events at a point: what the tools do when Chrome refuses the debugger. */
function pageSyntheticPointer(x: number, y: number, action: string) {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y) as HTMLElement | null;
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return { error: `Nothing on the page at (${Math.round(x)}, ${Math.round(y)}).` };
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const pointer = (type: string, extra: object = {}) => el!.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra }));
  const mouse = (type: string, extra: object = {}) => el!.dispatchEvent(new MouseEvent(type, { ...base, ...extra }));
  pointer('pointerover');
  mouse('mouseover');
  pointer('pointermove');
  mouse('mousemove');
  if (action === 'hover') return { ok: true };
  const button = action === 'right_click' ? 2 : 0;
  const buttons = button === 2 ? 2 : 1;
  for (let i = 1; i <= (action === 'double_click' ? 2 : 1); i++) {
    pointer('pointerdown', { button, buttons });
    mouse('mousedown', { button, buttons, detail: i });
    if (i === 1) (el.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable]') as HTMLElement | null)?.focus();
    pointer('pointerup', { button });
    mouse('mouseup', { button, detail: i });
    // click() runs the element's own behaviour too: a link follows, a checkbox toggles, a submit button submits.
    if (button === 0) el.click();
  }
  if (button === 2) mouse('contextmenu', { button: 2, buttons: 2 });
  if (action === 'double_click') mouse('dblclick', { detail: 2 });
  return { ok: true };
}

/** Types into the focused field as the browser would, through the value setter frameworks watch. */
function pageSyntheticType(text: string) {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
  if (!el || el === document.body) return { error: 'Nothing is focused to type into. Click the field first, or pass its ref.' };
  if (el instanceof HTMLInputElement && el.type === 'password') return { error: 'Refusing to type into a password field. Ask the user to type it themselves.' };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    let start = el.value.length;
    let end = start;
    try {
      start = el.selectionStart ?? start;
      end = el.selectionEnd ?? end;
    } catch {
      /* email and number inputs have no selection */
    }
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    if (setter) setter.call(el, next);
    else el.value = next;
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* no selection on this input type */
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (el.isContentEditable) {
    document.execCommand('insertText', false, text);
    return { ok: true };
  }
  return { error: `The focused <${el.tagName.toLowerCase()}> does not take text.` };
}

/**
 * Key presses as DOM events. A synthetic key does nothing by itself, so the keys that matter
 * do their job here: Enter submits the field's form (or presses the focused button or link),
 * Tab moves focus, Backspace deletes, a single character types.
 */
function pageSyntheticKeys(keys: string) {
  const done: string[] = [];
  for (const combo of keys.split(/\s+/).filter(Boolean)) {
    const parts = combo.split('+');
    const key = parts.pop() ?? '';
    const mods = parts.map((m) => m.toLowerCase());
    let el = document.activeElement as HTMLElement | null;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
    const target = el ?? document.body;
    const name = key.length === 1 ? key : key[0].toUpperCase() + key.slice(1).toLowerCase().replace(/^Arrow(.)/, (_, c) => `Arrow${c.toUpperCase()}`);
    const init = { key: name === 'Esc' ? 'Escape' : name === 'Return' ? 'Enter' : name, bubbles: true, cancelable: true, composed: true, shiftKey: mods.includes('shift'), ctrlKey: mods.includes('ctrl'), altKey: mods.includes('alt'), metaKey: mods.includes('cmd') || mods.includes('meta') };
    const allowed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
    if (allowed && !init.ctrlKey && !init.metaKey && !init.altKey) {
      if (init.key === 'Enter') {
        if (field instanceof HTMLInputElement && field.form) field.form.requestSubmit();
        else if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement) target.click();
      } else if (init.key === 'Tab') {
        const focusable = Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter((e) => !(e as HTMLButtonElement).disabled && e.offsetParent !== null);
        const i = focusable.indexOf(target);
        focusable[(i + (init.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      } else if (init.key === 'Backspace' && field) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
        setter?.call(field, field.value.slice(0, -1));
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      } else if (init.key.length === 1) {
        if (field instanceof HTMLInputElement && field.type === 'password') return { error: 'Refusing to type into a password field. Ask the user to type it themselves.' };
        if (field) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
          setter?.call(field, field.value + init.key);
          field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: init.key }));
        }
      }
    } else if (allowed && (init.metaKey || init.ctrlKey) && init.key.toLowerCase() === 'a' && field) field.select();
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    done.push(combo);
  }
  return { ok: true, detail: `pressed ${done.join(' ')}` };
}

function pageSyntheticScroll(direction: string, ticks: number, x: number | null, y: number | null) {
  const dx = direction === 'left' ? -100 * ticks : direction === 'right' ? 100 * ticks : 0;
  const dy = direction === 'up' ? -100 * ticks : direction === 'down' ? 100 * ticks : 0;
  let el = x !== null && y !== null ? (document.elementFromPoint(x, y) as HTMLElement | null) : null;
  while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (el) el.scrollBy(dx, dy);
  else window.scrollBy(dx, dy);
  return { ok: true };
}

function pageViewport() {
  return { width: innerWidth, height: innerHeight };
}

/**
 * Runs in the page's own world: records fetch/XHR (with request and response bodies) and the
 * console, for browser_network and browser_console when Chrome refuses the debugger. It sees
 * only what happens after it is installed, and a new page starts without it.
 */
function pageInstallRecorder(maxBody: number) {
  const w = window as any;
  if (w.__wgptRec) return w.__wgptRec.since;
  const rec = { since: Date.now(), seq: 0, network: [] as any[], console: [] as any[] };
  w.__wgptRec = rec;
  const cap = (v: unknown) => (typeof v === 'string' ? v.slice(0, maxBody) : v instanceof URLSearchParams ? v.toString().slice(0, maxBody) : undefined);
  const push = (list: any[], entry: any) => {
    list.push(entry);
    if (list.length > 300) list.splice(0, list.length - 300);
  };
  const origFetch = w.fetch;
  w.fetch = function (input: any, init?: any) {
    const req = input instanceof Request ? input : null;
    const entry: any = {
      requestId: `p${++rec.seq}`,
      method: String(init?.method || req?.method || 'GET').toUpperCase(),
      url: String(req ? req.url : input instanceof URL ? input.href : input),
      type: 'fetch',
      at: Date.now(),
      requestBody: cap(init?.body),
    };
    push(rec.network, entry);
    return origFetch.apply(this, arguments as any).then(
      (res: Response) => {
        entry.status = res.status;
        entry.mimeType = res.headers.get('content-type') ?? undefined;
        res.clone().text().then((t) => (entry.body = cap(t)), () => undefined);
        return res;
      },
      (err: unknown) => {
        entry.failed = String(err);
        throw err;
      }
    );
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: any, method: string, url: string | URL) {
    this.__wgpt = { requestId: `p${++rec.seq}`, method: String(method).toUpperCase(), url: String(url), type: 'xhr', at: Date.now() };
    return open.apply(this, arguments as any);
  } as any;
  XMLHttpRequest.prototype.send = function (this: any, body?: any) {
    const entry = this.__wgpt;
    if (entry) {
      entry.requestBody = cap(body);
      push(rec.network, entry);
      this.addEventListener('loadend', () => {
        entry.status = this.status;
        entry.mimeType = this.getResponseHeader('content-type') ?? undefined;
        if (this.status === 0) entry.failed = 'network error';
        try {
          if (this.responseType === '' || this.responseType === 'text') entry.body = cap(this.responseText);
          else if (this.responseType === 'json') entry.body = cap(JSON.stringify(this.response));
        } catch {
          /* unreadable body */
        }
      });
    }
    return send.apply(this, arguments as any);
  };
  const text = (a: unknown) => {
    if (typeof a === 'string') return a;
    try {
      return a instanceof Error ? a.stack || a.message : JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = (console as any)[level];
    (console as any)[level] = function (...args: unknown[]) {
      push(rec.console, { level, text: args.map(text).join(' ').slice(0, 500), at: Date.now() });
      return orig.apply(this, args);
    };
  }
  addEventListener('error', (e) => push(rec.console, { level: 'error', text: String(e.message).slice(0, 500), url: e.filename, at: Date.now() }));
  addEventListener('unhandledrejection', (e) => push(rec.console, { level: 'error', text: `Unhandled rejection: ${text(e.reason)}`.slice(0, 500), at: Date.now() }));
  return rec.since;
}

function pageReadRecorder() {
  const rec = (window as any).__wgptRec;
  return rec ? { since: rec.since as number, network: rec.network as any[], console: rec.console as any[] } : null;
}

/** browser_eval without the debugger: evaluated in the page's own world (a page whose CSP forbids eval refuses it). */
function pageEval(code: string) {
  const run = (src: string) => (0, eval)(src);
  let value: unknown;
  try {
    try {
      value = run(code);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // Top-level await, or statements with a return: run as an async function body.
      try {
        value = run(`(async () => (${code}\n))()`);
      } catch {
        value = run(`(async () => {${code}\n})()`);
      }
    }
  } catch (err) {
    return Promise.resolve({ error: err instanceof Error ? err.message : String(err) });
  }
  return Promise.resolve(value).then(
    (v) => {
      try {
        return { value: JSON.stringify(v ?? null) ?? 'undefined' };
      } catch {
        return { value: String(v) };
      }
    },
    (err) => ({ error: err instanceof Error ? err.message : String(err) })
  );
}

/** Moves the drawn cursor to a point (and ripples on a click), then gives the user a moment to see it. */
async function showPointer(tabId: number, x: number, y: number, kind: 'move' | 'click'): Promise<void> {
  const shown = await chrome.scripting.executeScript({ target: { tabId }, func: pagePointer, args: [x, y, kind] }).then(() => true, () => false);
  if (shown) await sleep(kind === 'click' ? 380 : 250);
}

type PageSig = Awaited<ReturnType<typeof pageProbe>>;

async function probe(tabId: number, x: number | null = null, y: number | null = null): Promise<PageSig | undefined> {
  return inPage(tabId, pageProbe, [x, y]).catch(() => undefined);
}

/** What an action did to the page, so a click that changed nothing is not simply repeated. */
function changeNote(before?: PageSig, after?: PageSig): string {
  if (!before || !after) return '';
  if (after.url !== before.url) return ` → navigated to ${after.url}`;
  if (after.size !== before.size) return ' → the page changed';
  if (after.focus !== before.focus) return ` → focus moved to <${after.focus}>`;
  return ' → nothing on the page changed (same URL, content and focus): look again before the next action';
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
  // x/y are in the last screenshot's pixels, which may be smaller than the page's (see screenshot).
  const scale = shotScale.get(tabId) ?? 1;
  if (Number.isFinite(x) && Number.isFinite(y)) return { x: x / scale, y: y / scale, desc: `(${Math.round(x)}, ${Math.round(y)})` };
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
  // false: Chrome refused the debugger here (another extension's frame), so input goes through the page.
  const viaDebugger = await attachOrPage(tabId);
  const action = p.action ?? '';
  let detail = '';
  if (action === 'dialog') {
    if (!viaDebugger) throw new Error(`Answering a dialog needs the debugger. ${pageModeNote(tabId)}`);
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
  const throughPage = async (func: (...args: any[]) => any, args: unknown[]) => {
    const res = await inPage(tabId, func, args);
    if (res && 'error' in res) throw new Error(res.error);
    return res;
  };
  try {
  switch (action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const t = await target(tabId, p.ref, p.x, p.y);
      const before = await probe(tabId, t.x, t.y);
      await showPointer(tabId, t.x, t.y, 'click');
      if (viaDebugger) await mouseClick(tabId, t.x, t.y, action === 'right_click' ? 'right' : 'left', action === 'double_click' ? 2 : 1);
      else await throughPage(pageSyntheticPointer, [t.x, t.y, action]);
      // What was under the point: a coordinate alone said nothing, and the same miss got clicked twice.
      const hit = !p.ref && before?.hit ? ` on ${before.hit}` : '';
      detail = `${action.replace('_', ' ')} ${t.desc}${hit}${t.covered ? ` (covered by <${t.covered}> — the click landed on that)` : ''}`;
      // A click may start a navigation; give it a moment, then wait for the load.
      await settle(tabId, 10_000, 300);
      detail += changeNote(before, await probe(tabId));
      break;
    }
    case 'hover': {
      const t = await target(tabId, p.ref, p.x, p.y);
      await showPointer(tabId, t.x, t.y, 'move');
      if (viaDebugger) await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
      else await throughPage(pageSyntheticPointer, [t.x, t.y, 'hover']);
      detail = `hovered ${t.desc}`;
      break;
    }
    case 'type': {
      if (typeof p.text !== 'string' || !p.text) throw new Error('"type" needs text.');
      if (p.ref) {
        const t = await target(tabId, p.ref);
        if (t.password) throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
        await showPointer(tabId, t.x, t.y, 'click');
        if (viaDebugger) await mouseClick(tabId, t.x, t.y, 'left', 1);
        else await throughPage(pageSyntheticPointer, [t.x, t.y, 'click']);
      }
      if (viaDebugger) {
        if (await focusedIsPassword(tabId)) throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
        await cdp(tabId, 'Input.insertText', { text: p.text });
      } else await throughPage(pageSyntheticType, [p.text]);
      detail = `typed ${p.text.length} characters`;
      break;
    }
    case 'key': {
      if (!p.keys) throw new Error('"key" needs keys, e.g. "Enter" or "cmd+a" or "Tab Tab Enter".');
      const before = await probe(tabId);
      if (viaDebugger) {
        const presses = p.keys.split(/\s+/).filter(Boolean).map(parseCombo);
        for (const press of presses) {
          // Focus can move mid-sequence (Tab), so check before every key that types.
          if (press.typesText && press.def.key !== '\r' && (await focusedIsPassword(tabId))) {
            throw new Error('Refusing to type into a password field. Ask the user to type it themselves.');
          }
          await pressCombo(tabId, press);
        }
      } else await throughPage(pageSyntheticKeys, [p.keys]);
      detail = `pressed ${p.keys}`;
      await settle(tabId, 10_000, 200);
      detail += changeNote(before, await probe(tabId));
      break;
    }
    case 'scroll': {
      if (p.ref && !p.direction) {
        const t = await target(tabId, p.ref);
        detail = `scrolled ${t.desc} into view`;
        break;
      }
      const ticks = Math.max(1, Math.min(Number(p.amount) || 3, 20));
      const dir = (p.direction ?? 'down').toLowerCase();
      const point = p.ref || (p.x !== undefined && p.y !== undefined) ? await target(tabId, p.ref, p.x, p.y) : undefined;
      if (viaDebugger) {
        const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
        const vp = metrics.cssVisualViewport;
        const at = point ?? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
        const deltaX = dir === 'left' ? -100 * ticks : dir === 'right' ? 100 * ticks : 0;
        const deltaY = dir === 'up' ? -100 * ticks : dir === 'down' ? 100 * ticks : 0;
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY });
      } else await throughPage(pageSyntheticScroll, [dir, ticks, point?.x ?? null, point?.y ?? null]);
      await sleep(300);
      detail = `scrolled ${dir} ${ticks}`;
      break;
    }
    case 'drag': {
      if (!viaDebugger) throw new Error(`Dragging needs the debugger. ${pageModeNote(tabId)}`);
      // Bringing the target into view can scroll the source; measure the source last, without scrolling again.
      let from = await target(tabId, p.ref, p.x, p.y);
      const to = await target(tabId, p.toRef, p.toX, p.toY, 'nearest');
      if (p.ref) from = await target(tabId, p.ref, undefined, undefined, 'none');
      await showPointer(tabId, from.x, from.y, 'move');
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
      await showPointer(tabId, to.x, to.y, 'move');
      detail = `dragged ${from.desc} to ${to.desc}`;
      break;
    }
    case 'fill': {
      if (!p.ref) throw new Error('"fill" needs a ref from browser_read_tree.');
      const t = await target(tabId, p.ref);
      await showPointer(tabId, t.x, t.y, 'click');
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
  return { ...(await tabSummary(tabId)), detail, ...(viaDebugger ? {} : { note: pageModeNote(tabId) }) };
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
  // The drawn cursor is for the user; keep it out of what the model sees.
  await chrome.scripting.executeScript({ target: { tabId: id }, func: pagePointer, args: [0, 0, 'hide'] }).catch(() => undefined);
  if (!(await attachOrPage(id))) {
    // No debugger: capture what the window shows, then scale it like the debugger path below.
    const vp = await inPage(id, pageViewport, []);
    const scale = shotScaleFor(vp.width, vp.height);
    const width = Math.round(vp.width * scale);
    const height = Math.round(vp.height * scale);
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    shotScale.set(id, scale);
    return { tabId: id, url: tab.url, title: tab.title, width, height, dataUrl: await resizeJpeg(raw, width, height), note: pageModeNote(id) };
  }
  const metrics = await cdp(id, 'Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  assertNoDialog(id);
  // Device pixels per CSS pixel, from the browser (a page can overwrite window.devicePixelRatio).
  const dpr = metrics.visualViewport?.clientWidth && vp.clientWidth ? metrics.visualViewport.clientWidth / vp.clientWidth : 1;
  const scale = shotScaleFor(vp.clientWidth, vp.clientHeight);
  // Clip to the visible viewport, at `scale` image pixels per CSS pixel; browser_act divides x/y by the same scale.
  const shot = await cdp<{ data: string }>(id, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: 70,
    clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: scale / dpr },
  });
  shotScale.set(id, scale);
  return {
    tabId: id,
    url: tab.url,
    title: tab.title,
    width: Math.round(vp.clientWidth * scale),
    height: Math.round(vp.clientHeight * scale),
    dataUrl: `data:image/jpeg;base64,${shot.data}`,
  };
}

/**
 * How much to shrink a screenshot. Model providers downscale large images before the model
 * sees them (Anthropic past 1568px on the long edge or ~1.15 megapixels), and the model's
 * x/y then point at the smaller picture: a 1890px-wide viewport's clicks landed short.
 * Shrinking here keeps the image the model sees and the x/y we map back the same size.
 */
function shotScaleFor(width: number, height: number): number {
  return Math.min(1, MAX_SHOT_EDGE / Math.max(width, height), Math.sqrt(MAX_SHOT_PIXELS / (width * height)));
}

async function resizeJpeg(dataUrl: string, width: number, height: number): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
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
        await chrome.windows.update(group.windowId, { focused: true }).catch(() => undefined);
      } else {
        // First tab: a new tab in the window the user is in, put in a "WorkspaceGPT"
        // group so it is marked as the agent's. A separate unfocused window opened
        // behind the others, and the user saw nothing happen.
        const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);
        tab = await chrome.tabs.create({ windowId: current?.id, url, active: true });
        const newGroup = await chrome.tabs.group({ tabIds: tab.id!, createProperties: { windowId: tab.windowId } });
        await chrome.tabGroups.update(newGroup, { title: GROUP_TITLE, color: 'blue' });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      }
      const settled = await settle(tab.id!, 30_000, 300);
      return { ...(await tabSummary(tab.id!)), ...(settled ? {} : { loading: true, note: WAITING_ON_USER }) };
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
      const settled = await settle(tab.id!, 30_000, 300);
      // A new page has no recorder; start it again where the tools work through the page.
      if (pageModeTabs.has(tab.id!)) await inPage(tab.id!, pageInstallRecorder, [MAX_BODY_CHARS], 'MAIN').catch(() => undefined);
      return { ...(await tabSummary(tab.id!)), ...(settled ? {} : { loading: true, note: WAITING_ON_USER }) };
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
      if (!(await attachOrPage(tab.id!))) {
        const r = await inPage(tab.id!, pageEval, [String(params.expression ?? '')], 'MAIN');
        if ('error' in r) throw new Error(`${r.error}. ${pageModeNote(tab.id!)}`);
        return { ...(await tabSummary(tab.id!)), result: r.value.slice(0, MAX_EVAL_CHARS), truncated: r.value.length > MAX_EVAL_CHARS, note: pageModeNote(tab.id!) };
      }
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
      const pattern = params.pattern ? String(params.pattern).toLowerCase() : '';
      if (!(await attachOrPage(tab.id!))) {
        const rec = await inPage(tab.id!, pageReadRecorder, [], 'MAIN');
        const entries = (rec?.console ?? [])
          .filter((e) => !params.onlyErrors || e.level === 'error')
          .filter((e) => !pattern || String(e.text).toLowerCase().includes(pattern))
          .slice(-(Number(params.limit) || 50));
        return { tabId: tab.id, url: tab.url, entries, note: `Recorded since ${rec ? new Date(rec.since).toISOString() : 'now'}. ${pageModeNote(tab.id!)}` };
      }
      const session = sessions.get(tab.id!)!;
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
      if (!(await attachOrPage(tab.id!))) {
        const rec = await inPage(tab.id!, pageReadRecorder, [], 'MAIN');
        const all = rec?.network ?? [];
        if (params.requestId) {
          const entry = all.find((e) => e.requestId === String(params.requestId));
          if (!entry) throw new Error(`No recorded request ${params.requestId} on this page.`);
          const text = String(entry.body ?? '');
          return { requestId: entry.requestId, requestBody: entry.requestBody, body: text.slice(0, MAX_BODY_CHARS), truncated: text.length > MAX_BODY_CHARS };
        }
        const pattern = params.urlPattern ? String(params.urlPattern).toLowerCase() : '';
        const requests = all
          .filter((e) => !pattern || String(e.url).toLowerCase().includes(pattern))
          .slice(-(Number(params.limit) || 50))
          .map(({ body, requestBody, ...e }) => ({ ...e, hasBody: body !== undefined, ...(requestBody ? { requestBody: String(requestBody).slice(0, 500) } : {}) }));
        return { tabId: tab.id, url: tab.url, requests, note: `Fetch and XHR recorded since ${rec ? new Date(rec.since).toISOString() : 'now'}; pass requestId for a response body. ${pageModeNote(tab.id!)}` };
      }
      const session = sessions.get(tab.id!)!;
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
    case 'session.release': {
      // A run ended: detach from the tabs it drove and take the drawn cursor off them.
      const ids: number[] = Array.isArray(params.tabIds) ? params.tabIds.map(Number).filter(Number.isInteger) : [...sessions.keys()];
      for (const id of ids) {
        const session = sessions.get(id);
        if (session?.idle) clearTimeout(session.idle);
        sessions.delete(id);
        await markAttached(id, false);
        await chrome.debugger.detach({ tabId: id }).catch(() => undefined);
        await chrome.scripting.executeScript({ target: { tabId: id }, func: pagePointer, args: [0, 0, 'remove'] }).catch(() => undefined);
      }
      return { released: ids.length };
    }
    default:
      throw new Error(`Unknown browser method: ${method}`);
  }
}
