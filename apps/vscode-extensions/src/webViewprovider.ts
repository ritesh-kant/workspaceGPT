import * as vscode from 'vscode';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { WebviewHtmlTemplate } from './templates/WebviewHtmlTemplate';

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

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this.messageHandler = new WebviewMessageHandler(webviewView, this._context);

    this.configureWebview(webviewView);
    this.setWebviewHtml(webviewView);
    this.setupMessageHandler(webviewView);
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
}
