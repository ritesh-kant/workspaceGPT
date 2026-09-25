import { MyTicketsResult, TicketDetail, TrackerKind } from './types';

/**
 * A ticket tracker. One implementation per vendor (AdoTicketProvider today,
 * JiraTicketProvider in docs/design/jira.md §5).
 *
 * Deliberately NOT on this interface: sync/indexing into the RAG index, auth
 * UI, org/project discovery. Those stay per-provider, reached through the
 * existing message-handler path — see design doc §2 principle 1 for why the
 * sync worker specifically is not part of this seam (WIQL batching and JQL
 * token pagination differ enough that a shared base class would be two
 * implementations wearing one coat).
 */
export interface TicketProvider {
  /** Stable key: 'ado' | 'jira'. Used for storage keys, namespaces, telemetry. */
  readonly kind: TrackerKind;
  /** Display name for the context picker and Settings ('Azure DevOps', 'Jira'). */
  readonly label: string;

  /** Is this tracker authenticated right now? Feeds ToolAvailability. */
  isConnected(): Promise<boolean>;

  /** One ticket, live and complete — the `get_ticket` tool's path. */
  fetchTicket(id: string, opts: { includeComments: boolean }): Promise<TicketDetail>;

  /** Tickets assigned to the current user — the My Work panel. */
  listMyTickets(): Promise<MyTicketsResult>;

  /**
   * Post the run's report back on the ticket. `markdown` is plain markdown;
   * the provider renders it to whatever its own API wants (ADO: an HTML
   * subset via reportToHtml; Jira: ADF).
   */
  addComment(id: string, markdown: string): Promise<void>;

  /** User-typed reference → canonical id, or throws with a usable message. */
  parseId(raw: string): string;

  /** Deep link to the ticket in the vendor's UI, or null when not configured. */
  ticketUrl(id: string): string | null;

  /** Ids this provider recognises in free text / search hits, for referenceIndex.ts. */
  readonly idPatterns: {
    /** Matches the ticket's own URL shape; capture group 1 is the id. */
    url: RegExp;
    /** Matches the RAG index's filename convention for this tracker's items ('ADO-<id>'). */
    filename: RegExp;
  };

  /** Commit trailer that links a commit to this ticket ('AB#123' for ADO, the bare key for Jira). */
  commitTrailer(id: string): string;
}
