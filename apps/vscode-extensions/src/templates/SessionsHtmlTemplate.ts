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
    /* Chat / Work switch: two icon segments, the active one filled. */
    .mode-switch {
      display: flex;
      flex-shrink: 0;
    }
    .nav-row { display: flex; align-items: center; gap: 4px; }
    .nav-row .nav-item { flex: 1; min-width: 0; width: auto; }
    .mode-switch-group {
      display: flex;
      gap: 2px;
      padding: 1px;
      border-radius: 7px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    }
    .mode-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 22px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .mode-btn:hover { color: var(--vscode-foreground); }
    .mode-btn.on {
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-foreground);
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
      padding: 26px 18px 12px;
      font-size: 12px;
      font-weight: 400;
      letter-spacing: 0.08em;
      text-transform: uppercase;
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
    .ws-group.open > .ws-header .ws-chevron { transform: rotate(90deg); }
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
    .ws-folder { flex: none; opacity: 0.8; }
    .ws-rows { display: none; padding-left: 12px; }
    .ws-group.open > .ws-rows { display: block; }
    .ws-empty {
      padding: 4px 8px 6px 32px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    /* Shared sidebar rhythm: notes and chats use the same two-line rows. */
    .list { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .list > .ws-group { margin: 0 2px 12px; }
    .ws-group > .ws-header { margin-top: 8px; }
    .ws-group > .ws-header > .ws-toggle {
      height: 46px;
      padding: 0 8px;
      gap: 8px;
      border-radius: 8px;
      color: var(--vscode-foreground);
      font-size: 14px;
      font-weight: 600;
    }
    .ws-group.current > .ws-header > .ws-toggle {
      color: var(--vscode-textLink-foreground);
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent);
    }
    .note-icon { flex: none; }
    .ws-group > .ws-header .ws-count { margin-left: auto; font-size: 13px; font-weight: 600; opacity: 1; }
    .ws-group > .ws-header .ws-chevron { margin-left: auto; }
    .ws-group > .ws-header .ws-count + .ws-chevron { margin-left: 0; }
    .ws-group > .ws-header:hover { background: transparent; }
    .ws-group > .ws-header > .ws-toggle:hover { background: var(--vscode-list-hoverBackground); }
    .note-day {
      padding: 10px 10px 4px;
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .row {
      position: relative;
      align-items: flex-start;
      min-height: 66px;
      margin: 4px 0;
      padding: 12px 10px;
      border: 1px solid transparent;
      border-radius: 8px;
    }
    .row.active {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.2));
      box-shadow: 0 2px 5px rgba(0,0,0,0.03);
    }
    .row-content { display: flex; flex-direction: column; gap: 6px; min-width: 0; width: 100%; padding-right: 16px; }
    .row .title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      white-space: normal;
      overflow-wrap: anywhere;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.45;
    }
    /* Project chats are compact single-line rows; time and diffs stay on call notes. */
    .row.note { min-height: 0; margin: 1px 0; padding: 7px 10px; }
    .row.note .row-content { gap: 2px; }
    .row.note .title { font-size: 13px; line-height: 1.35; -webkit-line-clamp: 1; }
    .row.note .meta { font-size: 11px; line-height: 1.3; }
    .row.note .row-delete { bottom: 6px; }
    .ws-group > .ws-header > .ws-toggle { height: 34px; }
    .list > .ws-group { margin-bottom: 4px; }
    .row:not(.note) { min-height: 0; margin: 1px 0; padding: 7px 10px; align-items: center; }
    .row.active:not(.note) {
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
      border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 35%, transparent);
      box-shadow: none;
    }
    .row.active:not(.note) .title { color: var(--vscode-textLink-foreground); }
    .row:not(.note) .row-content { padding-right: 0; gap: 0; }
    .row:not(.note) .title { -webkit-line-clamp: 1; font-size: 13px; font-weight: 400; line-height: 1.4; }
    .row:not(.note) .meta { display: none; }
    .row:not(.note) .row-delete { bottom: auto; top: 50%; transform: translateY(-50%); }
    .row .meta { flex-wrap: wrap; font-size: 12px; line-height: 1.4; opacity: 1; color: var(--vscode-descriptionForeground); }
    .row .dot { display: none; }
    .row:is(.recording, .running, .completed, .errored) .dot { display: flex; position: absolute; right: 6px; top: 6px; }
    .row .row-delete { position: absolute; right: 5px; bottom: 8px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
    .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .row:focus-within .row-delete { display: flex; }
    .list .show-more { padding: 8px 10px; }
    .ws-count {
      flex-shrink: 0;
      font-size: 11px;
      font-weight: normal;
      opacity: 0.75;
    }
    .row.note.recording .dot::before {
      background: var(--vscode-charts-red, #f85149);
      animation: dot-pulse 1.2s ease-in-out infinite;
    }
    .row.note.recording .meta { color: var(--vscode-charts-red, #f85149); }
    .show-more {
      display: block;
      width: 100%;
      padding: 4px 8px 6px 32px;
      border: 0;
      background: transparent;
      text-align: left;
      font: inherit;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .show-more:hover { color: var(--vscode-foreground); }
    .row-input {
      flex: 1;
      min-width: 0;
      padding: 1px 5px;
      font: inherit;
      font-size: 13px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 3px;
      outline: none;
    }
    .menu {
      position: fixed;
      z-index: 1000;
      min-width: 180px;
      padding: 4px;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
      border-radius: 6px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    }
    .menu-item {
      display: flex;
      justify-content: space-between;
      gap: 1.5rem;
      width: 100%;
      padding: 5px 10px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, inherit);
    }
    .menu-item.danger { color: var(--vscode-errorForeground); }
    .menu-title { padding: 4px 10px; opacity: 0.6; font-size: 11px; }
    .menu-sep { height: 1px; margin: 4px 0; background: var(--vscode-widget-border, rgba(128,128,128,0.3)); }
    .menu .row-input { width: calc(100% - 8px); margin: 2px 4px 4px; flex: none; }
    .added { color: var(--vscode-charts-green, #3fb950); }
    .removed { color: var(--vscode-charts-red, #f85149); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <div class="nav-row">
        <button class="nav-item" id="newSession" type="button">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <span>New Session</span>
        </button>
        <div class="mode-switch">
        <div class="mode-switch-group" role="group" aria-label="Chat or Work mode">
          <button class="mode-btn" id="modeChat" type="button" data-mode="chat" title="Chat" aria-label="Chat" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="mode-btn" id="modeWork" type="button" data-mode="work" title="Work" aria-label="Work" aria-pressed="false">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      </div>
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
      SET_ASSISTANT_MODE: MESSAGE_TYPES.SET_ASSISTANT_MODE,
      DELETE_CHAT_HISTORY: MESSAGE_TYPES.DELETE_CHAT_HISTORY,
      UPDATE_CHAT_SESSION_META: MESSAGE_TYPES.UPDATE_CHAT_SESSION_META,
      OPEN_SESSION_IN: MESSAGE_TYPES.OPEN_SESSION_IN,
      OPEN_CALL_NOTE: MESSAGE_TYPES.OPEN_CALL_NOTE,
      DELETE_CALL_NOTE: MESSAGE_TYPES.DELETE_CALL_NOTE,
      RENAME_CALL_NOTE: MESSAGE_TYPES.RENAME_CALL_NOTE,
    })};
    let sessions = [];
    let activeId = null;
    // Call notes (services/callNotes.ts CallNoteSummary), newest first; only the desktop app records them.
    let callNotes = [];
    let activeNoteId = null;
    let query = '';
    let runningIds = new Set();
    let completedIds = new Set();
    let erroredIds = new Set();
    let mode = 'work';
    let currentWorkspace = '';
    // Folder groups the user opened or closed by hand; the rest default to
    // open for the folder that is open now (and the active session's).
    let wsOpen = (vscode.getState() || {}).wsOpen || {};
    // Each group lists PAGE_SIZE chats and grows by that much per click on
    // "Show more"; a search lists every match.
    const PAGE_SIZE = 20;
    let shown = {};

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
        callNotes = Array.isArray(msg.callNotes) ? msg.callNotes : [];
        if (msg.activeSessionId !== undefined) activeId = msg.activeSessionId || null;
        if (msg.activeNoteId !== undefined) activeNoteId = msg.activeNoteId || null;
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

    function renderModeSwitch() {
      for (const btn of document.querySelectorAll('.mode-btn')) {
        const on = btn.getAttribute('data-mode') === mode;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
    }
    document.querySelector('.mode-switch').addEventListener('click', (event) => {
      const btn = event.target.closest('.mode-btn');
      if (!btn) return;
      const next = btn.getAttribute('data-mode');
      if (next === mode) return;
      mode = next;
      renderModeSwitch();
      vscode.postMessage({ type: MESSAGE_TYPES.SET_ASSISTANT_MODE, assistantMode: next });
    });

    function render() {
      renderModeSwitch();
      const now = Date.now();
      const needle = query.trim().toLowerCase();
      const matching = needle
        ? sessions.filter((s) => String(s.title || '').toLowerCase().includes(needle))
        : sessions;

      // Pinned chats and user-made groups sit above everything else.
      const pinned = matching.filter((s) => s.pinned);
      const filed = new Map();
      for (const s of matching) {
        if (s.pinned || !s.group) continue;
        if (!filed.has(s.group)) filed.set(s.group, []);
        filed.get(s.group).push(s);
      }
      const rest = matching.filter((s) => !s.pinned && !s.group);
      // Call notes first: a call being recorded is the thing to see.
      let top = callNotesHtml(now);
      if (pinned.length) top += customGroupHtml('pin:', 'Pinned', pinned, now);
      for (const name of [...filed.keys()].sort()) top += customGroupHtml('grp:' + name, name, filed.get(name), now);

      const byFolder = mode === 'work' ? workspaceGroupsHtml(rest, now, !!needle) : '';
      if (byFolder) {
        listEl.innerHTML = top + byFolder;
        return;
      }

      if (top && !rest.length) {
        listEl.innerHTML = top;
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
      for (const session of rest) {
        const label = bucketLabel(session.updatedAt || 0, now);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(session);
      }

      let html = '';
      for (const label of BUCKET_ORDER) {
        const items = groups.get(label);
        if (!items || !items.length) continue;
        html += '<div class="group-header">' + label + '</div>';
        html += rowsHtml('bucket:' + label, items, now);
      }
      listEl.innerHTML = top + html;
    }

    /** The first rows of a group, newest first as given, plus a button for the rest. */
    function rowsHtml(key, items, now) {
      if (query.trim()) return items.map((s) => rowHtml(s, now)).join('');
      // The open chat stays visible even when it is past the page.
      const activeAt = items.findIndex((s) => s.id === activeId);
      const limit = Math.max(shown[key] || PAGE_SIZE, activeAt + 1);
      let html = items.slice(0, limit).map((s) => rowHtml(s, now)).join('');
      const left = items.length - limit;
      if (left > 0) {
        html += '<button class="show-more" type="button" data-more="' + escapeHtml(key) + '" data-shown="' + limit + '">Show ' +
          Math.min(PAGE_SIZE, left) + ' more</button>';
      }
      return html;
    }

    function customGroupHtml(key, label, items, now) {
      const open = !!query.trim() || !(key in wsOpen) || !!wsOpen[key];
      return '<div class="ws-group' + (open ? ' open' : '') + '"><div class="ws-header">' +
        '<button class="ws-toggle" type="button" data-ws="' + escapeHtml(key) + '" aria-expanded="' + open + '">' +
        '<span class="ws-name">' + escapeHtml(label) + '</span>' + CHEVRON + '</button></div>' +
        '<div class="ws-rows">' + rowsHtml(key, items, now) + '</div></div>';
    }

    const NOTES_PAGE = 10;
    /** The title the recorder gives a call; a row shows its times instead, as the day is already a header. */
    const DEFAULT_NOTE_TITLE = /^Call on /;

    function noteDayLabel(ts, now) {
      const today = startOfDay(now);
      if (ts >= today) return 'Today';
      if (ts >= today - 86400000) return 'Yesterday';
      const d = new Date(ts);
      const sameYear = d.getFullYear() === new Date(now).getFullYear();
      return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
    }

    function clock(ts) {
      return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function callLength(ms) {
      const m = Math.round(ms / 60000);
      if (m < 1) return '<1 min';
      if (m < 60) return m + ' min';
      return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    }

    /** Every call note, in one collapsible group with a line per day; nothing when there are none. */
    function callNotesHtml(now) {
      const needle = query.trim().toLowerCase();
      const notes = needle
        ? callNotes.filter((n) => (String(n.title || '') + ' ' + String(n.preview || '')).toLowerCase().includes(needle))
        : callNotes;
      if (!notes.length) return '';
      const key = 'notes:';
      const short = needle ? [] : notes.filter((n) => n.status !== 'recording' && (!n.turnCount || (n.endedAt && n.endedAt - n.startedAt < 60000)));
      const primary = notes.filter((n) => !short.includes(n));
      // Search may reveal matches, but redraws must preserve a manual collapse,
      // including while a call is recording.
      const open = !!needle || !(key in wsOpen) || !!wsOpen[key];
      const activeAt = primary.findIndex((n) => n.id === activeNoteId);
      const limit = needle ? primary.length : Math.max(shown[key] || NOTES_PAGE, activeAt + 1);
      let body = '';
      let day = '';
      for (const n of primary.slice(0, limit)) {
        const label = noteDayLabel(n.startedAt || 0, now);
        if (label !== day) {
          day = label;
          body += '<div class="note-day">' + escapeHtml(label) + '</div>';
        }
        body += noteRowHtml(n);
      }
      const left = primary.length - limit;
      if (left > 0) {
        body += '<button class="show-more" type="button" data-more="' + key + '" data-shown="' + limit + '">Show ' +
          Math.min(PAGE_SIZE, left) + ' more</button>';
      }
      if (short.length) {
        const shortKey = 'notes:short';
        const shortOpen = shortKey in wsOpen ? !!wsOpen[shortKey] : short.some((n) => n.id === activeNoteId);
        const shortLimit = Math.max(shown[shortKey] || NOTES_PAGE, short.findIndex((n) => n.id === activeNoteId) + 1);
        let rows = '';
        let shortDay = '';
        for (const note of short.slice(0, shortLimit)) {
          const label = noteDayLabel(note.startedAt || 0, now);
          if (label !== shortDay) { shortDay = label; rows += '<div class="note-day">' + escapeHtml(label) + '</div>'; }
          rows += noteRowHtml(note);
        }
        if (short.length > shortLimit) rows += '<button class="show-more" type="button" data-more="' + shortKey + '" data-shown="' + shortLimit + '">Show more</button>';
        body += '<div class="ws-group' + (shortOpen ? ' open' : '') + '"><div class="ws-header"><button class="ws-toggle" type="button" data-ws="' + shortKey + '" aria-expanded="' + shortOpen + '"><span class="ws-name">Short captures</span><span class="ws-count">' + short.length + '</span>' + CHEVRON + '</button></div><div class="ws-rows">' + rows + '</div></div>';
      }
      return '<div class="ws-group notes' + (open ? ' open' : '') + (notes.some((n) => n.id === activeNoteId) ? ' current' : '') + '"><div class="ws-header">' +
        '<button class="ws-toggle" type="button" data-ws="' + key + '" aria-expanded="' + open + '">' +
        '<svg class="note-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M2 8h4M2 12h4M2 16h4M16 3l5 5M11 13l1-5 6-6a2 2 0 0 1 3 3l-6 6-4 2Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="ws-name">Call notes</span><span class="ws-count">' + notes.length + '</span>' + CHEVRON + '</button></div>' +
        '<div class="ws-rows">' + body + '</div></div>';
    }

    function noteRowHtml(n) {
      const rec = n.status === 'recording';
      const span = clock(n.startedAt || 0) + (n.endedAt ? ' – ' + clock(n.endedAt) : '');
      const named = n.title && !DEFAULT_NOTE_TITLE.test(n.title);
      const main = named ? n.title : (n.preview ? n.preview.slice(0, 70) : 'Call at ' + clock(n.startedAt || 0));
      const length = n.endedAt ? callLength(n.endedAt - n.startedAt) : '';
      const meta = rec ? 'Taking notes' : clock(n.startedAt || 0) + (length ? ' · ' + length : '');
      const tip = (n.title || 'Call') + (named ? ' (' + span + ')' : '') + (n.preview ? '\\n' + n.preview : '');
      return '<button class="row note' + (rec ? ' recording' : '') + (n.id === activeNoteId ? ' active' : '') +
        '" type="button" title="' + escapeHtml(tip) + '" data-note-id="' + escapeHtml(n.id) + '" aria-current="' + (n.id === activeNoteId ? 'true' : 'false') + '">' +
        '<span class="dot"></span>' +
        '<span class="row-content"><span class="title">' + escapeHtml(main) + '</span>' +
        '<span class="meta"><span class="age">' + escapeHtml(meta) + '</span></span></span>' +
        '<span class="row-delete" data-delete-note="' + escapeHtml(n.id) + '" title="' + (rec ? 'Stop and delete' : 'Delete call note') +
        '" role="button" aria-label="Delete call note">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg></span>' +
        '</button>';
    }

    function startNoteRename(id) {
      const row = listEl.querySelector('.row.note[data-note-id="' + CSS.escape(id) + '"]');
      const note = callNotes.find((n) => n.id === id);
      const titleEl = row && row.querySelector('.title');
      if (!titleEl || !note) return;
      const input = document.createElement('input');
      input.className = 'row-input';
      input.value = note.title || '';
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save && input.value.trim()) vscode.postMessage({ type: MESSAGE_TYPES.RENAME_CALL_NOTE, id, title: input.value });
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      titleEl.replaceWith(input);
      input.focus();
      input.select();
    }

    function showNoteMenu(id, x, y) {
      closeMenu();
      const note = callNotes.find((n) => n.id === id);
      if (!note) return;
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      const add = (label, onClick, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.addEventListener('click', () => { closeMenu(); onClick(); });
        menu.appendChild(b);
      };
      add('Open', () => openNote(id));
      add('Rename', () => startNoteRename(id));
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      add(note.status === 'recording' ? 'Stop and delete' : 'Delete', () => vscode.postMessage({ type: MESSAGE_TYPES.DELETE_CALL_NOTE, id }), 'danger');
      document.body.appendChild(menu);
      menuEl = menu;
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    }

    function openNote(id) {
      activeNoteId = id;
      vscode.postMessage({ type: MESSAGE_TYPES.OPEN_CALL_NOTE, id });
      render();
    }

    function rowHtml(session, now) {
      const active = !activeNoteId && session.id === activeId ? ' active' : '';
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
        '<span class="row-content"><span class="title">' + (session.pinned ? '📌 ' : '') + title + '</span>' +
        '<span class="meta"><span class="age">' + age + '</span>' + diffs + '</span></span>' +
        '<span class="row-delete" data-delete-id="' + escapeHtml(session.id) + '" title="Delete chat" role="button" aria-label="Delete chat">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg></span>' +
        '</button>';
    }

    const CHEVRON = '<svg class="ws-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const FOLDER = '<svg class="ws-folder" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
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
        html += '<div class="ws-group' + (open ? ' open' : '') + (current && !activeId && !activeNoteId ? ' current' : '') + '">' +
          '<div class="ws-header">' +
          '<button class="ws-toggle" type="button" data-ws="' + escapeHtml(key) + '" aria-expanded="' + open +
          '" title="' + escapeHtml(tip) + '">' + FOLDER + '<span class="ws-name">' + escapeHtml(label) + '</span>' + CHEVRON + '</button>' +
          '<button class="ws-new" type="button" data-ws="' + escapeHtml(key) + '" title="' + escapeHtml(newTip) + '" aria-label="' + escapeHtml(newTip) + '">' + PLUS + '</button>' +
          '</div><div class="ws-rows">' +
          (inGroup.length ? rowsHtml('ws:' + key, inGroup, now) : '<div class="ws-empty">No sessions yet</div>') +
          '</div></div>';
      }
      return html;
    }

    // Right-click menu. Built by hand: this view has no framework.
    let menuEl = null;
    function closeMenu() {
      if (menuEl) menuEl.remove();
      menuEl = null;
    }
    document.addEventListener('mousedown', (e) => {
      if (menuEl && !menuEl.contains(e.target)) closeMenu();
    });
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
    window.addEventListener('resize', closeMenu);
    listEl.addEventListener('scroll', closeMenu);

    function updateMeta(id, patch) {
      vscode.postMessage({ type: MESSAGE_TYPES.UPDATE_CHAT_SESSION_META, sessionId: id, ...patch });
    }

    function startRename(id) {
      const row = listEl.querySelector('.row[data-id="' + CSS.escape(id) + '"]');
      const session = sessions.find((s) => s.id === id);
      const titleEl = row && row.querySelector('.title');
      if (!titleEl || !session) return;
      const input = document.createElement('input');
      input.className = 'row-input';
      input.value = session.title || '';
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save) updateMeta(id, { title: input.value });
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('click', (e) => e.stopPropagation());
      titleEl.replaceWith(input);
      input.focus();
      input.select();
    }

    function showMenu(id, x, y, view) {
      closeMenu();
      const session = sessions.find((s) => s.id === id);
      if (!session) return;
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      const add = (label, onClick, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-item' + (cls ? ' ' + cls : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        menu.appendChild(b);
      };
      const title = (text) => {
        const t = document.createElement('div');
        t.className = 'menu-title';
        t.textContent = text;
        menu.appendChild(t);
      };
      const sep = () => {
        const d = document.createElement('div');
        d.className = 'menu-sep';
        menu.appendChild(d);
      };
      const go = (next) => () => showMenu(id, x, y, next);
      const run = (fn) => () => { closeMenu(); fn(); };
      const openIn = (target) => run(() => vscode.postMessage({ type: MESSAGE_TYPES.OPEN_SESSION_IN, sessionId: id, target }));
      const groupNames = [...new Set(sessions.map((s) => s.group).filter(Boolean))].sort();

      if (view === 'openIn') {
        title('Open in');
        add('VS Code', openIn('vscode'));
        add('Cursor', openIn('cursor'));
        add('Finder', openIn('finder'));
        sep();
        add('Back', go('main'));
      } else if (view === 'group') {
        title('Move to group');
        for (const name of groupNames) {
          add((name === session.group ? '✓ ' : '') + name, run(() => updateMeta(id, { group: name })));
        }
        add('New group…', go('newGroup'));
        if (session.group) add('Remove from group', run(() => updateMeta(id, { group: '' })));
        sep();
        add('Back', go('main'));
      } else if (view === 'newGroup') {
        title('New group');
        const input = document.createElement('input');
        input.className = 'row-input';
        input.placeholder = 'Group name';
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          const name = input.value.trim();
          if (e.key === 'Enter' && name) run(() => updateMeta(id, { group: name }))();
          if (e.key === 'Escape') closeMenu();
        });
        menu.appendChild(input);
      } else {
        if (session.workspaceFolder) {
          add('Open in  ›', go('openIn'));
          sep();
        }
        add(session.pinned ? 'Unpin' : 'Pin', run(() => updateMeta(id, { pinned: !session.pinned })));
        add('Rename', run(() => startRename(id)));
        add('Move to group  ›', go('group'));
        sep();
        add('Delete', run(() => vscode.postMessage({ type: MESSAGE_TYPES.DELETE_CHAT_HISTORY, sessionId: id })), 'danger');
      }
      document.body.appendChild(menu);
      menuEl = menu;
      const r = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
      const input = menu.querySelector('input');
      if (input) input.focus();
    }

    listEl.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.row');
      if (!row) return;
      event.preventDefault();
      const noteId = row.getAttribute('data-note-id');
      if (noteId) return showNoteMenu(noteId, event.clientX, event.clientY);
      const id = row.getAttribute('data-id');
      if (id) showMenu(id, event.clientX, event.clientY, 'main');
    });

    listEl.addEventListener('click', (event) => {
      if (event.target.closest('.row-input')) return;
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
      const more = event.target.closest('.show-more');
      if (more) {
        const key = more.getAttribute('data-more') || '';
        // Grow from what is on screen, which is more than shown[key] when the open chat was past the page.
        shown = { ...shown, [key]: (Number(more.getAttribute('data-shown')) || PAGE_SIZE) + PAGE_SIZE };
        render();
        return;
      }
      const wsNew = event.target.closest('.ws-new');
      if (wsNew) {
        vscode.postMessage({ type: MESSAGE_TYPES.NEW_CHAT, folder: wsNew.getAttribute('data-ws') || undefined });
        return;
      }
      const noteDelete = event.target.closest('[data-delete-note]');
      if (noteDelete) {
        event.stopPropagation();
        vscode.postMessage({ type: MESSAGE_TYPES.DELETE_CALL_NOTE, id: noteDelete.getAttribute('data-delete-note') });
        return;
      }
      const noteRow = event.target.closest('.row.note');
      if (noteRow) {
        openNote(noteRow.getAttribute('data-note-id'));
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
      if (id) {
        activeNoteId = null;
        activeId = id;
        vscode.postMessage({ type: MESSAGE_TYPES.LOAD_CHAT_SESSION, sessionId: id });
        render();
      }
    });
  </script>
</body>
</html>`;
  }
}
