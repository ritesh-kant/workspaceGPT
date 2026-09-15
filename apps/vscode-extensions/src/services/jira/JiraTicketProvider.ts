import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { TicketProvider } from '../tickets/TicketProvider';
import { MyTicketsResult, TicketDetail } from '../tickets/types';
import { JiraAuthService, normalizeSiteUrl } from './jiraAuthService';
import { addJiraComment, fetchJiraIssue, parseIssueKey } from './jiraIssueService';
import { listMyJiraTickets } from './jiraMyWorkService';

/** Jira issue urls, for lifting the key back out of a search hit — mirrors ADO_URL_ID_RE's role in referenceIndex.ts. */
const JIRA_URL_ID_RE = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i;
/** A future Jira sync's index would name each item this way — mirrors ADO_FILENAME_ID_RE (see adoWorker.ts); nothing produces these yet (design doc P5). */
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
