import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { TicketProvider } from '../tickets/TicketProvider';
import { MyTicketsResult, TicketDetail } from '../tickets/types';
import { addWorkItemComment, fetchWorkItem, listMyWorkItems, parseWorkItemId } from './adoWorkItemService';
import { reportToHtml } from '../agent/shipHelpers';
import { ADO_FILENAME_ID_RE, ADO_URL_ID_RE } from '../agent/referenceIndex';

/**
 * The `TicketProvider` seam over Azure DevOps.
 *
 * A thin adapter, not a reimplementation: every method delegates to the
 * already-existing, already-tested functions in adoWorkItemService.ts. Its
 * job is only to give ADO the same shape a Jira provider will have — see
 * docs/design/jira.md §4.
 */
export class AdoTicketProvider implements TicketProvider {
  readonly kind = 'ado' as const;
  readonly label = 'Azure DevOps';
  readonly idPatterns = { url: ADO_URL_ID_RE, filename: ADO_FILENAME_ID_RE };

  constructor(private readonly context: vscode.ExtensionContext) {}

  async isConnected(): Promise<boolean> {
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    return !!settings?.state?.config?.ado?.isAuthenticated;
  }

  fetchTicket(id: string, opts: { includeComments: boolean }): Promise<TicketDetail> {
    return fetchWorkItem(this.context, { id, includeComments: opts.includeComments });
  }

  listMyTickets(): Promise<MyTicketsResult> {
    return listMyWorkItems(this.context);
  }

  async addComment(id: string, markdown: string): Promise<void> {
    await addWorkItemComment(this.context, id, reportToHtml(markdown));
  }

  parseId(raw: string): string {
    return parseWorkItemId(raw);
  }

  ticketUrl(id: string): string | null {
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const orgName = settings?.state?.config?.ado?.orgName;
    const projectName = settings?.state?.config?.ado?.projectName;
    if (!orgName || !projectName) return null;
    return `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(
      projectName
    )}/_workitems/edit/${encodeURIComponent(id)}`;
  }

  commitTrailer(id: string): string {
    return `AB#${id}`;
  }
}
