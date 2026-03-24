import * as vscode from 'vscode';
import { MESSAGE_TYPES, MODEL, MODEL_PROVIDERS } from '../../constants';
import { ChatService } from '../services/chatService';
import { HistoryService } from '../services/historyService';
import { AnalyticsService } from '../services/analyticsService';
import { fetchAvailableModels } from 'src/utils/fetchAvailableModels';

export class ChatMessageHandler {
  private chatService?: ChatService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService,
    private readonly historyService: HistoryService
  ) {}

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.NEW_CHAT:
        this.analyticsService.trackEvent('new_chat_created');
        await this.handleNewChat();
        return true;
      case MESSAGE_TYPES.SEND_MESSAGE:
        this.analyticsService.trackEvent('message_sent', {
          messageLength: data.message?.length || 0,
        });
        await this.handleSendMessage(data);
        return true;
      case MESSAGE_TYPES.STOP_MESSAGE:
        this.analyticsService.trackEvent('message_stopped');
        await this.handleStopMessage();
        return true;
      case MESSAGE_TYPES.UPDATE_MODEL:
        this.analyticsService.trackEvent('model_updated', {
          modelId: data.modelId,
          modelType: data.modelType,
        });
        await this.handleUpdateModel(data);
        return true;
      case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS:
        this.analyticsService.trackEvent('models_fetched');
        await this.handleFetchAvailableModels(data);
        return true;
      case MESSAGE_TYPES.SAVE_CHAT_HISTORY:
        await this.handleSaveChatHistory(data);
        return true;
      case MESSAGE_TYPES.GET_CHAT_HISTORY_LIST:
        await this.handleGetChatHistoryList();
        return true;
      case MESSAGE_TYPES.GET_CHAT_SESSION:
        await this.handleGetChatSession(data);
        return true;
      case MESSAGE_TYPES.DELETE_CHAT_HISTORY:
        await this.handleDeleteChatHistory(data);
        return true;
    }
    return false;
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
      const { message, modelId, apiKey, provider, contextSelection } = data;
      await this.chatService.sendMessage(message, modelId, apiKey, provider, contextSelection);
    } catch (error) {
      this.analyticsService.trackEvent('message_send_error', {
        modelId: data.modelId,
        provider: data.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.handleError('Error:', error);
    }
  }

  private async handleStopMessage(): Promise<void> {
    try {
      if (this.chatService) {
        this.chatService.stopMessage();
      }
    } catch (error) {
      this.handleError('Error stopping message:', error);
    }
  }

  private handleError(prefix: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`${prefix} ${errorMessage}`);

    this.analyticsService.trackEvent('error_occurred', {
      errorType: prefix,
      errorMessage: errorMessage,
    });

    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
      message: errorMessage,
    });
  }

  private async handleUpdateModel(data: any): Promise<void> {
    try {
      await this.context.globalState.update(MODEL.DEFAULT_CHAT_MODEL, data.modelId);
    } catch (error) {
      console.error('Error updating model:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleFetchAvailableModels(data: any) {
    const baseURL = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === data.provider)?.BASE_URL;
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

  private async handleSaveChatHistory(data: any): Promise<void> {
    try {
      await this.historyService.saveHistory(data.sessionId, data.messages);
    } catch (error) {
      console.error('Error saving chat history:', error);
    }
  }

  private async handleGetChatHistoryList(): Promise<void> {
    try {
      const historyList = await this.historyService.getHistoryList();
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_CHAT_HISTORY_LIST_RESPONSE,
        historyList,
      });
    } catch (error) {
      console.error('Error getting chat history list:', error);
    }
  }

  private async handleGetChatSession(data: any): Promise<void> {
    try {
      const messages = await this.historyService.getChatSession(data.sessionId);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_CHAT_SESSION_RESPONSE,
        sessionId: data.sessionId,
        messages,
      });
    } catch (error) {
      console.error('Error getting chat session:', error);
    }
  }

  private async handleDeleteChatHistory(data: any): Promise<void> {
    try {
      await this.historyService.deleteChatSession(data.sessionId);
      await this.handleGetChatHistoryList();
    } catch (error) {
      console.error('Error deleting chat history:', error);
    }
  }
}
