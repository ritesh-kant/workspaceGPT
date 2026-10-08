/**
 * The desktop shell page: frames the extension's Sessions view (sidebar) and
 * chat view (main pane) and draws the chrome around them.
 *
 * It holds no state of its own that matters. The session title comes from
 * the Sessions view's `sessions-list` messages, the account row from the chat
 * view's remote-session messages, and the header buttons are the chat view's
 * title-bar actions (package.json `view/title`, see host/titleActions.ts) —
 * the framed bridges report all of these here (ShellHooks in
 * desktop-bridge.ts). Clicking one sends the command back through the chat's
 * own socket, so the sidecar still honours only real title actions.
 *
 * Token: headless mode opens this page with `#t=<token>`; it moves to
 * sessionStorage (shared with the same-origin frames) and the fragment is
 * cleared. Under Tauri the window's initialization script provides it.
 */
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../vscode-extensions/constants';
import type { ShellHooks } from './desktop-bridge';
import { initTerminalPanel } from './terminal';

interface TitleAction {
  command: string;
  title: string;
  iconLight?: string;
  iconDark?: string;
}

interface SessionPreview {
  id: string;
  title?: string;
  /** The folder the session works in, recorded on its transcript. */
  workspaceFolder?: string;
}

(() => {
  const w = window as any;
  const CHAT_VIEW = 'workspacegpt.chatView';
  const SESSIONS_VIEW = 'workspacegpt.sessionsView';
  const TOKEN_KEY = 'wgpt.desktop.token';
  const SIDEBAR_KEY = 'wgpt.desktop.sidebar';
  const NARROW = matchMedia('(max-width: 719px)');

  // Title actions the shell places itself rather than in the header row.
  const NEW_CHAT = 'workspacegpt.newChat';
  const SETTINGS = 'workspacegpt.settings';
  const HISTORY = 'workspacegpt.history';

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const app = $('app');

  // ── Token ───────────────────────────────────────────────────────────────

  let token: string | undefined = w.__WGPT_DESKTOP__?.token;
  const fromHash = /(?:^#|&)t=([^&]+)/.exec(location.hash);
  if (fromHash) {
    token = decodeURIComponent(fromHash[1]!);
    history.replaceState(null, '', location.pathname + location.search);
  }
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else token = sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    /* storage blocked: the frames read shell.token instead */
  }
  // A restarted sidecar prints a new link; pasting it changes only the fragment.
  window.addEventListener('hashchange', () => {
    const m = /(?:^#|&)t=([^&]+)/.exec(location.hash);
    if (!m) return;
    try {
      sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]!));
    } catch {
      /* ignore */
    }
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  });

  if (w.__WGPT_DESKTOP__?.chrome === 'overlay') document.documentElement.classList.add('overlay-titlebar');

  // ── State read from the views' traffic ──────────────────────────────────

  let sessions: SessionPreview[] = [];
  /** A full-pane screen the chat is showing instead of the conversation. */
  let panel: string | null = null;
  let activeSessionId: string | null = null;
  let hasSessionsView = true;
  let actions: TitleAction[] = [];
  /** The folder the chat works in (the sidecar's one workspace folder); '' when none. */
  let folder = '';
  const account = { signedIn: false, known: false, login: '', plan: '', mode: '' };

  const hooks: ShellHooks = {
    token,
    hostMessage(viewType, message) {
      const msg = (message ?? {}) as Record<string, any>;
      if (viewType === SESSIONS_VIEW && msg.type === MESSAGE_TYPES.SESSIONS_LIST) {
        sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        const previous = activeSessionId;
        if (msg.activeSessionId !== undefined) activeSessionId = msg.activeSessionId || null;
        // On a narrow window the sidebar covers the chat: picking a session
        // there should reveal the chat it just opened.
        if (NARROW.matches && sidebar === 'open' && activeSessionId !== previous) setSidebar('closed');
        renderTitle();
        return;
      }
      if (viewType !== CHAT_VIEW) return;
      switch (msg.type) {
        case MESSAGE_TYPES.NEW_CHAT:
          activeSessionId = null;
          renderTitle();
          break;
        case MESSAGE_TYPES.REMOTE_SESSION_STATUS:
          setAccount(!!msg.signedIn, msg.githubLogin, msg.plan);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS:
          setAccount(true, msg.githubLogin, msg.plan);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS:
          setAccount(false);
          break;
        case MESSAGE_TYPES.WORKSPACE_PATH:
          folder = typeof msg.path === 'string' ? msg.path : '';
          renderTitle();
          break;
        case MESSAGE_TYPES.RECENT_FOLDERS:
          folder = typeof msg.current === 'string' ? msg.current : folder;
          renderTitle();
          break;
        case MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE:
          if (msg.key === STORAGE_KEYS.SETTINGS) setMode(msg.state?.config?.mode);
          break;
      }
    },
    viewMessage(viewType, message) {
      const msg = (message ?? {}) as Record<string, any>;
      // The chat saves its whole persisted store ({ state, version }) on every change.
      if (viewType === CHAT_VIEW && msg.type === MESSAGE_TYPES.UPDATE_GLOBAL_STATE && msg.key === STORAGE_KEYS.SETTINGS) {
        setMode(msg.state?.state?.config?.mode);
      }
    },
    toolbar(viewType, items) {
      if (viewType !== CHAT_VIEW) return;
      actions = items as TitleAction[];
      renderActions();
    },
  };
  w.__wgptShell = hooks;

  function setAccount(signedIn: boolean, login?: string, plan?: string): void {
    account.known = true;
    account.signedIn = signedIn;
    account.login = signedIn ? String(login ?? '') : '';
    account.plan = signedIn ? String(plan ?? '') : '';
    renderAccount();
  }

  /** Local mode needs no account, so "Not signed in" would read as a to-do. */
  function setMode(mode: unknown): void {
    // Absent means local, as in the extension's getMode().
    const next = mode === 'remote' ? 'remote' : 'local';
    if (next === account.mode) return;
    account.mode = next;
    renderAccount();
  }

  // ── Frames ──────────────────────────────────────────────────────────────

  const frame = (viewType: string, label: string) => {
    const f = document.createElement('iframe');
    f.className = 'view';
    f.setAttribute('aria-label', label);
    // Same origin already inherits these; stated so Copy keeps working if that changes.
    f.allow = 'clipboard-read; clipboard-write';
    f.src = `/view/${encodeURIComponent(viewType)}`;
    // Under a saved page zoom a frame can finish loading laid out at the
    // unzoomed size (a white band beside it). Resizing it by a pixel and back
    // once it has loaded makes it lay out again.
    f.addEventListener('load', () => {
      f.style.width = 'calc(100% - 1px)';
      requestAnimationFrame(() => requestAnimationFrame(() => (f.style.width = '')));
    });
    return f;
  };
  const chatFrame = frame(CHAT_VIEW, 'Chat');
  $('mainBody').appendChild(chatFrame);
  chatFrame.addEventListener('load', () => {
    syncChatAttributes();
    watchChatScreen();
  });

  /**
   * First-run setup is the chat view's onboarding screen. While it is up the
   * shell steps aside — no sidebar, no header — so setup reads as a startup
   * panel of its own, and the app appears once the last step is done. Only
   * #root's direct children are watched (React swaps them when the view
   * changes), not the chat's subtree.
   */
  function watchChatScreen(): void {
    try {
      const root = chatFrame.contentDocument?.getElementById('root');
      if (!root) return;
      let container: Element | null = null;
      const panels = new MutationObserver(checkPanel);
      const check = () => {
        app.classList.toggle('onboarding', !!root.querySelector(':scope > .onboarding-overlay'));
        const next = root.querySelector(':scope > .app-container > .chat-container');
        if (next !== container) {
          panels.disconnect();
          container = next;
          if (container) panels.observe(container, { childList: true });
        }
        checkPanel();
      };
      // Settings, History and Releases are overlays the chat mounts as direct
      // children of .chat-container; the header names whichever is up.
      function checkPanel(): void {
        const kids = container ? [...container.children] : [];
        const has = (sel: string) => kids.some((k) => k.matches(sel));
        panel = has('.history-overlay') ? 'History' : has('[class*="release"]') ? 'Releases' : has('.settings-panel') ? 'Settings' : null;
        // Settings brings its own left column (its section nav, see
        // Settings.tsx's page layout); the sessions sidebar steps aside so the
        // window stays two columns, the way Cline's settings sit in its sidebar.
        app.classList.toggle('settings-open', panel === 'Settings');
        renderTitle();
      }
      // React may keep #root's element and swap only its class and children
      // (loading screen → app), so watch that element's children as well.
      const outer = new MutationObserver(() => {
        const top = root.firstElementChild;
        if (top && top !== watchedTop) {
          watchedTop = top;
          outer.observe(top, { childList: true });
        }
        check();
      });
      let watchedTop: Element | null = null;
      outer.observe(root, { childList: true });
      if (root.firstElementChild) {
        watchedTop = root.firstElementChild;
        outer.observe(watchedTop, { childList: true });
      }
      check();
    } catch {
      /* not loaded yet */
    }
  }

  // An extension build without the Sessions view still gets the chat; the
  // header then offers History instead.
  fetch(`/view/${encodeURIComponent(SESSIONS_VIEW)}`, { method: 'HEAD', cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      hasSessionsView = ok;
      if (ok) $('sideBody').appendChild(frame(SESSIONS_VIEW, 'Sessions'));
      else app.classList.add('no-sessions');
      applySidebar();
    });

  const bridgeOf = (f: HTMLIFrameElement): { command(id: string): void } | undefined => {
    try {
      return (f.contentWindow as any)?.__wgptBridge;
    } catch {
      return undefined;
    }
  };
  const run = (command: string) => bridgeOf(chatFrame)?.command(command);

  // ── Sidebar ─────────────────────────────────────────────────────────────

  // The user's last explicit choice, per width class; narrow windows start closed.
  const sidebarPref = (): 'open' | 'closed' => {
    try {
      const saved = localStorage.getItem(SIDEBAR_KEY + (NARROW.matches ? ':narrow' : ''));
      if (saved === 'open' || saved === 'closed') return saved;
    } catch {
      /* ignore */
    }
    return NARROW.matches ? 'closed' : 'open';
  };
  let sidebar = sidebarPref();

  function setSidebar(next: 'open' | 'closed'): void {
    sidebar = next;
    try {
      localStorage.setItem(SIDEBAR_KEY + (NARROW.matches ? ':narrow' : ''), next);
    } catch {
      /* ignore */
    }
    applySidebar();
  }

  // Drag the sidebar's right edge to resize it; the width persists.
  const WIDTH_KEY = 'wgpt.desktop.sidebarWidth';
  const SIDE_MIN = 200;
  const SIDE_MAX = 600;
  const clampSide = (w: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)));
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w) app.style.setProperty('--side-w', clampSide(w) + 'px');
  } catch {
    /* ignore */
  }
  const handle = $('sideResize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    app.classList.add('side-resizing');
    const left = $('side').getBoundingClientRect().left;
    let raw = $('side').getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      raw = ev.clientX - left;
      app.style.setProperty('--side-w', clampSide(raw) + 'px');
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      app.classList.remove('side-resizing');
      // Dragged well past the minimum: hide the sidebar, keeping the last width.
      if (raw < SIDE_MIN - 60) {
        setSidebar('closed');
        return;
      }
      try {
        localStorage.setItem(WIDTH_KEY, String(clampSide(raw)));
      } catch {
        /* ignore */
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    app.style.removeProperty('--side-w');
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* ignore */
    }
  });

  function applySidebar(): void {
    const open = hasSessionsView ? sidebar : 'closed';
    app.dataset.sidebar = open;
    // On a narrow window the open sidebar floats over the chat.
    $('scrim').hidden = !(open === 'open' && NARROW.matches);
    renderActions();
    syncChatAttributes();
  }

  NARROW.addEventListener?.('change', () => {
    sidebar = sidebarPref();
    applySidebar();
  });
  $('collapseSide').onclick = () => setSidebar('closed');
  $('expandSide').onclick = () => setSidebar('open');
  $('scrim').onclick = () => setSidebar('closed');

  /**
   * Tell the chat what the shell is showing, so the skin can drop what would
   * repeat it (the home screen's Recent Chats list duplicates the sidebar).
   */
  function syncChatAttributes(): void {
    try {
      const root = chatFrame.contentDocument?.documentElement;
      if (!root) return;
      const docked = app.dataset.sidebar === 'open' && !NARROW.matches;
      root.toggleAttribute('data-wgpt-sessions-docked', docked);
    } catch {
      /* not loaded yet */
    }
  }

  // ── Header ──────────────────────────────────────────────────────────────

  function renderTitle(): void {
    const active = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : undefined;
    const text = panel ?? (active?.title?.trim() || 'New session');
    $('title').textContent = text;
    document.title = active || panel ? `${text} — WorkspaceGPT` : 'WorkspaceGPT';
    // Which folder this session works in, beside its title. A new session's
    // composer already shows it (WorkspaceControls.tsx), and a panel is not a session.
    // A session keeps its own folder whichever one the window has open.
    const shown = active?.workspaceFolder || folder;
    const chip = $('folderChip');
    chip.hidden = !active || !!panel || !shown;
    $('folderChipName').textContent = shown.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || shown;
    // The full path, drawn under the chip on hover (shell.css) rather than a slow native tooltip.
    $('folderChipTip').textContent = shown;
  }

  // Keep the path tooltip inside the window: near the right edge it would run off.
  const placeFolderTip = () => {
    const chip = $('folderChip');
    const tip = $('folderChipTip');
    const overflow = chip.getBoundingClientRect().left + tip.offsetWidth - (window.innerWidth - 12);
    chip.style.setProperty('--tip-shift', `${-Math.max(0, overflow)}px`);
  };
  $('folderChip').addEventListener('mouseenter', placeFolderTip);
  $('folderChip').addEventListener('focus', placeFolderTip);

  const ICONS: Record<string, string> = {
    [NEW_CHAT]: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    [HISTORY]:
      '<path d="M4 12a8 8 0 1 0 2.3-5.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 4.5v3.5h3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 8v4.2l2.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };

  function renderActions(): void {
    const row = $('actions');
    row.textContent = '';
    const sidebarShown = hasSessionsView && app.dataset.sidebar === 'open';
    const choice = document.documentElement.dataset.wgptTheme;
    const dark = choice === 'dark' || (!choice && matchMedia('(prefers-color-scheme: dark)').matches);
    const header = actions.filter(
      (a) => a.command !== SETTINGS && !((a.command === HISTORY || a.command === NEW_CHAT) && sidebarShown),
    );
    // New chat sits last, at the far right, like the "+" of a tab strip.
    header.sort((a, b) => Number(a.command === NEW_CHAT) - Number(b.command === NEW_CHAT));
    for (const action of header) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.title = action.title;
      b.setAttribute('aria-label', action.title);
      const glyph = ICONS[action.command];
      const icon = dark ? action.iconDark : action.iconLight;
      if (glyph) {
        b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">${glyph}</svg>`;
      } else if (icon) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        b.appendChild(img);
      } else {
        b.textContent = action.title;
        b.classList.add('text-btn');
      }
      b.onclick = () => run(action.command);
      row.appendChild(b);
    }
    const settings = actions.some((a) => a.command === SETTINGS);
    $('settingsBtn').hidden = !settings;
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderActions);
  window.addEventListener('wgpt-theme-change', renderActions);

  // ── Account footer ──────────────────────────────────────────────────────

  function renderAccount(): void {
    const name = $('accountName');
    const sub = $('accountSub');
    const avatar = $('avatar');
    if (account.signedIn) {
      name.textContent = account.login || 'Signed in';
      sub.textContent = account.plan ? `${account.plan[0]!.toUpperCase()}${account.plan.slice(1)} plan` : 'Remote mode';
      avatar.textContent = (account.login || '?')[0]!.toUpperCase();
      avatar.classList.add('on');
    } else if (account.mode === 'local') {
      name.textContent = 'Local mode';
      sub.textContent = 'No account needed';
      avatar.textContent = 'L';
      avatar.classList.remove('on');
    } else {
      name.textContent = 'Not signed in';
      sub.textContent = 'Sign in from Settings';
      avatar.textContent = '?';
      avatar.classList.remove('on');
    }
  }

  const openSettings = () => {
    run(SETTINGS);
    if (NARROW.matches) setSidebar('closed');
  };
  $('settingsBtn').onclick = openSettings;
  $('account').onclick = openSettings;

  applySidebar();
  renderTitle();
  renderAccount();
  const terminal = initTerminalPanel({ getToken: () => token, app, panel: $('termPanel'), toggle: $('termBtn') });
  // The chat's ▶ Run button on shell code blocks (CodeBlock.tsx). Only the chat frame may ask.
  window.addEventListener('message', (e) => {
    if (e.source !== chatFrame.contentWindow) return;
    const d = e.data;
    if (d && d.type === 'wgpt:run-in-terminal' && typeof d.command === 'string' && d.command.length < 10_000) terminal.run(d.command);
  });
})();
