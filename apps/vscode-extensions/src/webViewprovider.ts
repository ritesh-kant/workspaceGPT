import * as vscode from 'vscode';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { WebviewHtmlTemplate } from './templates/WebviewHtmlTemplate';
import { ChatService } from './services/chatService';
import { MESSAGE_TYPES, MODEL } from '../constants';

export class WebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messageHandler?: WebviewMessageHandler;
  private htmlTemplate: WebviewHtmlTemplate;
  private chatService?: ChatService;
  private isModelInitialized: boolean = false;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this.htmlTemplate = new WebviewHtmlTemplate(_extensionUri);
  }

  public getWebviewView(): vscode.WebviewView | undefined {
    return this._view;
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this.messageHandler = new WebviewMessageHandler(webviewView, this._context);
    this.chatService = new ChatService(webviewView, this._context);

    this.configureWebview(webviewView);
    this.setWebviewHtml(webviewView);
    this.setupMessageHandler(webviewView);

    // If the model hasn't been initialized yet in the background, do it now
    if (!this.isModelInitialized) {
      // Initialize the models immediately
      const chatModelId = MODEL.DEFAULT_CHAT_MODEL;
      const embeddingModelId = MODEL.DEFAULT_OLLAMA_EMBEDDING_MODEL;

      // Notify UI that model is being downloaded
      webviewView.webview.postMessage({
        type: MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS,
        progress: 0,
        current: '0 MB',
        total: '0 MB',
      });

      // Start model initialization
      this.chatService.initializeModel(chatModelId);
      this.chatService.initializeModel(embeddingModelId);
    }
  }

  private configureWebview(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
  }

  private setWebviewHtml(webviewView: vscode.WebviewView): void {
    webviewView.webview.html = this.htmlTemplate.getHtml(webviewView.webview);
  }

  private setupMessageHandler(webviewView: vscode.WebviewView): void {
    webviewView.webview.onDidReceiveMessage(async (data) => {
      await this.messageHandler?.handleMessage(data);
    });
  }

  // Method to set the model initialization status
  public setModelInitialized(value: boolean): void {
    this.isModelInitialized = value;
  }
}
