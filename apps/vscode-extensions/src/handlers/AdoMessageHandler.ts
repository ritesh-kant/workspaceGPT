import * as vscode from 'vscode';
import path from 'path';
import { MESSAGE_TYPES, MODEL, STORAGE_KEYS } from '../../constants';
import { AdoService, AdoConfig } from '../services/ado/adoService';
import { AdoAuthService } from '../services/ado/adoAuthService';
import { AdoEmbeddingService } from '../services/ado/adoEmbeddingService';
import { listMyWorkItems, MyWorkItemsResult } from '../services/ado/adoWorkItemService';
import { EmbeddingConfig } from '../types/types';
import { AnalyticsService } from '../services/analyticsService';
import { publishSyncState } from '../utils/syncStateStore';
import { deleteDirectory } from 'src/utils/deleteDirectory';

export class AdoMessageHandler {
  private adoService: AdoService;
  private adoAuthService: AdoAuthService;
  private adoEmbeddingService: AdoEmbeddingService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.adoService = new AdoService(this.webviewView, this.context);
    this.adoAuthService = new AdoAuthService(this.context);
    this.adoEmbeddingService = new AdoEmbeddingService(this.webviewView, this.context);

    // Pre-warm ADO worker if connected
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (config?.state?.config?.ado?.config?.isAdoConnected) {
      console.log('Pre-warming ADO search worker...');
      this.adoEmbeddingService.ensureSearchWorker().catch(e => console.error('Failed to pre-warm ADO worker', e));
    }
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.CONNECT_ADO_MSAL:
        await this.handleConnectAdoMsal();
        return true;
      case MESSAGE_TYPES.CONNECT_ADO_AZURE_CLI:
        await this.handleConnectAdoAzureCli();
        return true;
      case MESSAGE_TYPES.SAVE_ADO_PAT:
        await this.handleSaveAdoPat(data.pat);
        return true;
      case MESSAGE_TYPES.DISCONNECT_ADO:
        this.analyticsService.trackEvent('ado_disconnected');
        await this.handleDisconnectAdo();
        return true;
      case MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS:
        await this.handleFetchAdoOrganizations();
        return true;
      case MESSAGE_TYPES.FETCH_ADO_PROJECTS:
        this.analyticsService.trackEvent('ado_projects_fetched');
        await this.handleFetchAdoProjects(data.orgName);
        return true;
      case MESSAGE_TYPES.CHECK_ADO_CONNECTION:
        await this.handleCheckAdoConnection();
        return true;
      case MESSAGE_TYPES.START_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_started');
        await this.handleStartAdoSync(data.forceFull);
        return true;
      case MESSAGE_TYPES.RESUME_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_resumed');
        await this.handleResumeAdoSync();
        return true;
      case MESSAGE_TYPES.STOP_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_stopped');
        await this.handleStopAdoSync();
        return true;
      case MESSAGE_TYPES.RESUME_INDEXING_ADO:
        this.analyticsService.trackEvent('ado_indexing_resumed');
        await this.handleResumeIndexingAdo();
        return true;
      case MESSAGE_TYPES.GET_MY_WORK_ITEMS:
        await this.handleGetMyWorkItems(!!data.forceRefresh);
        return true;
      case MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY:
        await this.handleFetchAdoUserIdentity();
        return true;
      case MESSAGE_TYPES.SAVE_ADO_USER_DISPLAY_NAME:
        await this.handleSaveAdoUserDisplayName(data.displayName);
        return true;
    }
    return false;
  }

  public async reset(): Promise<void> {
    this.adoService.stopSync();
    await this.adoEmbeddingService.stopEmbeddingProcess();
    await this.adoAuthService.disconnect();
    await this.adoService.resetSyncProgress();
    await this.adoEmbeddingService.resetEmbeddingProgress();
  }

  /**
   * Rebuild the Azure DevOps index from scratch after the embedding provider
   * changed. The already-synced markdown is kept (the source content is
   * unchanged); only the vectors are dropped and re-embedded with the new
   * provider. Returns false when ADO isn't connected, i.e. there's nothing
   * to re-index.
   */
  public async reindexAfterProviderChange(): Promise<boolean> {
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (!config?.state?.config?.ado?.config?.isAdoConnected) {
      return false;
    }

    this.adoService.stopSync();
    await this.adoEmbeddingService.stopEmbeddingProcess();
    await this.adoEmbeddingService.clearEmbeddingIndex();
    await this.adoEmbeddingService.resetEmbeddingProgress();
    await this.handleCompleteAdoSync();
    return true;
  }

  private async handleConnectAdoMsal(): Promise<void> {
    try {
      await this.adoAuthService.connectWithMicrosoftAccount();
      this.analyticsService.trackEvent('ado_msal_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_MSAL_SUCCESS,
      });
      await this.handleFetchAdoOrganizations();
    } catch (error) {
      console.error('Error connecting ADO via Microsoft sign-in:', error);
      this.analyticsService.trackEvent('ado_msal_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_MSAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleConnectAdoAzureCli(): Promise<void> {
    try {
      await this.adoAuthService.connectWithAzureCli();
      this.analyticsService.trackEvent('ado_azure_cli_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_AZURE_CLI_SUCCESS,
      });
      await this.handleFetchAdoOrganizations();
    } catch (error) {
      console.error('Error connecting ADO via Azure CLI:', error);
      this.analyticsService.trackEvent('ado_azure_cli_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_AZURE_CLI_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleSaveAdoPat(pat: string): Promise<void> {
    try {
      await this.adoAuthService.connectWithPat(pat);
      this.analyticsService.trackEvent('ado_pat_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_PAT_SUCCESS,
      });
      await this.handleFetchAdoOrganizations();
    } catch (error) {
      console.error('Error saving ADO PAT:', error);
      this.analyticsService.trackEvent('ado_pat_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_PAT_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleDisconnectAdo(): Promise<void> {
    try {
      this.adoService.stopSync();
      await this.adoEmbeddingService.stopEmbeddingProcess();

      await this.adoAuthService.disconnect();

      await this.adoService.resetSyncProgress();
      await this.adoEmbeddingService.resetEmbeddingProgress();
      // Drop the cached "your work" list — a disconnected user must not keep
      // seeing their tickets in the chat empty state.
      await this.context.globalState.update(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE, undefined);

      const adoDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'ado'
      );
      await deleteDirectory(adoDirPath);

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.ado) {
        settings.state.config.ado = {
          ...settings.state.config.ado,
          isAuthenticated: false,
          orgName: '',
          projectName: '',
          userDisplayName: '',
          currentSprint: null,
          isSyncing: false,
          isIndexing: false,
          canResume: false,
          canResumeIndexing: false,
          isSyncCompleted: false,
          isIndexingCompleted: false,
          adoSyncProgress: 0,
          adoIndexProgress: 0,
          lastSyncTime: '',
          _needsResume: false,
          _needsResumeIndexing: false,
        };
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.DISCONNECT_ADO,
        success: true,
      });
    } catch (error) {
      console.error('Error disconnecting ADO:', error);
    }
  }

  /**
   * Lists the user's Azure DevOps organizations so the settings panel can
   * offer a dropdown instead of asking them to type the org name. Called
   * both on explicit request and automatically right after a successful
   * connect (see the connect handlers above) — a soft failure here (e.g. a
   * narrowly-scoped PAT that can't read the accounts API) just leaves the
   * dropdown empty and falls back to manual entry, never blocks connecting.
   */
  private async handleFetchAdoOrganizations(): Promise<void> {
    try {
      const organizations = await this.adoAuthService.fetchOrganizations();
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS_SUCCESS,
        organizations: organizations.map((o) => ({ accountId: o.accountId, accountName: o.accountName })),
      });
    } catch (error) {
      console.warn('Could not fetch ADO organizations:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleFetchAdoProjects(orgName: string): Promise<void> {
    try {
      if (!orgName || orgName.trim() === '') {
        throw new Error('Organization name is required to fetch projects.');
      }
      const projects = await this.adoAuthService.fetchProjects(orgName.trim());
      this.analyticsService.trackEvent('ado_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_PROJECTS_SUCCESS,
        projects: projects.map(p => ({ id: p.id, name: p.name })),
      });
    } catch (error) {
      console.error('Error fetching ADO projects:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_PROJECTS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * "Your work" panel data. Answers twice when a cache exists: once immediately
   * from `globalState` so the chat empty state paints without waiting on the
   * network, then again with fresh results. The webview replaces its list on
   * each response, so the second post just supersedes the first.
   *
   * A failed refresh never clears a good cache — the user keeps seeing their
   * tickets and gets told the refresh failed, rather than watching their work
   * disappear because a token expired.
   */
  private async handleGetMyWorkItems(forceRefresh: boolean): Promise<void> {
    const cached = this.context.globalState.get<MyWorkItemsResult>(
      STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE
    );

    if (cached && !forceRefresh) {
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        ...cached,
        fromCache: true,
      });
    }

    try {
      const fresh = await listMyWorkItems(this.context);
      await this.context.globalState.update(STORAGE_KEYS.ADO_MY_WORK_ITEMS_CACHE, fresh);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        ...fresh,
        fromCache: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Could not fetch assigned ADO work items:', message);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE,
        // Keep whatever we already had on screen; flag the staleness instead.
        ...(cached ?? { items: [], fetchedAt: '' }),
        fromCache: !!cached,
        error: message,
      });
    }
  }

  private async getAdoConfig(): Promise<AdoConfig> {
    const authHeader = await this.adoAuthService.getValidAuthHeader();
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const orgName = config?.state?.config?.ado?.orgName;
    const projectName = config?.state?.config?.ado?.projectName;

    const lookbackMonths = config?.state?.config?.ado?.lookbackMonths ?? 24;

    if (!authHeader || !orgName || !projectName) {
      throw new Error(
        'Azure DevOps configuration is incomplete. Please connect.'
      );
    }

    return {
      orgName,
      projectName,
      authHeader,
      lookbackMonths,
    };
  }

  private async handleCheckAdoConnection(): Promise<void> {
    try {
      const adoConfig = await this.getAdoConfig();
      const [totalItems] = await Promise.all([
        this.adoService.getTotalItems(adoConfig),
        this.fetchAndPersistUserIdentity(adoConfig.orgName, adoConfig.projectName),
      ]);

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to ADO. Found ${totalItems} items.`,
      });
    } catch (error) {
      this.analyticsService.trackEvent('ado_connection_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** Fetches user display name + current sprint and persists both to globalState. */
  private async fetchAndPersistUserIdentity(orgName: string, projectName: string): Promise<void> {
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    const teamName = settings?.state?.config?.ado?.teamName || undefined;

    const [userResult, sprintResult] = await Promise.allSettled([
      this.adoAuthService.fetchCurrentUser(orgName),
      this.adoAuthService.fetchCurrentSprint(orgName, projectName, teamName),
    ]);

    if (!settings?.state?.config?.ado) {
      return;
    }

    if (userResult.status === 'fulfilled') {
      settings.state.config.ado.userDisplayName = userResult.value.displayName;
    } else {
      console.warn('ADO user identity fetch failed:', userResult.reason);
    }

    settings.state.config.ado.currentSprint =
      sprintResult.status === 'fulfilled' ? sprintResult.value : null;
    if (sprintResult.status === 'rejected') {
      console.warn('ADO sprint fetch failed:', sprintResult.reason);
    }

    await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);

    // Notify webview so the settings panel updates live
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY_SUCCESS,
      userDisplayName: userResult.status === 'fulfilled' ? userResult.value.displayName : '',
      currentSprint: sprintResult.status === 'fulfilled' ? sprintResult.value : null,
    });
  }

  private async handleFetchAdoUserIdentity(): Promise<void> {
    try {
      const adoConfig = await this.getAdoConfig();
      await this.fetchAndPersistUserIdentity(adoConfig.orgName, adoConfig.projectName);
    } catch (error) {
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleSaveAdoUserDisplayName(displayName: string): Promise<void> {
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    if (settings?.state?.config?.ado) {
      settings.state.config.ado.userDisplayName = displayName?.trim() || '';
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
    }
  }

  /**
   * Clears the persisted isSyncing/isIndexing flags on a sync error, so a
   * stale "in progress" state doesn't survive a webview/panel reload — the
   * SYNC_ADO_ERROR postMessage above only corrects the webview's in-memory
   * store, not what's persisted in globalState.
   */
  private async clearAdoSyncFlags(): Promise<void> {
    await publishSyncState(this.context, 'ado', {
      isSyncing: false,
      isIndexing: false,
    });
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    if (settings?.state?.config?.ado) {
      settings.state.config.ado._needsResume = false;
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
    }
  }

  private async handleStartAdoSync(forceFull: boolean = false): Promise<void> {
    try {
      if (forceFull) {
        this.adoService.stopSync();
        await this.adoService.resetSyncProgress();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.ado) {
          settings.state.config.ado.lastSyncTime = '';
          settings.state.config.ado._needsResume = false;
          settings.state.config.ado._needsResumeIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
      }

      const adoConfig = await this.getAdoConfig();

      // Re-fetch sprint on each sync (sprint may have rolled over since last sync)
      this.fetchAndPersistUserIdentity(adoConfig.orgName, adoConfig.projectName).catch(
        (e) => console.warn('Sprint re-fetch on sync start failed:', e)
      );

      // The host owns isSyncing (see HOST_OWNED_SYNC_FIELDS) — the webview's
      // optimistic flag no longer reaches global state, and the scheduler's
      // "user sync already in progress" guard reads it from there.
      await publishSyncState(this.context, 'ado', { isSyncing: true });

      await this.adoService.startSync(
        adoConfig,
        async () => {
          await this.handleCompleteAdoSync(new Date().toISOString());
        },
        false,
        (error) => {
          console.error('ADO sync worker error:', error.message);
          this.clearAdoSyncFlags().catch((e) => console.error('Failed to clear ADO sync flags:', e));
        },
        () => this.adoAuthService.getValidAuthHeader(),
      );
    } catch (error) {
      console.error('Error in ADO sync:', error);
      this.analyticsService.trackEvent('ado_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.clearAdoSyncFlags();
    }
  }

  private async handleResumeAdoSync(): Promise<void> {
    try {
      const adoConfig = await this.getAdoConfig();
      const progress = this.adoService.getSyncProgress();

      if (!progress || progress.isComplete) {
        await this.handleStartAdoSync();
        return;
      }

      await publishSyncState(this.context, 'ado', { isSyncing: true });

      await this.adoService.startSync(
        adoConfig,
        () => this.handleCompleteAdoSync(new Date().toISOString()),
        true,
        (error) => {
          console.error('ADO sync worker error:', error.message);
          this.clearAdoSyncFlags().catch((e) => console.error('Failed to clear ADO sync flags:', e));
        },
        () => this.adoAuthService.getValidAuthHeader(),
      );
    } catch (error) {
      console.error('Error resuming ADO sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      await this.clearAdoSyncFlags();
    }
  }

  private async handleStopAdoSync(): Promise<void> {
    try {
      this.adoService.stopSync();
      await this.adoEmbeddingService.stopEmbeddingProcess();

      await publishSyncState(this.context, 'ado', {
        isSyncing: false,
        isIndexing: false,
      });
      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config?.ado) {
        config.state.config.ado._needsResume = false;
        config.state.config.ado._needsResumeIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping ADO sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_STOP,
      });
    }
  }

  private async handleCompleteAdoSync(lastSyncTime?: string): Promise<void> {
    try {
      // Advance the watermark and hand over to indexing in one write.
      // createEmbeddings only forks the worker, so isIndexing is cleared later
      // by AdoEmbeddingService on the worker's completion/error message.
      await publishSyncState(this.context, 'ado', {
        ...(lastSyncTime ? { lastSyncTime } : {}),
        isSyncing: false,
        isIndexing: true,
      });

      await this.adoEmbeddingService.createEmbeddings({
        dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
      } as EmbeddingConfig);
    } catch (error) {
      console.error('Error in ADO indexing:', error);
      await publishSyncState(this.context, 'ado', {
        isSyncing: false,
        isIndexing: false,
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeIndexingAdo(): Promise<void> {
    try {
      // Mark indexing in-flight before forking. Without this the scheduler sees
      // isSyncing/isIndexing both false and can start a background sync whose
      // own createEmbeddings kills this worker mid-batch. Cleared by
      // AdoEmbeddingService on the worker's terminal message.
      await publishSyncState(this.context, 'ado', { isIndexing: true });

      const progress = this.adoEmbeddingService.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        await this.adoEmbeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }

      await this.adoEmbeddingService.createEmbeddings(
        {
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig,
        true
      );
    } catch (error) {
      console.error('Error resuming ADO indexing:', error);
      await publishSyncState(this.context, 'ado', { isIndexing: false });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
