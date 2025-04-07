import * as vscode from 'vscode';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { WebviewHtmlTemplate } from './templates/WebviewHtmlTemplate';
import { MESSAGE_TYPES, MODEL, ModelTypeEnum, STORAGE_KEYS } from '../constants';

export class WebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messageHandler?: WebviewMessageHandler;
  private htmlTemplate: WebviewHtmlTemplate;

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
    const config: any = this._context.globalState.get(STORAGE_KEYS.WORKSPACE_SETTINGS);
    const confluenceConfig = config.state.config.confluence;

    this.messageHandler = new WebviewMessageHandler(webviewView, this._context);

    this.configureWebview(webviewView);
    this.setWebviewHtml(webviewView);
    this.setupMessageHandler(webviewView);

    // Initialize models
    // await this.messageHandler.initializeModels();
    if(confluenceConfig?.isIndexing) {
      this.sendMessage(MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE);
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

  public async sendMessage(data: any): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler.handleMessage(data);
    }
  }

}
