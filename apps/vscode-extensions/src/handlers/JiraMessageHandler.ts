import * as vscode from 'vscode';
import * as path from 'path';
import { MESSAGE_TYPES, MODEL, STORAGE_KEYS } from '../../constants';
import { JiraAuthService, jiraApiBase } from '../services/jira/jiraAuthService';
import { JiraService, JiraSyncConfig } from '../services/jira/jiraService';
import { JiraEmbeddingService } from '../services/jira/jiraEmbeddingService';
import { EmbeddingConfig } from '../types/types';
import { AnalyticsService } from '../services/analyticsService';
import { publishSyncState } from '../utils/syncStateStore';
import { deleteDirectory } from 'src/utils/deleteDirectory';

/**
 * Jira Cloud connect/discovery/sync/indexing — JIRA-INTEGRATION-DESIGN.md §5
 * P7 (connect), P5 (sync/indexing, added here). Mirrors AdoMessageHandler's
 * equivalent cases; still no My Work fetch here (§5 P6) — see
 * ticketsMessageHandler.ts for that, which is provider-neutral rather than
 * living in either tracker's own handler.
 *
 * Connect is OAuth 3LO (post-P9), mirroring ConfluenceMessageHandler's
 * START/CANCEL/SUCCESS/ERROR shape rather than the original API-token form.
 */
export class JiraMessageHandler {
  private jiraAuthService: JiraAuthService;
  private jiraService: JiraService;
  private jiraEmbeddingService: JiraEmbeddingService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.jiraAuthService = new JiraAuthService(this.context);
    this.jiraService = new JiraService(this.webviewView, this.context);
    this.jiraEmbeddingService = new JiraEmbeddingService(this.webviewView, this.context);

    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (settings?.state?.config?.jira?.isAuthenticated) {
      console.log('Pre-warming Jira search worker...');
      this.jiraEmbeddingService.ensureSearchWorker().catch((e) => console.error('Failed to pre-warm Jira worker', e));
    }
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.START_JIRA_OAUTH:
        this.analyticsService.trackEvent('jira_oauth_started');
        await this.handleStartJiraOAuth();
        return true;
      case MESSAGE_TYPES.CANCEL_JIRA_OAUTH:
        this.analyticsService.trackEvent('jira_oauth_cancelled');
        await this.handleCancelJiraOAuth();
        return true;
      case MESSAGE_TYPES.DISCONNECT_JIRA:
        this.analyticsService.trackEvent('jira_disconnected');
        await this.handleDisconnect();
        return true;
      case MESSAGE_TYPES.FETCH_JIRA_PROJECTS:
        await this.handleFetchProjects();
        return true;
      case MESSAGE_TYPES.CHECK_JIRA_CONNECTION:
        await this.handleCheckConnection();
        return true;
      case MESSAGE_TYPES.START_JIRA_SYNC:
        await this.handleStartSync(!!data.forceFull);
        return true;
      case MESSAGE_TYPES.RESUME_JIRA_SYNC:
        await this.handleResumeSync();
        return true;
      case MESSAGE_TYPES.STOP_JIRA_SYNC:
        await this.handleStopSync();
        return true;
      case MESSAGE_TYPES.RESUME_INDEXING_JIRA:
        await this.handleResumeIndexing();
        return true;
      default:
        return false;
    }
  }

  private async handleStartJiraOAuth(): Promise<void> {
    try {
      const result = await this.jiraAuthService.startOAuthFlow();
      this.analyticsService.trackEvent('jira_connected');

      // Mirror the discovered site/identity into settings so the rest of the
      // UI (the read-only "Site" field, the sync scheduler's "is configured"
      // gate) keeps reading config.jira.* the same way it always did — only
      // how these fields get POPULATED changed, not who reads them.
      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.jira) {
        settings.state.config.jira.siteUrl = result.site.url;
        settings.state.config.jira.accountId = result.identity.accountId;
        settings.state.config.jira.displayName = result.identity.displayName;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_OAUTH_SUCCESS,
        site: { id: result.site.id, name: result.site.name, url: result.site.url },
        accountId: result.identity.accountId,
        displayName: result.identity.displayName,
      });
      await this.handleFetchProjects();
    } catch (error) {
      console.error('Error in Jira OAuth:', error);
      this.analyticsService.trackEvent('jira_oauth_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_OAUTH_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCancelJiraOAuth(): Promise<void> {
    try {
      await this.jiraAuthService.cancelOAuthFlow();
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_OAUTH_ERROR,
        message: 'Authentication cancelled.',
      });
    } catch (error) {
      console.error('Error cancelling Jira OAuth:', error);
    }
  }

  private async handleDisconnect(): Promise<void> {
    try {
      this.jiraService.stopSync();
      await this.jiraEmbeddingService.stopEmbeddingProcess();

      await this.jiraAuthService.disconnect();

      await this.jiraService.resetSyncProgress();
      await this.jiraEmbeddingService.resetEmbeddingProgress();
      // Drop the "your work" cache too — see ticketsMessageHandler.ts; it's
      // keyed generically, but its content is only ever the ACTIVE tracker's
      // tickets, and Jira is what was active if we're disconnecting it.
      await this.context.globalState.update(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE, undefined);

      const jiraDirPath = path.join(this.context.globalStorageUri.fsPath, 'jira');
      await deleteDirectory(jiraDirPath);

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.jira) {
        settings.state.config.jira = {
          ...settings.state.config.jira,
          isAuthenticated: false,
          siteUrl: '',
          projectKey: '',
          projectName: '',
          availableProjects: [],
          accountId: '',
          displayName: '',
          isSyncing: false,
          isIndexing: false,
          canResume: false,
          canResumeIndexing: false,
          isSyncCompleted: false,
          isIndexingCompleted: false,
          jiraSyncProgress: 0,
          jiraIndexProgress: 0,
          lastSyncTime: '',
          _needsResume: false,
          _needsResumeIndexing: false,
        };
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.DISCONNECT_JIRA,
        success: true,
      });
    } catch (error) {
      console.error('Error disconnecting Jira:', error);
    }
  }

  /**
   * Lists projects so the settings panel can offer a dropdown instead of a
   * typed key. Called both on explicit request and automatically right after
   * a successful connect — a soft failure here (e.g. missing permission)
   * just leaves the dropdown empty and falls back to manual entry, never
   * blocks connecting. Mirrors AdoMessageHandler's handleFetchAdoOrganizations
   * for the same reason.
   */
  private async handleFetchProjects(): Promise<void> {
    try {
      const site = this.jiraAuthService.getStoredSite();
      if (!site) {
        throw new Error('No Jira site connected. Please connect first.');
      }
      const projects = await this.jiraAuthService.fetchProjects(site.id);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS_SUCCESS,
        projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })),
      });
    } catch (error) {
      console.error('Error fetching Jira projects:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCheckConnection(): Promise<void> {
    try {
      const identity = await this.jiraAuthService.checkConnection();
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to Jira as ${identity.displayName}.`,
      });
    } catch (error) {
      this.analyticsService.trackEvent('jira_connection_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async getJiraSyncConfig(): Promise<JiraSyncConfig> {
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const projectKey = settings?.state?.config?.jira?.projectKey;
    const lookbackMonths = settings?.state?.config?.jira?.lookbackMonths ?? 24;
    const site = this.jiraAuthService.getStoredSite();

    if (!site || !projectKey) {
      throw new Error('Jira configuration is incomplete. Please connect.');
    }
    const authHeader = await this.jiraAuthService.getValidAuthHeader();

    return { siteUrl: site.url, apiBase: jiraApiBase(site.id), projectKey, authHeader, lookbackMonths };
  }

  /**
   * Clears the persisted isSyncing/isIndexing flags on a sync error, so a
   * stale "in progress" state doesn't survive a webview/panel reload.
   * Mirrors AdoMessageHandler's clearAdoSyncFlags.
   */
  private async clearSyncFlags(): Promise<void> {
    await publishSyncState(this.context, 'jira', {
      isSyncing: false,
      isIndexing: false,
    });
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    if (settings?.state?.config?.jira) {
      settings.state.config.jira._needsResume = false;
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
    }
  }

  private async handleStartSync(forceFull: boolean = false): Promise<void> {
    try {
      if (forceFull) {
        this.jiraService.stopSync();
        await this.jiraService.resetSyncProgress();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.jira) {
          settings.state.config.jira.lastSyncTime = '';
          settings.state.config.jira._needsResume = false;
          settings.state.config.jira._needsResumeIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
      }

      const jiraConfig = await this.getJiraSyncConfig();

      await publishSyncState(this.context, 'jira', { isSyncing: true });

      await this.jiraService.startSync(
        jiraConfig,
        async () => {
          await this.handleCompleteSync(new Date().toISOString());
        },
        false,
        (error) => {
          console.error('Jira sync worker error:', error.message);
          this.clearSyncFlags().catch((e) => console.error('Failed to clear Jira sync flags:', e));
        },
        () => this.jiraAuthService.getValidAuthHeader()
      );
    } catch (error) {
      console.error('Error in Jira sync:', error);
      this.analyticsService.trackEvent('jira_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_JIRA_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.clearSyncFlags();
    }
  }

  private async handleResumeSync(): Promise<void> {
    try {
      const jiraConfig = await this.getJiraSyncConfig();
      const progress = this.jiraService.getSyncProgress();

      if (!progress || progress.isComplete) {
        await this.handleStartSync();
        return;
      }

      await publishSyncState(this.context, 'jira', { isSyncing: true });

      await this.jiraService.startSync(
        jiraConfig,
        () => this.handleCompleteSync(new Date().toISOString()),
        true,
        (error) => {
          console.error('Jira sync worker error:', error.message);
          this.clearSyncFlags().catch((e) => console.error('Failed to clear Jira sync flags:', e));
        },
        () => this.jiraAuthService.getValidAuthHeader()
      );
    } catch (error) {
      console.error('Error resuming Jira sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_JIRA_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.clearSyncFlags();
    }
  }

  private async handleStopSync(): Promise<void> {
    try {
      this.jiraService.stopSync();
      await this.jiraEmbeddingService.stopEmbeddingProcess();

      await publishSyncState(this.context, 'jira', {
        isSyncing: false,
        isIndexing: false,
      });
      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.jira) {
        settings.state.config.jira._needsResume = false;
        settings.state.config.jira._needsResumeIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }
    } catch (error) {
      console.error('Error stopping Jira sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_JIRA_STOP,
      });
    }
  }

  private async handleCompleteSync(lastSyncTime?: string): Promise<void> {
    try {
      await publishSyncState(this.context, 'jira', {
        ...(lastSyncTime ? { lastSyncTime } : {}),
        isSyncing: false,
        isIndexing: true,
      });

      await this.jiraEmbeddingService.createEmbeddings({
        dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
      } as EmbeddingConfig);
    } catch (error) {
      console.error('Error in Jira indexing:', error);
      await publishSyncState(this.context, 'jira', {
        isSyncing: false,
        isIndexing: false,
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_JIRA_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeIndexing(): Promise<void> {
    try {
      await publishSyncState(this.context, 'jira', { isIndexing: true });

      const progress = this.jiraEmbeddingService.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        await this.jiraEmbeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }

      await this.jiraEmbeddingService.createEmbeddings(
        { dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS } as EmbeddingConfig,
        true
      );
    } catch (error) {
      console.error('Error resuming Jira indexing:', error);
      await publishSyncState(this.context, 'jira', { isIndexing: false });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_JIRA_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
