import * as vscode from 'vscode';
import { MESSAGE_TYPES } from '../../constants';

/**
 * Compact Sessions list for the secondary side bar. Separate from the full
 * chat React app so this view does not spin up a second chat store.
 */
export class SessionsHtmlTemplate {
  public getHtml(webview: vscode.Webview): string {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      /* VS Code injects "padding: 0 20px" on webview bodies; clear it so the
         list runs edge to edge and the scrollbar hugs the panel border. */
      padding: 0;
      height: 100%;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .wrap {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding: 6px 0 0;
    }
    .nav { padding: 0 6px; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      height: 30px;
      padding: 0 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-foreground);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .nav-item:hover { background: var(--vscode-list-hoverBackground); }
    .nav-item.on { background: var(--vscode-list-hoverBackground); }
    .nav-item svg { flex-shrink: 0; opacity: 0.85; }
    .search {
      display: none;
      align-items: center;
      gap: 8px;
      margin: 4px 6px 2px;
      padding: 0 8px;
      height: 28px;
      border-radius: 6px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-descriptionForeground);
    }
    .search.visible { display: flex; }
    .search:focus-within { border-color: var(--vscode-focusBorder); }
    .search input {
      flex: 1;
      min-width: 0;
      height: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      font: inherit;
      font-size: 12px;
    }
    .sep {
      height: 1px;
      margin: 8px 12px 4px;
      background: var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .list {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0 6px 10px;
    }
    .list::-webkit-scrollbar { width: 10px; }
    .list::-webkit-scrollbar-track { background: transparent; }
    .list::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.35));
      background-clip: content-box;
      border: 3px solid transparent;
      border-radius: 5px;
    }
    .list::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5));
      background-clip: content-box;
    }
    .empty {
      padding: 24px 12px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .group-header {
      padding: 12px 8px 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      opacity: 0.9;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 30px;
      padding: 5px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.active {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-list-activeSelectionForeground, inherit);
    }
    .row-delete {
      display: none;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .row:hover .row-delete { display: flex; }
    .row-delete:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-errorForeground, inherit);
    }
    /* Empty leading column keeps titles aligned with the nav item labels. */
    .dot {
      width: 14px;
      display: flex;
      justify-content: center;
      flex-shrink: 0;
    }
    .dot::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: transparent;
    }
    /* Run-status dot: pulsing green while a session's turn is in flight,
       solid blue if it finished in the background and hasn't been opened
       yet, solid red if it failed and hasn't been opened yet. Independent
       of selection, which the row background already conveys. */
    .row.running .dot::before {
      background: var(--vscode-charts-green, #89d185);
      animation: dot-pulse 1.2s ease-in-out infinite;
    }
    .row.completed .dot::before { background: var(--vscode-charts-blue, #3794ff); }
    .row.errored .dot::before { background: var(--vscode-charts-red, #f85149); }
    @keyframes dot-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .title {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .row.active .meta { color: inherit; opacity: 0.8; }
    .diffs { display: flex; gap: 4px; font-weight: 600; font-size: 10px; }
    /* Work mode: one collapsible group per folder, rows indented under it. */
    .ws-header {
      display: flex;
      align-items: center;
      margin-top: 4px;
      border-radius: 6px;
    }
    .ws-header:hover { background: var(--vscode-list-hoverBackground); }
    .ws-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
      height: 30px;
      padding: 0 8px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .ws-header:hover .ws-toggle,
    .ws-group.current .ws-toggle { color: var(--vscode-foreground); }
    .ws-name {
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ws-chevron { flex-shrink: 0; opacity: 0.7; transition: transform 0.12s ease; }
    .ws-group.open .ws-chevron { transform: rotate(90deg); }
    .ws-new {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      margin-right: 3px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .ws-new:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-foreground);
    }
    .ws-rows { display: none; }
    .ws-group.open .ws-rows { display: block; }
    .ws-empty {
      padding: 4px 8px 6px 32px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .added { color: var(--vscode-charts-green, #3fb950); }
    .removed { color: var(--vscode-charts-red, #f85149); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <button class="nav-item" id="newSession" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span>New Session</span>
      </button>
      <button class="nav-item" id="searchToggle" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
          <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span>Search</span>
      </button>
    </div>
    <div class="search" id="searchWrap">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
        <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <input id="search" type="search" placeholder="Search sessions" aria-label="Search sessions" />
    </div>
    <div class="sep"></div>
    <div class="list" id="list"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const MESSAGE_TYPES = ${JSON.stringify({
      NEW_CHAT: MESSAGE_TYPES.NEW_CHAT,
      LOAD_CHAT_SESSION: MESSAGE_TYPES.LOAD_CHAT_SESSION,
      SESSIONS_LIST: MESSAGE_TYPES.SESSIONS_LIST,
      SESSIONS_TOGGLE_SEARCH: MESSAGE_TYPES.SESSIONS_TOGGLE_SEARCH,
      DELETE_CHAT_HISTORY: MESSAGE_TYPES.DELETE_CHAT_HISTORY,
    })};
    let sessions = [];
    let activeId = null;
    let query = '';
    let runningIds = new Set();
    let completedIds = new Set();
    let erroredIds = new Set();
    let mode = 'work';
    let currentWorkspace = '';
    // Folder groups the user opened or closed by hand; the rest default to
    // open for the folder that is open now (and the active session's).
    let wsOpen = (vscode.getState() || {}).wsOpen || {};

    const listEl = document.getElementById('list');
    const searchWrap = document.getElementById('searchWrap');
    const searchInput = document.getElementById('search');
    const searchToggle = document.getElementById('searchToggle');

    document.getElementById('newSession').addEventListener('click', () => {
      vscode.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
    });
    searchToggle.addEventListener('click', () => toggleSearch());
    searchInput.addEventListener('input', (e) => {
      query = e.target.value || '';
      render();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleSearch(false);
    });

    function toggleSearch(force) {
      const on = force === undefined ? !searchWrap.classList.contains('visible') : force;
      searchWrap.classList.toggle('visible', on);
      searchToggle.classList.toggle('on', on);
      if (on) {
        searchInput.focus();
        searchInput.select();
      } else {
        query = '';
        searchInput.value = '';
        render();
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === MESSAGE_TYPES.SESSIONS_LIST) {
        sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        if (msg.activeSessionId !== undefined) activeId = msg.activeSessionId || null;
        runningIds = new Set(Array.isArray(msg.runningSessionIds) ? msg.runningSessionIds : []);
        completedIds = new Set(Array.isArray(msg.completedSessionIds) ? msg.completedSessionIds : []);
        erroredIds = new Set(Array.isArray(msg.erroredSessionIds) ? msg.erroredSessionIds : []);
        if (msg.assistantMode === 'chat' || msg.assistantMode === 'work') mode = msg.assistantMode;
        if (typeof msg.currentWorkspace === 'string') currentWorkspace = msg.currentWorkspace;
        render();
      }
      if (msg.type === MESSAGE_TYPES.SESSIONS_TOGGLE_SEARCH) {
        toggleSearch();
      }
    });

    function escapeHtml(text) {
      return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatAge(ts, now) {
      const diffMs = Math.max(0, now - ts);
      const minutes = Math.floor(diffMs / 60000);
      if (minutes < 1) return 'now';
      if (minutes < 60) return minutes + 'm';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h';
      const days = Math.floor(hours / 24);
      if (days < 7) return days + 'd';
      const weeks = Math.floor(days / 7);
      if (days < 30) return weeks + 'w';
      const months = Math.floor(days / 30);
      if (months < 12) return months + 'mo';
      return Math.floor(days / 365) + 'y';
    }

    function startOfDay(now) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }

    function bucketLabel(ts, now) {
      const today = startOfDay(now);
      const yesterday = today - 86400000;
      const last7 = today - 6 * 86400000;
      if (ts >= today) return 'Today';
      if (ts >= yesterday) return 'Yesterday';
      if (ts >= last7) return 'Last 7 days';
      return 'Older';
    }

    const BUCKET_ORDER = ['Today', 'Yesterday', 'Last 7 days', 'Older'];

    function render() {
      const now = Date.now();
      const needle = query.trim().toLowerCase();
      const matching = needle
        ? sessions.filter((s) => String(s.title || '').toLowerCase().includes(needle))
        : sessions;

      const byFolder = mode === 'work' ? workspaceGroupsHtml(matching, now, !!needle) : '';
      if (byFolder) {
        listEl.innerHTML = byFolder;
        return;
      }

      if (!matching.length) {
        listEl.innerHTML = '<div class="empty">' +
          (sessions.length === 0
            ? 'No sessions yet'
            : 'No sessions match “' + escapeHtml(query.trim()) + '”') +
          '</div>';
        return;
      }

      const groups = new Map();
      for (const session of matching) {
        const label = bucketLabel(session.updatedAt || 0, now);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(session);
      }

      let html = '';
      for (const label of BUCKET_ORDER) {
        const items = groups.get(label);
        if (!items || !items.length) continue;
        html += '<div class="group-header">' + label + '</div>';
        for (const session of items) html += rowHtml(session, now);
      }
      listEl.innerHTML = html;
    }

    function rowHtml(session, now) {
      const active = session.id === activeId ? ' active' : '';
      const running = runningIds.has(session.id) ? ' running' : '';
      const errored = !running && erroredIds.has(session.id) ? ' errored' : '';
      const completed = !running && !errored && completedIds.has(session.id) ? ' completed' : '';
      const statusLabel = running ? ' - running' : errored ? ' - failed' : completed ? ' - done' : '';
      const added = Number(session.added) || 0;
      const removed = Number(session.removed) || 0;
      let diffs = '';
      if (added > 0 || removed > 0) {
        diffs = '<span class="diffs">';
        if (added > 0) diffs += '<span class="added">+' + added + '</span>';
        if (removed > 0) diffs += '<span class="removed">-' + removed + '</span>';
        diffs += '</span>';
      }
      const title = escapeHtml(session.title || 'New Chat');
      const age = escapeHtml(formatAge(session.updatedAt || 0, now));
      return '<button class="row' + active + running + errored + completed + '" type="button" title="' +
        title + escapeHtml(statusLabel) + '" data-id="' +
        escapeHtml(session.id) + '">' +
        '<span class="dot"></span>' +
        '<span class="title">' + title + '</span>' +
        '<span class="meta">' + diffs + '<span class="age">' + age + '</span></span>' +
        '<span class="row-delete" data-delete-id="' + escapeHtml(session.id) + '" title="Delete chat" role="button" aria-label="Delete chat">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg></span>' +
        '</button>';
    }

    const CHEVRON = '<svg class="ws-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    /** Last path segment, or the last two where two folders share a name. */
    function folderLabels(folders) {
      const parts = (p) => p.split(/[\\\\/]+/).filter(Boolean);
      const base = (p) => parts(p).slice(-1)[0] || p;
      const count = new Map();
      for (const f of folders) count.set(base(f), (count.get(base(f)) || 0) + 1);
      return new Map(folders.map((f) => [f, count.get(base(f)) > 1 ? parts(f).slice(-2).join('/') : base(f)]));
    }

    /**
     * Work mode: a group per folder, by name, so a group stays where it is as
     * sessions come and go. The open folder's group is always shown (it is
     * where "+" starts a session); sessions with no recorded folder go last.
     */
    function workspaceGroupsHtml(items, now, searching) {
      const groups = new Map();
      if (currentWorkspace && !searching) groups.set(currentWorkspace, []);
      for (const session of items) {
        const key = session.workspaceFolder || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(session);
      }
      const labels = folderLabels([...groups.keys()].filter(Boolean));
      const keys = [...groups.keys()].sort(
        (a, b) => !a - !b || labels.get(a).localeCompare(labels.get(b), undefined, { sensitivity: 'base' })
      );
      let html = '';
      for (const key of keys) {
        const inGroup = groups.get(key);
        const current = key === currentWorkspace;
        const open = searching || (key in wsOpen ? !!wsOpen[key] : current || inGroup.some((s) => s.id === activeId));
        const label = key ? labels.get(key) : 'Other';
        const tip = key || 'No recorded folder: started with no folder open, or before folders were recorded';
        const newTip = key ? 'New session in ' + label : 'New session';
        html += '<div class="ws-group' + (open ? ' open' : '') + (current ? ' current' : '') + '">' +
          '<div class="ws-header">' +
          '<button class="ws-toggle" type="button" data-ws="' + escapeHtml(key) + '" aria-expanded="' + open +
          '" title="' + escapeHtml(tip) + '"><span class="ws-name">' + escapeHtml(label) + '</span>' + CHEVRON + '</button>' +
          (current
            ? '<button class="ws-new" type="button" title="' + escapeHtml(newTip) + '" aria-label="' + escapeHtml(newTip) + '">' + PLUS + '</button>'
            : '') +
          '</div><div class="ws-rows">' +
          (inGroup.length ? inGroup.map((s) => rowHtml(s, now)).join('') : '<div class="ws-empty">No sessions yet</div>') +
          '</div></div>';
      }
      return html;
    }

    listEl.addEventListener('click', (event) => {
      const toggle = event.target.closest('.ws-toggle');
      if (toggle) {
        const group = toggle.closest('.ws-group');
        const open = !group.classList.contains('open');
        group.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', String(open));
        // A search opens every group it matches; that is not the user's choice.
        if (!query.trim()) {
          wsOpen = { ...wsOpen, [toggle.getAttribute('data-ws') || '']: open };
          vscode.setState({ ...(vscode.getState() || {}), wsOpen });
        }
        return;
      }
      if (event.target.closest('.ws-new')) {
        vscode.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
        return;
      }
      const deleteBtn = event.target.closest('.row-delete');
      if (deleteBtn) {
        event.stopPropagation();
        const id = deleteBtn.getAttribute('data-delete-id');
        if (id) vscode.postMessage({ type: MESSAGE_TYPES.DELETE_CHAT_HISTORY, sessionId: id });
        return;
      }
      const row = event.target.closest('.row');
      if (!row) return;
      const id = row.getAttribute('data-id');
      if (id) vscode.postMessage({ type: MESSAGE_TYPES.LOAD_CHAT_SESSION, sessionId: id });
    });
  </script>
</body>
</html>`;
  }
}
