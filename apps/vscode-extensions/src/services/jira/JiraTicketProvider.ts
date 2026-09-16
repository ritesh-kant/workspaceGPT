import * as vscode from 'vscode';
import { TicketProvider } from '../tickets/TicketProvider';
import { MyTicketsResult, TicketDetail } from '../tickets/types';
import { JiraAuthService } from './jiraAuthService';
import { addJiraComment, fetchJiraIssue, parseIssueKey } from './jiraIssueService';
import { listMyJiraTickets } from './jiraMyWorkService';

/** Jira issue urls, for lifting the key back out of a search hit — mirrors ADO_URL_ID_RE's role in referenceIndex.ts. */
const JIRA_URL_ID_RE = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i;
/** jiraWorker.ts's sync index names each item this way (`JIRA-${issue.key}`) — mirrors ADO_FILENAME_ID_RE. */
const JIRA_FILENAME_ID_RE = /\bJIRA-([A-Za-z][A-Za-z0-9_]*-\d+)\b/;

/**
 * The `TicketProvider` seam over Jira Cloud. Every method is real as of §5
 * P6 — see jiraMyWorkService.ts for listMyTickets' sprint-detection caveat.
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

  listMyTickets(): Promise<MyTicketsResult> {
    return listMyJiraTickets(this.context);
  }

  async addComment(id: string, markdown: string): Promise<void> {
    await addJiraComment(this.context, parseIssueKey(id), markdown);
  }

  parseId(raw: string): string {
    return parseIssueKey(raw);
  }

  ticketUrl(id: string): string | null {
    const site = new JiraAuthService(this.context).getStoredSite();
    if (!site) return null;
    return `${site.url}/browse/${encodeURIComponent(id)}`;
  }

  /** Jira's smart-commit syntax takes the bare key, unlike ADO's `AB#123`. */
  commitTrailer(id: string): string {
    return id;
  }
}
