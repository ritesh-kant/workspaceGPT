import * as vscode from 'vscode';
import { EXTENSION, MESSAGE_TYPES, STORAGE_KEYS, normalizeQdrantUrl } from '../../constants';
import { collapseWorkspaceGptSidebar } from '../utils/collapseSidebar';
import { clearWorkspaceGPTData } from 'src/utils/clearData';
import { AnalyticsService } from '../services/analyticsService';
import { installMcpServer } from '../utils/mcpInstaller';
import { isMcpInstalled } from '../utils/mcpStatusChecker';
import { syncContextKeys } from '../utils/syncContextKeys';
import { preserveHostOwnedSyncFields } from '../utils/syncStateStore';

/**
 * Analytics-only events the webview may report over ONBOARDING_EVENT (mostly
 * onboarding-funnel milestones, but also other UI-side events with no
 * extension-host equivalent, e.g. a blocked send). Allowlisted rather than
 * passed through verbatim: a typo'd name from the webview would otherwise
 * create a permanent junk event in PostHog's schema (and count toward billing).
 */
const ONBOARDING_EVENTS = new Set([
  'onboarding_step_viewed',
  'onboarding_engine_skipped',
  'onboarding_confluence_connect_clicked',
  'onboarding_completed',
  // Send was clicked but blocked client-side (no model / no key) — without
  // this, that dead-end is invisible in PostHog and looks like abandonment.
  'message_blocked_no_model',
]);

export class SystemMessageHandler {
  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {}

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.UPDATE_GLOBAL_STATE:
        await this.updateGlobalState(data);
        return true;
      case MESSAGE_TYPES.GET_GLOBAL_STATE:
        await this.getGlobalState(data);
        return true;
      case MESSAGE_TYPES.CLEAR_GLOBAL_STATE:
        await this.handleClearGlobalState();
        return true;
      case MESSAGE_TYPES.SHOW_SETTINGS:
        this.analyticsService.trackEvent('settings_opened');
        await this.handleShowSettings();
        return true;
      case MESSAGE_TYPES.ONBOARDING_EVENT:
        if (typeof data.event === 'string' && ONBOARDING_EVENTS.has(data.event)) {
          this.analyticsService.trackEvent(data.event, data.properties);
        }
        return true;
      case MESSAGE_TYPES.GET_WORKSPACE_PATH:
        await this.handleGetWorkspacePath();
        return true;
      case MESSAGE_TYPES.SETUP_MCP:
        await this.handleSetupMcp();
        return true;
      case MESSAGE_TYPES.MCP_STATUS:
        await this.handleMcpStatus();
        return true;
      case MESSAGE_TYPES.SHARE_TO_CHROME:
        await vscode.commands.executeCommand(EXTENSION.COMMAND_SHARE_TO_CHROME);
        return true;
      case MESSAGE_TYPES.COPY_DEPLOYMENT_PRESET:
        await vscode.env.clipboard.writeText(data?.json ?? '');
        vscode.window.showInformationMessage('Preset JSON copied to clipboard.');
        return true;
      case MESSAGE_TYPES.TEST_QDRANT_CONNECTION:
        await this.handleTestQdrantConnection(data);
        return true;
      case MESSAGE_TYPES.COLLAPSE_SIDEBAR:
        await collapseWorkspaceGptSidebar(data?.dock);
        return true;
    }
    return false;
  }

  /**
   * One-click liveness check for the Qdrant settings the user is editing. Uses
   * the form's current url+key (not the persisted ones, so it reflects unsaved
   * edits), normalizes the URL, and calls GET /collections. Distinguishes the
   * three failure modes that bite users: wrong URL/port (404), bad key (401/403),
   * and unreachable host — then echoes back the normalized URL it actually used.
   */
  private async handleTestQdrantConnection(data: any): Promise<void> {
    const url = normalizeQdrantUrl(data?.config?.qdrantUrl);
    const apiKey: string = data?.config?.qdrantApiKey ?? '';

    const post = (result: { ok: boolean; detail: string; url?: string }) =>
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.TEST_QDRANT_CONNECTION_RESULT,
        ...result,
      });

    if (!url) {
      post({ ok: false, detail: 'Enter a Qdrant URL first.' });
      return;
    }

    try {
      const res = await fetch(`${url}/collections`, {
        headers: apiKey ? { 'api-key': apiKey } : {},
      });

      if (res.status === 401 || res.status === 403) {
        post({ ok: false, url, detail: `API key rejected (HTTP ${res.status}). Check the key in the cluster's API Keys tab.` });
        return;
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).trim().slice(0, 120);
        const hint = res.status === 404
          ? " — does the URL point at the cluster REST endpoint (with :6333)?"
          : '';
        post({ ok: false, url, detail: `HTTP ${res.status} ${body}${hint}` });
        return;
      }

      const json: any = await res.json().catch(() => ({}));
      const names: string[] = (json?.result?.collections ?? []).map((c: any) => c.name);
      post({
        ok: true,
        url,
        detail: names.length
          ? `Connected — ${names.length} collection${names.length === 1 ? '' : 's'}: ${names.join(', ')}`
          : 'Connected — no collections yet (index a source to create one).',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      post({ ok: false, url, detail: `Could not reach Qdrant: ${msg}` });
    }
  }

  public async reset(): Promise<void> {
    try {
      await clearWorkspaceGPTData(this.context);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.RESET,
      });
      console.log('WorkspaceGPT storage reset.');
    } catch (error) {
      console.error('Error during WorkspaceGPT reset:', error);
      throw error;
    }
  }

  private async updateGlobalState(data: any): Promise<void> {
    // The webview persists the entire settings blob on every store change, so
    // a plain replace would let its once-hydrated (and by now stale) copy of
    // the sync fields overwrite what the host has since written. Keep the
    // persisted values for those keys — the host is their only writer.
    const state =
      data.key === STORAGE_KEYS.SETTINGS
        ? preserveHostOwnedSyncFields(this.context, data.state)
        : data.state;

    await this.context.globalState.update(data.key, state);
    if (data.key === STORAGE_KEYS.SETTINGS) {
      await syncContextKeys(this.context);
    }
  }

  private async getGlobalState(data: any): Promise<void> {
    const config: any = this.context.globalState.get(data.key);
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE,
      key: data.key,
      state: config?.state,
    });
  }

  private async handleClearGlobalState(): Promise<void> {
    try {
      const keys = this.context.globalState.keys();
      for (const key of keys) {
        await this.context.globalState.update(key, undefined);
      }
    } catch (error) {
      console.error('Error clearing global state:', error);
      throw error;
    }
  }

  private async handleSetupMcp(): Promise<void> {
    await installMcpServer(this.context);
    // Reply with updated status so the settings panel reflects the change
    const isInstalled = await isMcpInstalled();
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.MCP_STATUS,
      isInstalled,
    });
  }

  private async handleMcpStatus(): Promise<void> {
    const isInstalled = await isMcpInstalled();
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.MCP_STATUS,
      isInstalled,
    });
  }

  private async handleShowSettings(): Promise<void> {
    try {
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SHOW_SETTINGS,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Error showing settings: ${errorMessage}`);
    }
  }

  private async handleGetWorkspacePath(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (workspaceFolders && workspaceFolders.length > 0) {
        const workspacePath = workspaceFolders[0].uri.fsPath;

        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.WORKSPACE_PATH,
          path: workspacePath,
        });

      } else {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.WORKSPACE_PATH,
          path: '',
          error: 'No workspace is open',
        });
      }
    } catch (error) {
      console.error('Error getting workspace path:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.WORKSPACE_PATH,
        path: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
