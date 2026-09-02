import * as vscode from 'vscode';
import path from 'path';
import { MESSAGE_TYPES, MODEL, STORAGE_KEYS } from '../../constants';
import { ConfluenceService, ConfluenceConfig } from '../services/confluence/confluenceService';
import { ConfluenceAuthService } from '../services/confluence/confluenceAuthService';
import { ConfluenceEmbeddingService } from '../services/confluence/confluenceEmbeddingService';
import { EmbeddingConfig } from '../types/types';
import { AnalyticsService } from '../services/analyticsService';
import { publishSyncState } from '../utils/syncStateStore';
import { deleteDirectory } from 'src/utils/deleteDirectory';

export class ConfluenceMessageHandler {
  private confluenceService: ConfluenceService;
  private confluenceAuthService: ConfluenceAuthService;
  private embeddingService: ConfluenceEmbeddingService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.confluenceService = new ConfluenceService(this.webviewView, this.context);
    this.confluenceAuthService = new ConfluenceAuthService(this.context);
    this.embeddingService = new ConfluenceEmbeddingService(this.webviewView, this.context);

    // Pre-warm Confluence worker if connected
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (config?.state?.config?.confluence?.isConnected) {
      console.log('Pre-warming Confluence search worker...');
      this.embeddingService.ensureSearchWorker().catch(e => console.error('Failed to pre-warm Confluence worker', e));
    }
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.START_CONFLUENCE_OAUTH:
        this.analyticsService.trackEvent('confluence_oauth_started');
        await this.handleStartConfluenceOAuth();
        return true;
      case MESSAGE_TYPES.DISCONNECT_CONFLUENCE:
        this.analyticsService.trackEvent('confluence_disconnected');
        await this.handleDisconnectConfluence();
        return true;
      case MESSAGE_TYPES.CANCEL_CONFLUENCE_OAUTH:
        this.analyticsService.trackEvent('confluence_oauth_cancelled');
        await this.handleCancelConfluenceOAuth();
        return true;
      case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES:
        await this.handleFetchConfluenceSpaces();
        return true;
      case MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION:
        await this.handleCheckConfluenceConnection();
        return true;
      case MESSAGE_TYPES.START_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_started');
        await this.handleStartConfluenceSync(data.forceFull);
        return true;
      case MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_resumed');
        await this.handleResumeConfluenceSync();
        return true;
      case MESSAGE_TYPES.STOP_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_stopped');
        await this.handleStopConfluenceSync();
        return true;
      case MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE:
        this.analyticsService.trackEvent('confluence_indexing_resumed');
        await this.handleResumeIndexingConfluence();
        return true;
    }
    return false;
  }

  public async reset(): Promise<void> {
    this.confluenceService.stopSync();
    this.embeddingService.stopEmbeddingProcess();
    await this.confluenceAuthService.disconnect();
    await this.confluenceService.resetSyncProgress();
    await this.embeddingService.resetEmbeddingProgress();
  }

  /**
   * Rebuild the Confluence index from scratch after the embedding provider
   * changed. The already-synced markdown is kept (the source content is
   * unchanged); only the vectors are dropped and re-embedded with the new
   * provider. Returns false when Confluence isn't connected, i.e. there's
   * nothing to re-index.
   */
  public async reindexAfterProviderChange(): Promise<boolean> {
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (!config?.state?.config?.confluence?.isConnected) {
      return false;
    }

    this.confluenceService.stopSync();
    this.embeddingService.stopEmbeddingProcess();
    await this.embeddingService.clearEmbeddingIndex();
    await this.embeddingService.resetEmbeddingProgress();
    await this.handleCompleteConfluenceSync();
    return true;
  }

  private async getConfluenceConfig(): Promise<ConfluenceConfig> {
    const accessToken = await this.confluenceAuthService.getValidAccessToken();
    const site = this.confluenceAuthService.getStoredSite();
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const spaceKey = config?.state?.config?.confluence?.spaceKey;

    if (!site || !accessToken || !spaceKey) {
      throw new Error('Confluence configuration is incomplete. Please connect to Confluence and select a space.');
    }

    return {
      cloudId: site.id,
      accessToken,
      spaceKey,
      siteUrl: site.url,
    };
  }

  private async handleStartConfluenceOAuth(): Promise<void> {
    try {
      const result = await this.confluenceAuthService.startOAuthFlow();
      this.analyticsService.trackEvent('confluence_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_OAUTH_SUCCESS,
        site: {
          id: result.site.id,
          name: result.site.name,
          url: result.site.url,
        },
      });
      await this.handleFetchConfluenceSpaces();
    } catch (error) {
      console.error('Error in Confluence OAuth:', error);
      this.analyticsService.trackEvent('confluence_oauth_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_OAUTH_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCancelConfluenceOAuth(): Promise<void> {
    try {
      await this.confluenceAuthService.cancelOAuthFlow();
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_OAUTH_ERROR,
        message: 'Authentication cancelled.',
      });
    } catch (error) {
      console.error('Error cancelling Confluence OAuth:', error);
    }
  }

  private async handleDisconnectConfluence(): Promise<void> {
    try {
      this.confluenceService.stopSync();
      this.embeddingService.stopEmbeddingProcess();
      await this.confluenceAuthService.disconnect();
      await this.confluenceService.resetSyncProgress();
      await this.embeddingService.resetEmbeddingProgress();

      const confluenceDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'confluence'
      );
      await deleteDirectory(confluenceDirPath);

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.confluence) {
        settings.state.config.confluence = {
          ...settings.state.config.confluence,
          isAuthenticated: false,
          siteName: '',
          cloudId: '',
          spaceKey: '',
          availableSpaces: [],
          isSyncing: false,
          isIndexing: false,
          canResume: false,
          canResumeIndexing: false,
          isSyncCompleted: false,
          isIndexingCompleted: false,
          confluenceSyncProgress: 0,
          confluenceIndexProgress: 0,
          lastSyncTime: '',
          _needsResume: false,
          _needsResumeIndexing: false,
        };
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.DISCONNECT_CONFLUENCE,
        success: true,
      });
    } catch (error) {
      console.error('Error disconnecting Confluence:', error);
    }
  }

  private async handleFetchConfluenceSpaces(): Promise<void> {
    try {
      const site = this.confluenceAuthService.getStoredSite();
      if (!site) {
        throw new Error('No Confluence site connected. Please connect first.');
      }
      const spaces = await this.confluenceAuthService.fetchSpaces(site.id);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_RESPONSE,
        spaces,
      });
    } catch (error) {
      console.error('Error fetching Confluence spaces:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCheckConfluenceConnection(): Promise<void> {
    try {
      const confluenceConfig = await this.getConfluenceConfig();
      const totalPages = await this.confluenceService.getTotalPages(confluenceConfig);

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to Confluence. Found ${totalPages} pages.`,
      });
    } catch (error) {
      this.analyticsService.trackEvent('confluence_connection_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleStartConfluenceSync(forceFull: boolean = false): Promise<void> {
    try {
      if (forceFull) {
        this.confluenceService.stopSync();
        await this.confluenceService.resetSyncProgress();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.confluence) {
          settings.state.config.confluence.lastSyncTime = '';
          settings.state.config.confluence._needsResume = false;
          settings.state.config.confluence._needsResumeIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
      }

      const confluenceConfig = await this.getConfluenceConfig();

      // The host owns isSyncing (see HOST_OWNED_SYNC_FIELDS) — the webview's
      // optimistic flag no longer reaches global state, and the scheduler's
      // "user sync already in progress" guard reads it from there.
      await publishSyncState(this.context, 'confluence', { isSyncing: true });

      await this.confluenceService.startSync(confluenceConfig, async () => {
        await this.handleCompleteConfluenceSync(new Date().toISOString());
      });
    } catch (error) {
      console.error('Error in Confluence sync:', error);
      this.analyticsService.trackEvent('confluence_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      await publishSyncState(this.context, 'confluence', {
        isSyncing: false,
        isIndexing: false,
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeConfluenceSync(): Promise<void> {
    try {
      const confluenceConfig = await this.getConfluenceConfig();

      const progress = this.confluenceService.getSyncProgress();
      if (!progress || progress.isComplete) {
        await this.handleStartConfluenceSync();
        return;
      }

      await publishSyncState(this.context, 'confluence', { isSyncing: true });

      await this.confluenceService.startSync(
        confluenceConfig,
        () => this.handleCompleteConfluenceSync(new Date().toISOString()),
        true
      );
    } catch (error) {
      console.error('Error resuming Confluence sync:', error);
      await publishSyncState(this.context, 'confluence', {
        isSyncing: false,
        isIndexing: false,
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStopConfluenceSync(): Promise<void> {
    try {
      this.confluenceService.stopSync();
      this.embeddingService.stopEmbeddingProcess();

      await publishSyncState(this.context, 'confluence', {
        isSyncing: false,
        isIndexing: false,
      });
      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config) {
        config.state.config.confluence._needsResume = false;
        config.state.config.confluence._needsResumeIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_STOP,
      });
    }
  }

  private async handleCompleteConfluenceSync(lastSyncTime?: string): Promise<void> {
    try {
      // Advance the watermark and hand over to indexing in one write.
      // createEmbeddings only forks the worker, so isIndexing is cleared later
      // by ConfluenceEmbeddingService on the worker's completion/error message.
      await publishSyncState(this.context, 'confluence', {
        ...(lastSyncTime ? { lastSyncTime } : {}),
        isSyncing: false,
        isIndexing: true,
      });

      await this.embeddingService.createEmbeddings({
        dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
      } as EmbeddingConfig);
    } catch (error) {
      console.error('Error in Confluence indexing:', error);
      await publishSyncState(this.context, 'confluence', {
        isSyncing: false,
        isIndexing: false,
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeIndexingConfluence(): Promise<void> {
    try {
      // Mark indexing in-flight before forking. Without this the scheduler sees
      // isSyncing/isIndexing both false and can start a background sync whose
      // own createEmbeddings kills this worker mid-batch. Cleared by
      // ConfluenceEmbeddingService on the worker's terminal message.
      await publishSyncState(this.context, 'confluence', { isIndexing: true });

      const progress = this.embeddingService.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        await this.embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }

      await this.embeddingService.createEmbeddings(
        {
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig,
        true
      );
    } catch (error) {
      console.error('Error resuming Confluence indexing:', error);
      await publishSyncState(this.context, 'confluence', { isIndexing: false });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
