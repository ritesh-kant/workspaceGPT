import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { TicketProvider } from '../tickets/TicketProvider';
import { MyTicketsResult, TicketDetail } from '../tickets/types';
import { JiraAuthService, normalizeSiteUrl } from './jiraAuthService';
import { addJiraComment, fetchJiraIssue, parseIssueKey } from './jiraIssueService';

/** Jira issue urls, for lifting the key back out of a search hit — mirrors ADO_URL_ID_RE's role in referenceIndex.ts. */
const JIRA_URL_ID_RE = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i;
/** A future Jira sync's index would name each item this way — mirrors ADO_FILENAME_ID_RE (see adoWorker.ts); nothing produces these yet (design doc P5). */
const JIRA_FILENAME_ID_RE = /\bJIRA-([A-Za-z][A-Za-z0-9_]*-\d+)\b/;

/**
 * The `TicketProvider` seam over Jira Cloud.
 *
 * fetchTicket/addComment are real (JIRA-INTEGRATION-DESIGN.md §5 P4).
 * listMyTickets is not: "your work" needs sprint detection through Jira's
 * Agile API with per-site board discovery, which is its own phase (§5 P6) —
 * throwing here rather than returning an empty/wrong list is the honest
 * choice for a method nothing in the currently-wired call graph invokes yet
 * (the My Work panel still only calls ADO's listMyWorkItems directly; see
 * the P1 commit message for why that wiring is deferred to P6/P7).
 */
export class JiraTicketProvider implements TicketProvider {
  readonly kind = 'jira' as const;
  readonly label = 'Jira';
  readonly idPatterns = { url: JIRA_URL_ID_RE, filename: JIRA_FILENAME_ID_RE };

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isConnected(): Promise<boolean> {
    return new JiraAuthService(this.context).isAuthenticated();
  }

  fetchTicket(id: string, opts: { includeComments: boolean }): Promise<TicketDetail> {
    return fetchJiraIssue(this.context, { id, includeComments: opts.includeComments });
  }

  async listMyTickets(): Promise<MyTicketsResult> {
    throw new Error('Jira "your work" is not implemented yet — see JIRA-INTEGRATION-DESIGN.md §5 P6.');
  }

  async addComment(id: string, markdown: string): Promise<void> {
    await addJiraComment(this.context, parseIssueKey(id), markdown);
  }

  parseId(raw: string): string {
    return parseIssueKey(raw);
  }

  ticketUrl(id: string): string | null {
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const siteUrl = settings?.state?.config?.jira?.siteUrl;
    if (!siteUrl) return null;
    return `${normalizeSiteUrl(siteUrl)}/browse/${encodeURIComponent(id)}`;
  }

  /** Jira's smart-commit syntax takes the bare key, unlike ADO's `AB#123`. */
  commitTrailer(id: string): string {
    return id;
  }
}
