/**
 * Session title helpers shared by the history panel and the home view's
 * "Recent chats" list.
 *
 * Titles are derived host-side from the first user message (historyService),
 * and a ticket-seeded prompt begins "Work on ticket 1324128 (Price …". With
 * the old 30-character cut every ticket session read the same, so the list
 * could not tell five runs on one ticket apart. The host now writes
 * "#1324128 Price …" for new saves; this module makes older stored titles
 * read the same way, and groups sessions by ticket for the history panel.
 */

export interface TicketRef {
  id: string;
  summary: string;
}

// The summary runs to the end of the title: a legacy 30-character cut may
// have dropped the closing parenthesis, and a ticket summary can itself
// contain parentheses — cleanSummary() strips the prompt tail and any
// dangling bracket afterwards.
const TICKET_PREFIX = /^work on ticket\s+#?(\d+)\s*(?:\((.*))?$/is;

/** Ticket id and summary out of a raw or already-normalised session title. */
export function parseTicketTitle(title: string): TicketRef | null {
  const trimmed = (title ?? '').trim();
  const legacy = trimmed.match(TICKET_PREFIX);
  if (legacy) {
    return { id: legacy[1], summary: cleanSummary(legacy[2] ?? '') };
  }
  const normalised = trimmed.match(/^#(\d+)\s*(.*)$/);
  if (normalised) {
    return { id: normalised[1], summary: cleanSummary(normalised[2]) };
  }
  return null;
}

function cleanSummary(text: string): string {
  return text
    .replace(/\)\s*(?:—|–|-)\s*read the ticket[\s\S]*$/i, '')
    .replace(/\)\s*autonomously[\s\S]*$/i, '')
    .replace(/\s*(?:—|–)\s*read the ticket[\s\S]*$/i, '')
    .replace(/\.{3}$|…$/, '')
    .replace(/\)$/, '')
    .trim();
}

/**
 * What the list shows for a session: "#1324128 Price rounding…" for ticket
 * runs. `ticketTitles` (id → title, from the "Your work" cache) repairs a
 * summary that an older build cut short.
 */
export function displaySessionTitle(
  title: string,
  ticketTitles?: ReadonlyMap<number, string>
): string {
  const ticket = parseTicketTitle(title);
  if (ticket) {
    const known = ticketTitles?.get(Number(ticket.id));
    const summary = known && known.length > ticket.summary.length ? known : ticket.summary;
    return summary ? `#${ticket.id} ${summary}` : `#${ticket.id}`;
  }
  return (title ?? '').replace(/\.{3}$/, '…').trim() || 'New chat';
}

/**
 * One relative-time format everywhere. The old lists switched to an absolute
 * locale date after a week, so "3d ago" and "25/08/2026" sat in the same
 * column.
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
