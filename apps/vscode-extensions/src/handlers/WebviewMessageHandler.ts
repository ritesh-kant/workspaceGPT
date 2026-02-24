import * as vscode from 'vscode';
import {
  MESSAGE_TYPES,
  MODEL,
  MODEL_PROVIDERS,
  STORAGE_KEYS,
} from '../../constants';
import { ChatService } from '../services/chatService';
import { ConfluenceService, ConfluenceConfig } from '../services/confluenceService';
import { ConfluenceAuthService } from '../services/confluenceAuthService';
import { EmbeddingService } from '../services/confluenceEmbeddingService';
import { CodebaseService } from '../services/codebaseService';
import { EmbeddingConfig, CodebaseConfig } from '../types/types';
import { fetchAvailableModels } from 'src/utils/fetchAvailableModels';
import { AnalyticsService } from '../services/analyticsService';
import path from 'path';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';

export class WebviewMessageHandler {
  private chatService?: ChatService;
  private confluenceService?: ConfluenceService;
  private confluenceAuthService: ConfluenceAuthService;
  private embeddingService?: EmbeddingService;
  private codebaseService?: CodebaseService;
  private analyticsService: AnalyticsService;

  private codebaseConfig?: CodebaseConfig;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {
    this.analyticsService = new AnalyticsService(context);

    this.confluenceService = new ConfluenceService(
      this.webviewView,
      this.context
    );

    this.confluenceAuthService = new ConfluenceAuthService(this.context);

    this.embeddingService = new EmbeddingService(
      this.webviewView,
      this.context
    );

    this.codebaseService = new CodebaseService(this.webviewView, this.context);
  }

  public async handleMessage(data: any): Promise<void> {
    switch (data.type) {
      case MESSAGE_TYPES.RESET:
        await this.reset();
        break;
      case MESSAGE_TYPES.UPDATE_GLOBAL_STATE:
        await this.updateGlobalState(data);
        break;
      case MESSAGE_TYPES.GET_GLOBAL_STATE:
        await this.getGlobalState(data);
        break;
      case MESSAGE_TYPES.CLEAR_GLOBAL_STATE:
        await this.handleClearGlobalState();
        break;

      // Confluence OAuth
      case MESSAGE_TYPES.START_CONFLUENCE_OAUTH:
        this.analyticsService.trackEvent('confluence_oauth_started');
        await this.handleStartConfluenceOAuth();
        break;
      case MESSAGE_TYPES.DISCONNECT_CONFLUENCE:
        this.analyticsService.trackEvent('confluence_disconnected');
        await this.handleDisconnectConfluence();
        break;
      case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES:
        await this.handleFetchConfluenceSpaces();
        break;

      // Confluence sync
      case MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION:
        await this.handleCheckConfluenceConnection();
        break;
      case MESSAGE_TYPES.START_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_started');
        await this.handleStartConfluenceSync();
        break;
      case MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_resumed');
        await this.handleResumeConfluenceSync();
        break;
      case MESSAGE_TYPES.STOP_CONFLUENCE_SYNC:
        this.analyticsService.trackEvent('confluence_sync_stopped');
        await this.handleStopConfluenceSync();
        break;

      // Codebase
      case MESSAGE_TYPES.START_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_started');
        await this.handleStartCodebaseSync();
        break;
      case MESSAGE_TYPES.RESUME_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_resumed');
        await this.handleResumeCodebaseSync();
        break;
      case MESSAGE_TYPES.STOP_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_stopped');
        await this.handleStopCodebaseSync();
        break;

      // Chat
      case MESSAGE_TYPES.NEW_CHAT:
        this.analyticsService.trackEvent('new_chat_created');
        await this.handleNewChat();
        break;
      case MESSAGE_TYPES.SHOW_SETTINGS:
        this.analyticsService.trackEvent('settings_opened');
        await this.handleShowSettings();
        break;
      case MESSAGE_TYPES.SEND_MESSAGE:
        this.analyticsService.trackEvent('message_sent', {
          messageLength: data.message?.length || 0,
        });
        await this.handleSendMessage(data);
        break;
      case MESSAGE_TYPES.UPDATE_MODEL:
        this.analyticsService.trackEvent('model_updated', {
          modelId: data.modelId,
          modelType: data.modelType,
        });
        await this.handleUpdateModel(data);
        break;
      case MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE:
        this.analyticsService.trackEvent('confluence_indexing_resumed');
        await this.handleResumeIndexingConfluence();
        break;

      case MESSAGE_TYPES.GET_WORKSPACE_PATH:
        await this.handleGetWorkspacePath();
        break;
      case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS:
        this.analyticsService.trackEvent('models_fetched');
        await this.handleFetchAvailableModels(data);
        break;
    }
  }

  private async reset() {
    const confluenceDirPath = path.join(
      this.context.globalStorageUri.fsPath,
      'confluence'
    );
    await ensureDirectoryExists(confluenceDirPath);
    await deleteDirectory(confluenceDirPath);
  }

  private async updateGlobalState(data: any): Promise<void> {
    await this.context.globalState.update(data.key, data.state);
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

  // --- Confluence OAuth Handlers ---

  private async handleStartConfluenceOAuth(): Promise<void> {
    try {
      const result = await this.confluenceAuthService.startOAuthFlow();

      // Notify the webview about the successful OAuth
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_OAUTH_SUCCESS,
        site: {
          id: result.site.id,
          name: result.site.name,
          url: result.site.url,
        },
      });

      // Also fetch and send spaces immediately
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

  private async handleDisconnectConfluence(): Promise<void> {
    try {
      await this.confluenceAuthService.disconnect();

      // Notify webview
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

  // --- Confluence Sync Handlers (updated for OAuth) ---

  private async getConfluenceConfig(): Promise<ConfluenceConfig> {
    const accessToken = await this.confluenceAuthService.getValidAccessToken();
    const site = this.confluenceAuthService.getStoredSite();
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const spaceKey = config?.state?.config?.confluence?.spaceKey;

    if (!site || !accessToken || !spaceKey) {
      throw new Error(
        'Confluence configuration is incomplete. Please connect to Confluence and select a space.'
      );
    }

    return {
      cloudId: site.id,
      accessToken,
      spaceKey,
    };
  }

  private async handleCheckConfluenceConnection(): Promise<void> {
    try {
      const confluenceConfig = await this.getConfluenceConfig();
      const totalPages = await this.confluenceService?.getTotalPages(
        confluenceConfig
      );

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to Confluence. Found ${totalPages} pages.`,
      });
    } catch (error) {
      // Track connection error
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

  private async handleStartConfluenceSync(): Promise<void> {
    try {
      const confluenceConfig = await this.getConfluenceConfig();

      await this.confluenceService?.startSync(confluenceConfig, async () => {
        // On complete, update lastSyncTime in global state
        const lastSyncTime = new Date().toISOString();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.confluence) {
          settings.state.config.confluence.lastSyncTime = lastSyncTime;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
        this.handleCompleteConfluenceSync();
      });
    } catch (error) {
      console.error('Error in Confluence sync:', error);
      this.analyticsService.trackEvent('confluence_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
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

      // Check if there's progress to resume
      const progress = this.confluenceService?.getSyncProgress();
      if (!progress || progress.isComplete) {
        // If no progress or already complete, start a new sync
        await this.handleStartConfluenceSync();
        return;
      }

      // Resume the sync with the existing progress
      await this.confluenceService?.startSync(
        confluenceConfig,
        () => this.handleCompleteConfluenceSync(),
        true // resume parameter
      );
    } catch (error) {
      console.error('Error resuming Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCompleteConfluenceSync(): Promise<void> {
    try {
      await this.embeddingService?.createEmbeddings({
        dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
      } as EmbeddingConfig);
    } catch (error) {
      console.error('Error in Confluence indexing:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeIndexingConfluence(): Promise<void> {
    try {
      // Check if there's progress to resume
      const progress = this.embeddingService?.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        // If no progress or already complete, start a new indexing
        await this.embeddingService?.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }

      // Resume the indexing with the existing progress
      await this.embeddingService?.createEmbeddings(
        {
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig,
        true // resume parameter
      );
    } catch (error) {
      console.error('Error resuming Confluence indexing:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- Chat Handlers ---

  private async handleNewChat(): Promise<void> {
    try {
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context);
      }
      await this.chatService.newChat();
    } catch (error) {
      this.handleError('Error starting new chat:', error);
    }
  }

  private async handleShowSettings(): Promise<void> {
    try {
      // Send a message to the webview to show the settings panel
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SHOW_SETTINGS,
      });
    } catch (error) {
      this.handleError('Error showing settings:', error);
    }
  }

  private async handleSendMessage(data: any): Promise<void> {
    try {
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context);
      }
      // Extract the message, model ID, and API key (if present) from the data
      const { message, modelId, apiKey, provider } = data;

      // Send the message to the chat service with API key if available
      await this.chatService.sendMessage(message, modelId, apiKey, provider);
    } catch (error) {
      this.analyticsService.trackEvent('message_send_error', {
        modelId: data.modelId,
        provider: data.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.handleError('Error:', error);
    }
  }

  private handleError(prefix: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${prefix} ${errorMessage}`);

    // Track error with analytics
    this.analyticsService.trackEvent('error_occurred', {
      errorType: prefix,
      errorMessage: errorMessage,
    });

    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
      message: errorMessage,
    });
  }

  // --- Model Handlers ---

  private async handleUpdateModel(data: any): Promise<void> {
    try {
      // Update the model in global state
      await this.context.globalState.update(
        MODEL.DEFAULT_CHAT_MODEL,
        data.modelId
      );
    } catch (error) {
      console.error('Error updating model:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- Confluence Stop Sync ---

  private async handleStopConfluenceSync(): Promise<void> {
    try {
      // Stop the sync process
      this.confluenceService?.stopSync();

      // Update the global state to reflect that sync is no longer in progress
      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config) {
        config.state.config.confluence.isSyncing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_STOP,
      });
    }
  }

  // --- Codebase Handlers ---

  private async handleStartCodebaseSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.codebaseConfig = config.state.config.codebase;
      const repoName = this.codebaseConfig?.repoPath.split('/').slice(-1)[0];

      if (
        !this.isCodebaseConfigValid(this.codebaseConfig) ||
        !this.codebaseConfig ||
        !repoName
      ) {
        throw new Error(
          'Codebase configuration is incomplete. Please check your settings.'
        );
      }
      await this.codebaseService?.startSync(this.codebaseConfig, () =>
        this.handleCompleteCodebaseSync(repoName)
      );
    } catch (error) {
      console.error('Error in Codebase sync:', error);
      this.analyticsService.trackEvent('codebase_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeCodebaseSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.codebaseConfig = config.state.config.codebase;
      const repoName = this.codebaseConfig?.repoPath.split('/').slice(-1)[0];

      if (
        !this.isCodebaseConfigValid(this.codebaseConfig) ||
        !this.codebaseConfig ||
        !repoName
      ) {
        throw new Error(
          'Codebase configuration is incomplete. Please check your settings.'
        );
      }

      // Check if there's progress to resume
      const progress = this.codebaseService?.getSyncProgress();
      if (!progress || progress.isComplete) {
        // If no progress or already complete, start a new sync
        await this.handleStartCodebaseSync();
        return;
      }

      // Resume the sync with the existing progress
      await this.codebaseService?.startSync(
        this.codebaseConfig,
        () => this.handleCompleteCodebaseSync(repoName),
        true // resume parameter
      );
    } catch (error) {
      console.error('Error resuming Codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCompleteCodebaseSync(repoName: string): Promise<void> {
    try {
      // Call the createEmbeddings method in CodebaseService to handle the embedding process
      await this.codebaseService?.createEmbeddings(false, repoName);
    } catch (error) {
      console.error('Error in Codebase embedding:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStopCodebaseSync(): Promise<void> {
    try {
      // Stop the sync process
      this.codebaseService?.stopSync();

      // Update the global state to reflect that sync is no longer in progress
      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config) {
        config.state.config.codebase.isSyncing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- Workspace Path ---

  private async handleGetWorkspacePath(): Promise<void> {
    try {
      // Get the workspace folders
      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (workspaceFolders && workspaceFolders.length > 0) {
        // Get the first workspace folder path
        const workspacePath = workspaceFolders[0].uri.fsPath;

        // Send the workspace path to the webview
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.WORKSPACE_PATH,
          path: workspacePath,
        });

        // Also update the config in global state
        const config = this.context.globalState.get(
          STORAGE_KEYS.SETTINGS
        ) as any;
        if (config?.state?.config) {
          config.state.config.codebase.repoPath = workspacePath;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      } else {
        // No workspace is open
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

  // --- Model Fetching ---

  private async handleFetchAvailableModels(data: any) {
    // Fetch the list of available models
    const baseURL = MODEL_PROVIDERS.find(
      (p) => p.MODEL_PROVIDER === data.provider
    )?.BASE_URL;
    const apiKey = data.apiKey;
    if (!baseURL || !apiKey) return;
    try {
      const models = await fetchAvailableModels(baseURL, data.apiKey);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_RESPONSE,
        models: models,
      });
    } catch (error) {
      console.error('Error fetching available models:', error);
      this.analyticsService.trackEvent('models_fetch_error', {
        provider: data.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- Helpers ---

  private isCodebaseConfigValid(config: any): boolean {
    return !!(config && config.repoPath);
  }
}
