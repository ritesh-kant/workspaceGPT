import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { getActiveTicketProvider } from '../services/tickets/registry';
import { MyTicketsResult } from '../services/tickets/types';

/**
 * The one message that genuinely doesn't belong to either tracker's own
 * handler: "your work" is a property of whichever tracker is ACTIVE, not of
 * ADO or Jira specifically. This used to live in AdoMessageHandler, calling
 * adoWorkItemService.listMyWorkItems directly — docs/design/jira.md
 * §5 P6 is what finishes that migration (flagged as deferred in the P1
 * commit message) by routing through the same tickets/registry.ts seam
 * get_ticket already uses.
 *
 * The cache key stays ADO_MY_WORK_ITEMS_CACHE (not renamed) — a persisted
 * storage key rename is unforced churn for a cache that is safe to lose, and
 * both AdoMessageHandler's and JiraMessageHandler's disconnect handlers
 * already clear it, so a stale cross-tracker cache never lingers past a
 * disconnect.
 */
export class TicketsMessageHandler {
  private generation = 0;
  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {}

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.GET_MY_WORK_ITEMS:
        await this.handleGetMyWorkItems(!!data.forceRefresh);
        return true;
      default:
        return false;
    }
  }

  /**
   * Answers twice when a cache exists: once immediately from `globalState` so
   * the chat empty state paints without waiting on the network, then again
   * with fresh results. The webview replaces its list on each response, so
   * the second post just supersedes the first.
   *
   * A failed refresh never clears a good cache — the user keeps seeing their
   * tickets and gets told the refresh failed, rather than watching their
   * work disappear because a token expired.
   */
  private async handleGetMyWorkItems(forceRefresh: boolean): Promise<void> {
    const generation = ++this.generation;
    const provider = getActiveTicketProvider(this.context);
    const scope = this.trackerScope();
    const post = (payload: any) => {
      if (generation !== this.generation || scope !== this.trackerScope()) return;
      this.webviewView.webview.postMessage({ tracker: provider?.kind, ...payload });
    };
    // Switched off (or never connected): the cache belongs to a tracker that is
    // no longer active, so it is neither served nor kept for the next one.
    if (!provider) await this.context.globalState.update(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE, undefined);
    const stored = provider
      ? this.context.globalState.get<MyTicketsResult & { trackerScope?: string }>(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE)
      : undefined;
    const cached = stored?.trackerScope === scope ? stored : undefined;

    if (cached && !forceRefresh) {
      post({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        ...cached,
        fromCache: true,
      });
    }

    if (!provider) {
      // No tracker connected — an empty, error-free response is the correct
      // "you have no work" state here, not a thrown error the panel has to
      // render as a failure.
      if (!cached) {
        post({
          type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
          items: [],
          fetchedAt: new Date().toISOString(),
          fromCache: false,
        });
      }
      return;
    }

    try {
      const fresh = await provider.listMyTickets();
      if (generation !== this.generation || scope !== this.trackerScope()) return;
      await this.context.globalState.update(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE, { ...fresh, trackerScope: scope });
      post({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        ...fresh,
        fromCache: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not fetch assigned ${provider.label} work items:`, message);
      post({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        // Keep whatever we already had on screen; flag the staleness instead.
        ...(cached ?? { items: [], fetchedAt: '' }),
        fromCache: !!cached,
        error: message,
      });
    }
  }

  private trackerScope(): string {
    const config = this.context.globalState.get<any>(STORAGE_KEYS.SETTINGS)?.state?.config;
    const kind = getActiveTicketProvider(this.context)?.kind;
    return JSON.stringify(kind === 'ado'
      ? [kind, config?.ado?.orgName, config?.ado?.projectName, config?.ado?.userDisplayName]
      : [kind, config?.jira?.siteUrl, config?.jira?.projectKey, config?.jira?.accountId]);
  }
}
