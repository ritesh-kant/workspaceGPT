import React, { useEffect, useMemo, useRef, useState } from 'react';
import './ChatHistorySidebar.css';
import { displaySessionTitle, formatRelativeTime, parseTicketTitle } from '../utils/sessionTitle';

interface ChatSessionPreview {
    id: string;
    title: string;
    updatedAt: number;
    /** Which mode the chat was held in. The caller passes only the current mode's sessions. */
    assistantMode?: 'chat' | 'work';
    pinned?: boolean;
    group?: string;
    workspaceFolder?: string;
}

type OpenTarget = 'vscode' | 'cursor' | 'finder';

/** Which screen of the right-click menu is showing. */
type MenuView = 'main' | 'openIn' | 'group' | 'newGroup';

interface MenuState {
    sessionId: string;
    x: number;
    y: number;
    view: MenuView;
}

/** Ticket id → title, from the "Your work" cache, to repair truncated legacy group headers. */
export type TicketTitleLookup = ReadonlyMap<string, string>;

interface ChatHistorySidebarProps {
    isVisible: boolean;
    historyList: ChatSessionPreview[];
    /** Known ticket titles; a group header prefers these over a cut-off stored summary. */
    ticketTitles?: TicketTitleLookup;
    currentSessionId: string | null;
    /** Sessions with a run still going in the background — shown with a live dot. */
    runningSessionIds?: Set<string>;
    onSelectSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string) => void;
    onUpdateSession: (sessionId: string, patch: { title?: string; pinned?: boolean; group?: string }) => void;
    onOpenSessionIn: (sessionId: string, target: OpenTarget) => void;
    onClose: () => void;
}

/**
 * One row in the list: either a single chat, or a ticket with every chat that
 * was started from it. Groups are ordered by their newest chat so a ticket you
 * touched today sits above a one-off question from yesterday.
 */
type HistoryRow =
    | { kind: 'session'; session: ChatSessionPreview; updatedAt: number }
    | { kind: 'ticket'; id: string; summary: string; sessions: ChatSessionPreview[]; updatedAt: number };

/** Chats shown per ticket before the rest collapse behind "Show N more". */
const GROUP_VISIBLE_LIMIT = 2;

function buildRows(sessions: ChatSessionPreview[], ticketTitles?: TicketTitleLookup): HistoryRow[] {
    const tickets = new Map<string, Extract<HistoryRow, { kind: 'ticket' }>>();
    const rows: HistoryRow[] = [];

    for (const session of sessions) {
        const ticket = parseTicketTitle(session.title);
        if (!ticket) {
            rows.push({ kind: 'session', session, updatedAt: session.updatedAt });
            continue;
        }
        let group = tickets.get(ticket.id);
        if (!group) {
            group = { kind: 'ticket', id: ticket.id, summary: ticket.summary, sessions: [], updatedAt: 0 };
            tickets.set(ticket.id, group);
            rows.push(group);
        }
        group.sessions.push(session);
        group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
        // A later save can carry a fuller summary than a legacy 30-char title.
        if (ticket.summary.length > group.summary.length) group.summary = ticket.summary;
    }

    // The ticket cache knows the real title; a stored summary that is a
    // prefix of it (or shorter) was truncated by an older build.
    for (const group of tickets.values()) {
        const known = ticketTitles?.get(group.id);
        if (known && known.length > group.summary.length) group.summary = known;
    }

    // A ticket with a single chat is just a chat — no header, no indentation.
    const flattened: HistoryRow[] = rows.map((row) =>
        row.kind === 'ticket' && row.sessions.length === 1
            ? { kind: 'session', session: row.sessions[0], updatedAt: row.updatedAt }
            : row
    );
    return flattened.sort((a, b) => b.updatedAt - a.updatedAt);
}

function formatSessionMoment(timestamp: number): string {
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(sameYear ? {} : { year: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
    });
}

const TrashIcon: React.FC = () => (
    <svg width='13' height='13' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
        <path d='M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
);

const ChatHistorySidebar: React.FC<ChatHistorySidebarProps> = ({
    isVisible,
    historyList,
    currentSessionId,
    runningSessionIds,
    ticketTitles,
    onSelectSession,
    onDeleteSession,
    onUpdateSession,
    onOpenSessionIn,
    onClose,
}) => {
    const [query, setQuery] = useState('');
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!menu) return;
        const close = () => setMenu(null);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close();
        };
        window.addEventListener('mousedown', onOutside);
        window.addEventListener('blur', close);
        window.addEventListener('keydown', onKey);
        function onOutside(e: MouseEvent) {
            if (!menuRef.current?.contains(e.target as Node)) close();
        }
        return () => {
            window.removeEventListener('mousedown', onOutside);
            window.removeEventListener('blur', close);
            window.removeEventListener('keydown', onKey);
        };
    }, [menu]);

    const groupNames = useMemo(
        () => Array.from(new Set(historyList.map((s) => s.group).filter((g): g is string => !!g))).sort(),
        [historyList]
    );

    const commitRename = () => {
        if (renamingId) onUpdateSession(renamingId, { title: draft });
        setRenamingId(null);
    };
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
    const toggleGroup = (id: string) =>
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const rows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matching = needle
            ? historyList.filter((session) =>
                  displaySessionTitle(session.title, ticketTitles).toLowerCase().includes(needle)
              )
            : historyList;
        const pinned = matching.filter((s) => s.pinned);
        const filed = new Map<string, ChatSessionPreview[]>();
        for (const s of matching) {
            if (s.pinned || !s.group) continue;
            filed.set(s.group, [...(filed.get(s.group) ?? []), s]);
        }
        const rest = matching.filter((s) => !s.pinned && !s.group);
        return {
            pinned,
            groups: Array.from(filed.entries()).sort(([a], [b]) => a.localeCompare(b)),
            rest: buildRows(rest, ticketTitles),
            empty: matching.length === 0,
        };
    }, [historyList, query, ticketTitles]);

    if (!isVisible) return null;

    const renderSession = (session: ChatSessionPreview, nested: boolean) => {
        // Inside a ticket group the ticket is already named, so the only thing
        // that tells one run from the next is when it happened — spell that out
        // as a day and time, with the relative age kept on the right.
        const label = nested ? formatSessionMoment(session.updatedAt) : displaySessionTitle(session.title, ticketTitles);
        return (
            <div
                key={session.id}
                className={`history-item${session.id === currentSessionId ? ' history-item-active' : ''}${
                    nested ? ' history-item--nested' : ''
                }`}
                onClick={() => onSelectSession(session.id)}
                onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ sessionId: session.id, x: e.clientX, y: e.clientY, view: 'main' });
                }}
                role='button'
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelectSession(session.id);
                }}
            >
                <div className='history-item-content'>
                    <span className='history-item-title'>
                        {runningSessionIds?.has(session.id) && (
                            <span className='session-running-dot' title='Still working…' />
                        )}
                        {session.pinned && <span className='history-item-pin' title='Pinned'>📌</span>}
                        {renamingId === session.id ? (
                            <input
                                className='history-rename-input'
                                value={draft}
                                autoFocus
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setDraft(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') commitRename();
                                    if (e.key === 'Escape') setRenamingId(null);
                                }}
                                onBlur={commitRename}
                                aria-label='Chat name'
                            />
                        ) : (
                            label
                        )}
                    </span>
                    {/* A nested row's label is already a date; the relative age
                        would say the same thing twice. */}
                    {!nested && <span className='history-item-date'>{formatRelativeTime(session.updatedAt)}</span>}
                </div>
                <button
                    className='history-item-delete'
                    onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                    }}
                    title='Delete chat'
                    aria-label='Delete chat'
                >
                    <TrashIcon />
                </button>
            </div>
        );
    };

    const renderMenu = () => {
        const session = historyList.find((s) => s.id === menu!.sessionId);
        if (!session) return null;
        const close = () => setMenu(null);
        const go = (view: MenuView) => setMenu({ ...menu!, view });
        const item = (label: string, onClick: () => void, opts: { key?: string; danger?: boolean; submenu?: boolean; checked?: boolean } = {}) => (
            <button
                key={label}
                type='button'
                className={`history-menu-item${opts.danger ? ' history-menu-item--danger' : ''}`}
                onClick={onClick}
            >
                <span>{opts.checked ? '✓ ' : ''}{label}</span>
                {opts.submenu ? <span className='history-menu-hint'>›</span> : opts.key && <span className='history-menu-hint'>{opts.key}</span>}
            </button>
        );
        const startRename = () => {
            setDraft(displaySessionTitle(session.title, ticketTitles));
            setRenamingId(session.id);
            close();
        };
        const moveTo = (group: string) => {
            onUpdateSession(session.id, { group });
            close();
        };

        // Keep the menu inside the panel; it opens at the cursor otherwise.
        const left = Math.max(4, Math.min(menu!.x, window.innerWidth - 200));
        const top = Math.max(4, Math.min(menu!.y, window.innerHeight - 220));

        let content: React.ReactNode;
        if (menu!.view === 'openIn') {
            content = (
                <>
                    <div className='history-menu-title'>Open in</div>
                    {item('VS Code', () => { onOpenSessionIn(session.id, 'vscode'); close(); })}
                    {item('Cursor', () => { onOpenSessionIn(session.id, 'cursor'); close(); })}
                    {item('Finder', () => { onOpenSessionIn(session.id, 'finder'); close(); })}
                    <div className='history-menu-sep' />
                    {item('Back', () => go('main'))}
                </>
            );
        } else if (menu!.view === 'group') {
            content = (
                <>
                    <div className='history-menu-title'>Move to group</div>
                    {groupNames.map((name) => item(name, () => moveTo(name), { checked: name === session.group }))}
                    {item('New group…', () => go('newGroup'))}
                    {session.group && item('Remove from group', () => moveTo(''))}
                    <div className='history-menu-sep' />
                    {item('Back', () => go('main'))}
                </>
            );
        } else if (menu!.view === 'newGroup') {
            content = (
                <>
                    <div className='history-menu-title'>New group</div>
                    <input
                        className='history-rename-input history-menu-input'
                        autoFocus
                        placeholder='Group name'
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            const name = e.currentTarget.value.trim();
                            if (e.key === 'Enter' && name) moveTo(name);
                            if (e.key === 'Escape') close();
                        }}
                        aria-label='Group name'
                    />
                </>
            );
        } else {
            content = (
                <>
                    {session.workspaceFolder && item('Open in', () => go('openIn'), { submenu: true })}
                    {session.workspaceFolder && <div className='history-menu-sep' />}
                    {item(session.pinned ? 'Unpin' : 'Pin', () => { onUpdateSession(session.id, { pinned: !session.pinned }); close(); })}
                    {item('Rename', startRename)}
                    {item('Move to group', () => go('group'), { submenu: true })}
                    <div className='history-menu-sep' />
                    {item('Delete', () => { onDeleteSession(session.id); close(); }, { danger: true })}
                </>
            );
        }
        return (
            <div ref={menuRef} className='history-menu' style={{ left, top }} role='menu' onContextMenu={(e) => e.preventDefault()}>
                {content}
            </div>
        );
    };

    return (
        <div className='history-overlay'>
            <div className='history-sidebar'>
                <div className='history-header'>
                    <h3>History</h3>
                    {/* No "new chat" here: the view's title bar directly above
                        already carries one, and two identical buttons a few
                        pixels apart read as a mistake. */}
                    <div className='history-header-actions'>
                        <button className='history-close-btn' onClick={onClose} title='Close' aria-label='Close history'>
                            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                                <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
                            </svg>
                        </button>
                    </div>
                </div>

                {historyList.length > 0 && (
                    <div className='history-search'>
                        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                            <circle cx='11' cy='11' r='7' stroke='currentColor' strokeWidth='2' />
                            <path d='M20 20l-3.5-3.5' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
                        </svg>
                        <input
                            type='search'
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder='Search chats'
                            aria-label='Search chats'
                        />
                    </div>
                )}

                <div className='history-list'>
                    {historyList.length === 0 ? (
                        <div className='history-empty'>
                            <p>No chats yet</p>
                            <p className='history-empty-subtitle'>Start a conversation to see it here</p>
                        </div>
                    ) : rows.empty ? (
                        <div className='history-empty'>
                            <p>No chats match “{query.trim()}”</p>
                        </div>
                    ) : (
                        <>
                            {rows.pinned.length > 0 && (
                                <div className='history-group'>
                                    <div className='history-group-header'>
                                        <span className='history-group-title'>Pinned</span>
                                    </div>
                                    {rows.pinned.map((session) => renderSession(session, false))}
                                </div>
                            )}
                            {rows.groups.map(([name, sessions]) => (
                                <div key={`group-${name}`} className='history-group'>
                                    <div className='history-group-header'>
                                        <span className='history-group-title'>{name}</span>
                                        <span className='history-group-count'>{sessions.length}</span>
                                    </div>
                                    {sessions.map((session) => renderSession(session, false))}
                                </div>
                            ))}
                            {rows.rest.map((row) =>
                            row.kind === 'session' ? (
                                renderSession(row.session, false)
                            ) : (
                                <div key={`ticket-${row.id}`} className='history-group'>
                                    <div className='history-group-header'>
                                        <span className='history-group-title'>
                                            <span className='history-group-id'>#{row.id}</span>
                                            {row.summary && <span className='history-group-summary'> {row.summary}</span>}
                                        </span>
                                        <span className='history-group-count'>{row.sessions.length} chats</span>
                                    </div>
                                    {(() => {
                                        const sorted = row.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
                                        const expanded = expandedGroups.has(row.id) || query.trim().length > 0;
                                        const shown = expanded ? sorted : sorted.slice(0, GROUP_VISIBLE_LIMIT);
                                        const hidden = sorted.length - shown.length;
                                        return (
                                            <>
                                                {shown.map((session) => renderSession(session, true))}
                                                {(hidden > 0 || (expanded && sorted.length > GROUP_VISIBLE_LIMIT && !query.trim())) && (
                                                    <button
                                                        type='button'
                                                        className='history-group-more'
                                                        onClick={() => toggleGroup(row.id)}
                                                        aria-expanded={expanded}
                                                    >
                                                        {hidden > 0 ? `Show ${hidden} more` : 'Show fewer'}
                                                    </button>
                                                )}
                                            </>
                                        );
                                    })()}
                                </div>
                            )
                        )}
                        </>
                    )}
                </div>
            </div>
            {menu && renderMenu()}
        </div>
    );
};

export default ChatHistorySidebar;
