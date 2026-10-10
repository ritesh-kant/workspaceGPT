import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { loadHomeActivity, activityRevision } from '../services/home/homeActivityService';
import { HOME_ACTIVITY_MESSAGES } from '../services/home/types';

const SEEN_KEY = 'workspacegpt.homeActivitySeen';
function settingsScope(config: any): string {
  return activityRevision([config?.ado?.isAdoEnabled, config?.ado?.isAuthenticated, config?.ado?.orgName,
    config?.ado?.projectName, config?.ado?.userDisplayName, config?.jira?.isJiraEnabled,
    config?.jira?.isAuthenticated, config?.jira?.siteUrl, config?.jira?.projectKey, config?.jira?.accountId,
    config?.confluence?.isConfluenceEnabled, config?.confluence?.isAuthenticated,
    config?.confluence?.cloudId, config?.confluence?.spaceKey]);
}

export class HomeActivityMessageHandler {
  private generation = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly view: vscode.WebviewView, private readonly context: vscode.ExtensionContext) {}

  public async handleMessage(data: any): Promise<boolean> {
    if (data.type === HOME_ACTIVITY_MESSAGES.seen) {
      // Store only identifiers and revision fingerprints, never activity content.
      if (typeof data.id !== 'string' || data.id.length > 1024 || (data.revision !== null && (typeof data.revision !== 'string' || data.revision.length > 200))) return true;
      this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
        const seen = { ...this.context.globalState.get<Record<string, string>>(SEEN_KEY, {}) };
        delete seen[data.id];
        if (data.revision !== null) seen[data.id] = data.revision;
        await this.context.globalState.update(SEEN_KEY, Object.fromEntries(Object.entries(seen).slice(-1000)));
      });
      await this.writeQueue;
      return true;
    }
    if (data.type !== HOME_ACTIVITY_MESSAGES.get) return false;
    const generation = ++this.generation;
    const config = this.context.globalState.get<any>(STORAGE_KEYS.SETTINGS)?.state?.config;
    const scope = settingsScope(config);
    const confluenceAccount = this.context.globalState.get('confluence-home-account-scope');
    const post = (payload: any) => {
      const latest = this.context.globalState.get<any>(STORAGE_KEYS.SETTINGS)?.state?.config;
      if (generation !== this.generation || scope !== settingsScope(latest) || confluenceAccount !== this.context.globalState.get('confluence-home-account-scope')) return;
      this.view.webview.postMessage({ type: HOME_ACTIVITY_MESSAGES.response, requestId: data.requestId,
        seen: this.context.globalState.get(SEEN_KEY, {}), ...payload });
    };
    // Don't hold up message routing while network work is running. Each section
    // answers independently; stale completions after a tracker switch are dropped.
    void loadHomeActivity(this.context, (section, value) => post({ section, value }))
      .then(() => post({ complete: true }))
      .catch(() => post({ complete: true, error: 'Could not refresh activity. Try again.' }));
    return true;
  }
}
