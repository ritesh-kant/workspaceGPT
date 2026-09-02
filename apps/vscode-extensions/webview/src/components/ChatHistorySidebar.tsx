import React, { useMemo, useState } from 'react';
import './ChatHistorySidebar.css';
import { displaySessionTitle, formatRelativeTime, parseTicketTitle } from '../utils/sessionTitle';

interface ChatSessionPreview {
    id: string;
    title: string;
    updatedAt: number;
}

/** Ticket id → title, from the "Your work" cache, to repair truncated legacy group headers. */
export type TicketTitleLookup = ReadonlyMap<number, string>;

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
        const known = ticketTitles?.get(Number(group.id));
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
    onClose,
}) => {
    const [query, setQuery] = useState('');
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
        return buildRows(matching, ticketTitles);
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
                        {label}
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
                    ) : rows.length === 0 ? (
                        <div className='history-empty'>
                            <p>No chats match “{query.trim()}”</p>
                        </div>
                    ) : (
                        rows.map((row) =>
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
                        )
                    )}
                </div>
            </div>
        </div>
    );
};

export default ChatHistorySidebar;
