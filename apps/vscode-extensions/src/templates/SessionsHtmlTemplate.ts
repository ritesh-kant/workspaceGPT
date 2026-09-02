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
    }
    .new-session {
      margin: 8px 10px 6px;
      width: calc(100% - 20px);
      height: 28px;
      border-radius: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, rgba(128,128,128,0.35)));
      background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .new-session:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .search {
      display: none;
      align-items: center;
      gap: 6px;
      margin: 0 10px 6px;
      padding: 0 8px;
      height: 26px;
      border-radius: 4px;
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
    .list {
      flex: 1;
      overflow-y: auto;
      padding: 2px 0 8px;
    }
    .empty {
      padding: 24px 12px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      text-transform: none;
    }
    .group-count { font-weight: 500; opacity: 0.8; }
    .row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 12px;
      cursor: pointer;
      border: none;
      width: 100%;
      text-align: left;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.active { background: var(--vscode-list-hoverBackground); }
    .dot {
      width: 7px;
      height: 7px;
      margin-top: 5px;
      border-radius: 50%;
      flex-shrink: 0;
      background: transparent;
    }
    .row.active .dot {
      background: var(--vscode-charts-green, #89d185);
    }
    .row-body { min-width: 0; flex: 1; }
    .title {
      font-size: 13px;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-top: 2px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .age { opacity: 0.9; }
    .diffs { display: flex; gap: 6px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .added { color: var(--vscode-charts-green, #3fb950); }
    .removed { color: var(--vscode-charts-red, #f85149); }
  </style>
</head>
<body>
  <div class="wrap">
    <button class="new-session" id="newSession" type="button">New Session</button>
    <div class="search" id="searchWrap">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
        <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <input id="search" type="search" placeholder="Search sessions" aria-label="Search sessions" />
    </div>
    <div class="list" id="list"></div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const MESSAGE_TYPES = ${JSON.stringify({
      NEW_CHAT: MESSAGE_TYPES.NEW_CHAT,
      LOAD_CHAT_SESSION: MESSAGE_TYPES.LOAD_CHAT_SESSION,
      SESSIONS_LIST: MESSAGE_TYPES.SESSIONS_LIST,
      SESSIONS_TOGGLE_SEARCH: MESSAGE_TYPES.SESSIONS_TOGGLE_SEARCH,
    })};
    let sessions = [];
    let activeId = null;
    let query = '';

    const listEl = document.getElementById('list');
    const searchWrap = document.getElementById('searchWrap');
    const searchInput = document.getElementById('search');

    document.getElementById('newSession').addEventListener('click', () => {
      vscode.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
    });
    searchInput.addEventListener('input', (e) => {
      query = e.target.value || '';
      render();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type === MESSAGE_TYPES.SESSIONS_LIST) {
        sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        if (msg.activeSessionId !== undefined) activeId = msg.activeSessionId || null;
        render();
      }
      if (msg.type === MESSAGE_TYPES.SESSIONS_TOGGLE_SEARCH) {
        const on = !searchWrap.classList.contains('visible');
        searchWrap.classList.toggle('visible', on);
        if (on) searchInput.focus();
        else {
          query = '';
          searchInput.value = '';
          render();
        }
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
      if (minutes < 1) return 'Just now';
      if (minutes < 60) return minutes + 'm ago';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + 'h ago';
      const days = Math.floor(hours / 24);
      if (days === 1) return '1 day ago';
      if (days < 7) return days + ' days ago';
      const weeks = Math.floor(days / 7);
      if (days < 30) return weeks === 1 ? '1 wk ago' : weeks + ' wk ago';
      const months = Math.floor(days / 30);
      if (months < 12) return months === 1 ? '1 mo ago' : months + ' mo ago';
      const years = Math.floor(days / 365);
      return years === 1 ? '1 yr ago' : years + ' yr ago';
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
        html += '<div class="group-header"><span>' + label + '</span><span class="group-count">' +
          items.length + '</span></div>';
        for (const session of items) {
          const active = session.id === activeId ? ' active' : '';
          const added = Number(session.added) || 0;
          const removed = Number(session.removed) || 0;
          let diffs = '';
          if (added > 0 || removed > 0) {
            diffs = '<span class="diffs">';
            if (added > 0) diffs += '<span class="added">+' + added + '</span>';
            if (removed > 0) diffs += '<span class="removed">-' + removed + '</span>';
            diffs += '</span>';
          }
          html += '<button class="row' + active + '" type="button" data-id="' + escapeHtml(session.id) + '">' +
            '<span class="dot"></span>' +
            '<span class="row-body">' +
              '<div class="title">' + escapeHtml(session.title || 'New Chat') + '</div>' +
              '<div class="meta"><span class="age">' + escapeHtml(formatAge(session.updatedAt || 0, now)) + '</span>' +
              diffs + '</div>' +
            '</span></button>';
        }
      }
      listEl.innerHTML = html;
    }

    listEl.addEventListener('click', (event) => {
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
