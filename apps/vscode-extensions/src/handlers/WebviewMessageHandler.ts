import * as vscode from 'vscode';
import {
  MESSAGE_TYPES,
  MODEL,
  ModelTypeEnum,
  STORAGE_KEYS,
} from '../../constants';
import { ChatService } from '../services/chatService';
import { ConfluenceService } from '../services/confluenceService';
import { EmbeddingService } from '../services/embeddingService';
import { EmbeddingConfig } from '../types/types';
import { isOllamaRunningCheck } from '../utils/ollamaCheck';

export class WebviewMessageHandler {
  private chatService?: ChatService;
  private confluenceService?: ConfluenceService;
  private embeddingService?: EmbeddingService;

  private confluenceConfig?: any;
  private checkOllamaInterval?: NodeJS.Timeout;
  private isModelInitialized: boolean = false;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {
    this.confluenceService = new ConfluenceService(
      this.webviewView,
      this.context
    );

    this.embeddingService = new EmbeddingService(
      this.webviewView,
      this.context
    );

    // Initialize Ollama status check
    this.initializeOllamaCheck();

    // Clean up interval when webview is disposed
    this.webviewView.onDidDispose(() => {
      if (this.checkOllamaInterval) {
        clearInterval(this.checkOllamaInterval);
      }
    });
  }

  public async initializeModels(): Promise<void> {
    const isOllamaRunning = await isOllamaRunningCheck();
    
    if (!this.isModelInitialized && isOllamaRunning) {
      const chatModelId = MODEL.DEFAULT_CHAT_MODEL;
      const embeddingModelId = MODEL.DEFAULT_OLLAMA_EMBEDDING_MODEL;

      // Notify UI that model is being downloaded
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS,
        progress: 0,
        current: '0 MB',
        total: '0 MB',
      });

      // Start model initialization
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context);
      }
      await this.chatService.initializeModel(chatModelId, ModelTypeEnum.Chat);
      await this.chatService.initializeModel(embeddingModelId, ModelTypeEnum.Embedding);
      
      this.isModelInitialized = true;
    }
  }

  public async handleMessage(data: any): Promise<void> {
    switch (data.type) {
      case MESSAGE_TYPES.UPDATE_GLOBAL_STATE:
        await this.updateGlobalState(data);
        break;
      case MESSAGE_TYPES.CLEAR_GLOBAL_STATE:
        await this.handleClearGlobalState();
        break;
      case MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION:
        await this.handleCheckConfluenceConnection();
        break;
      case MESSAGE_TYPES.START_CONFLUENCE_SYNC:
        await this.handleStartConfluenceSync();
        break;
      case MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC:
        await this.handleResumeConfluenceSync();
        break;
      case MESSAGE_TYPES.STOP_CONFLUENCE_SYNC:
        await this.handleStopConfluenceSync();
        break;
      case MESSAGE_TYPES.STOP_CODEBASE_SYNC:
        await this.handleStopCodebaseSync();
        break;
      case MESSAGE_TYPES.NEW_CHAT:
        await this.handleNewChat();
        break;
      case MESSAGE_TYPES.SEND_MESSAGE:
        await this.handleSendMessage(data);
        break;
      case MESSAGE_TYPES.UPDATE_MODEL:
        await this.handleUpdateModel(data);
        break;
      case MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE:
        await this.handleResumeIndexingConfluence();
        break;
      case MESSAGE_TYPES.RETRY_OLLAMA_CHECK:
        await this.handleRetryOllamaCheck();
        break;
    }
  }

  private async updateGlobalState(data: any): Promise<void> {
    await this.context.globalState.update(
      data.key,
      data.state
    );
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

  private async handleCheckConfluenceConnection(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.confluenceConfig = config.state.config.confluence;
      if (!this.isConfluenceConfigValid(this.confluenceConfig)) {
        throw new Error(
          'Confluence configuration is incomplete. Please check your settings.'
        );
      }
      const totalPages = await this.confluenceService?.getTotalPages(
        this.confluenceConfig
      );

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to Confluence. Found ${totalPages} pages.`,
      });
    } catch (error) {
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleStartConfluenceSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.confluenceConfig = config.state.config.confluence;
      if (!this.isConfluenceConfigValid(this.confluenceConfig)) {
        throw new Error(
          'Confluence configuration is incomplete. Please check your settings.'
        );
      }
      await this.confluenceService?.startSync(this.confluenceConfig, () =>
        this.handleCompleteConfluenceSync()
      );
    } catch (error) {
      console.error('Error in Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeConfluenceSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.confluenceConfig = config.state.config.confluence;
      if (!this.isConfluenceConfigValid(this.confluenceConfig)) {
        throw new Error(
          'Confluence configuration is incomplete. Please check your settings.'
        );
      }
      
      // Check if there's progress to resume
      const progress = this.confluenceService?.getSyncProgress();
      if (!progress || progress.isComplete) {
        // If no progress or already complete, start a new sync
        await this.handleStartConfluenceSync();
        return;
      }
      
      // Resume the sync with the existing progress
      await this.confluenceService?.startSync(
        this.confluenceConfig, 
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
      // Start embedding creation after sync is complete
      // if (!this.embeddingService) {
      //   this.embeddingService = new EmbeddingService(
      //     this.webviewView,
      //     this.context
      //   );
      // }
      await this.embeddingService?.createEmbeddings({
        dimensions: MODEL.DEFAULT_DIMENSIONS,
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
      // if (!this.embeddingService) {
      //   this.embeddingService = new EmbeddingService(
      //     this.webviewView,
      //     this.context
      //   );
      // }
      
      // Check if there's progress to resume
      const progress = this.embeddingService?.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        // If no progress or already complete, start a new indexing
        await this.embeddingService?.createEmbeddings({
          dimensions: MODEL.DEFAULT_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }
      
      // Resume the indexing with the existing progress
      await this.embeddingService?.createEmbeddings(
        {
          dimensions: MODEL.DEFAULT_DIMENSIONS,
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

  private async handleSendMessage(data: any): Promise<void> {
    try {
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context);
      }
      await this.chatService.sendMessage(data.message, data.modelId);
    } catch (error) {
      this.handleError('Error:', error);
    }
  }

  private handleError(prefix: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${prefix} ${errorMessage}`);
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
      message: errorMessage,
    });
  }

  private isConfluenceConfigValid(config: any): boolean {
    return !!(
      config.baseUrl &&
      config.spaceKey &&
      config.userEmail &&
      config.apiToken
    );
  }

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

  private async handleStopConfluenceSync(): Promise<void> {
    try {
      // Stop the sync process
      this.confluenceService?.stopSync();

      // Update the UI to reflect that sync has been stopped
      // this.webviewView.webview.postMessage({
      //   type: MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE,
      //   source: 'confluence',
      //   message: 'Sync process stopped by user',
      // });

      // Update the global state to reflect that sync is no longer in progress
      const config = this.context.globalState.get(
        STORAGE_KEYS.SETTINGS
      ) as any;
      if (config && config.state && config.state.config) {
        config.state.config.confluence.isSyncing = false;
        await this.context.globalState.update(
          STORAGE_KEYS.SETTINGS,
          config
        );
      }
    } catch (error) {
      console.error('Error stopping Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStopCodebaseSync(): Promise<void> {
    try {
      // For now, we'll just update the UI state since there's no dedicated codebase service yet
      // In a real implementation, you would stop the codebase sync process here

      // Update the UI to reflect that sync has been stopped
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE,
        source: 'codebase',
        message: 'Scan process stopped by user',
      });

      // Update the global state to reflect that sync is no longer in progress
      const config = this.context.globalState.get(
        STORAGE_KEYS.SETTINGS
      ) as any;
      if (config && config.state && config.state.config) {
        config.state.config.codebase.isSyncing = false;
        await this.context.globalState.update(
          STORAGE_KEYS.SETTINGS,
          config
        );
      }
    } catch (error) {
      console.error('Error stopping codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleRetryOllamaCheck(): Promise<void> {
    await this.checkOllamaStatus();
    this.initializeModels()
  }

  private async checkOllamaStatus(): Promise<boolean> {
    const isRunning = await isOllamaRunningCheck();
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.OLLAMA_STATUS,
      isRunning
    });
    return isRunning;
  }

  private async initializeOllamaCheck(): Promise<void> {
    // Initial check
    await this.checkOllamaStatus();
    // Set up periodic check
    this.checkOllamaInterval = setInterval(() => this.checkOllamaStatus(), 30000); // Check every 30 seconds
  }
}
