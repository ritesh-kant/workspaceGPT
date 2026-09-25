import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { AdoTicketProvider } from '../ado/AdoTicketProvider';
import { JiraTicketProvider } from '../jira/JiraTicketProvider';
import { TicketProvider } from './TicketProvider';

/**
 * The tracker connected right now, or null.
 *
 * v1 is single-tracker (docs/design/jira.md §2 principle 5): whichever
 * provider's own settings show it authenticated IS the active one. This is a
 * synchronous settings read, not a live connectivity check — the same
 * contract `toolAvailability.ado` had before this file existed, kept
 * unchanged so gating a turn's tools never costs a network round-trip.
 *
 * ADO is checked first, so a workspace with both somehow configured keeps
 * today's ADO behavior rather than silently switching. The two-trackers-at-
 * once question (§9, out of scope for v1) is what would turn this into
 * something less trivial than "first match wins" — that is why this check
 * stays this small until it is actually decided.
 *
 * JiraTicketProvider.listMyTickets throws (§5 P6 not built yet) — safe to
 * wire in now because nothing in the currently-connected call graph reaches
 * it: the My Work panel still calls ADO's listMyWorkItems directly, and
 * search_tickets still calls searchKnowledge('ADO', ...) unconditionally
 * (see the P1 commit message). Only get_ticket/fetchTicket and the
 * tickets:boolean gate go through this registry today, and both are real for
 * Jira as of P4.
 */
export function getActiveTicketProvider(context: vscode.ExtensionContext): TicketProvider | null {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  if (settings?.state?.config?.ado?.isAuthenticated) {
    return new AdoTicketProvider(context);
  }
  if (settings?.state?.config?.jira?.isAuthenticated) {
    return new JiraTicketProvider(context);
  }
  return null;
}
