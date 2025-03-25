import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { ChatService } from '../services/chatService';
import { ConfluenceService } from '../services/confluenceService';

export class WebviewMessageHandler {
  private chatService?: ChatService;
  private confluenceService?: ConfluenceService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {}

  public async handleMessage(data: any): Promise<void> {
    switch (data.type) {
      case MESSAGE_TYPES.SYNC_GLOBAL_STATE:
        await this.handleSyncGlobalState(data);
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
      case MESSAGE_TYPES.NEW_CHAT:
        await this.handleNewChat();
        break;
      case MESSAGE_TYPES.SEND_MESSAGE:
        await this.handleSendMessage(data);
        break;
    }
  }

  private async handleSyncGlobalState(data: any): Promise<void> {
    await this.context.globalState.update(
      STORAGE_KEYS.WORKSPACE_SETTINGS,
      data.state
    );
  }

  private async handleClearGlobalState(): Promise<void> {
    await this.context.globalState.update(
      STORAGE_KEYS.WORKSPACE_SETTINGS,
      undefined
    );
  }

  private async handleCheckConfluenceConnection(): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.webviewView.webview.postMessage({
        type: 'confluenceConnectionStatus',
        status: true,
        message: 'Successfully connected to Confluence',
      });
    } catch (error) {
      this.webviewView.webview.postMessage({
        type: 'confluenceConnectionStatus',
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleStartConfluenceSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get('workspaceGPT-settings');
      const confluenceConfig = config.state.config.confluence;

      if (!this.isConfluenceConfigValid(confluenceConfig)) {
        throw new Error('Confluence configuration is incomplete. Please check your settings.');
      }

      if (!this.confluenceService) {
        this.confluenceService = new ConfluenceService(this.webviewView, this.context);
      }

      await this.confluenceService.startSync(confluenceConfig);
    } catch (error) {
      console.error('Error in Confluence sync:', error);
      this.webviewView.webview.postMessage({
        type: 'syncError',
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
      await this.chatService.sendMessage(data.message);
    } catch (error) {
      this.handleError('Error:', error);
    }
  }

  private handleError(prefix: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${prefix} ${errorMessage}`);
    this.webviewView.webview.postMessage({
      type: 'error',
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
}