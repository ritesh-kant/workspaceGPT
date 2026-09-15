import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { AdoTicketProvider } from '../ado/AdoTicketProvider';
import { TicketProvider } from './TicketProvider';

/**
 * The tracker connected right now, or null.
 *
 * v1 is single-tracker (JIRA-INTEGRATION-DESIGN.md §2 principle 5): whichever
 * provider's own settings show it authenticated IS the active one. This is a
 * synchronous settings read, not a live connectivity check — the same
 * contract `toolAvailability.ado` had before this file existed, kept
 * unchanged so gating a turn's tools never costs a network round-trip.
 *
 * Adding Jira (P2) means adding one more `if` here, in provider-priority
 * order; the two-trackers-at-once question (§9, out of scope for v1) is what
 * turns this into something less trivial, and is exactly why the check stays
 * this small until that is actually decided.
 */
export function getActiveTicketProvider(context: vscode.ExtensionContext): TicketProvider | null {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  if (settings?.state?.config?.ado?.isAuthenticated) {
    return new AdoTicketProvider(context);
  }
  return null;
}
