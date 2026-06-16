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
    const config: any = this._context.globalState.get(STORAGE_KEYS.SETTINGS);
    const confluenceConfig = config?.state?.config?.confluence;
    const adoConfig = config?.state?.config?.ado;

    this.messageHandler = new WebviewMessageHandler(webviewView, this._context);

    // Configure close button in the tab
    webviewView.description = "Close";
    webviewView.title = "WorkspaceGPT";
    webviewView.onDidDispose(() => {
      this.messageHandler?.dispose();
      this._view = undefined;
    });

    this.configureWebview(webviewView);
    this.setWebviewHtml(webviewView);
    this.setupMessageHandler(webviewView);

    // Resume interrupted indexing (embedding) on restart.
    // _needsResumeIndexing is set by the sync scheduler when it detects stale isIndexing flag.
    // isIndexing itself is checked as a fallback in case the scheduler hasn't run yet.
    if (confluenceConfig?.isIndexing || confluenceConfig?._needsResumeIndexing) {
      if (confluenceConfig?._needsResumeIndexing && config?.state?.config?.confluence) {
        config.state.config.confluence._needsResumeIndexing = false;
        await this._context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
      this.sendMessage(MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE);
    }

    if (adoConfig?.isIndexing || adoConfig?._needsResumeIndexing) {
      if (adoConfig?._needsResumeIndexing && config?.state?.config?.ado) {
        config.state.config.ado._needsResumeIndexing = false;
        await this._context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
      this.sendMessage(MESSAGE_TYPES.RESUME_INDEXING_ADO);
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
