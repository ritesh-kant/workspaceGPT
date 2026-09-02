import * as vscode from 'vscode';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { WebviewHtmlTemplate } from './templates/WebviewHtmlTemplate';
import { MESSAGE_TYPES, MODEL, ModelTypeEnum, STORAGE_KEYS } from '../constants';
import {
  collapseWorkspaceGptSidebar,
  noteWorkspaceGptViewVisibility,
} from './utils/collapseSidebar';

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
      noteWorkspaceGptViewVisibility(false);
      this._view = undefined;
    });

    this.trackVisibility(webviewView);
    this.configureWebview(webviewView);
    this.setWebviewHtml(webviewView);
    this.setupMessageHandler(webviewView);

    // Automatically reload webview when build files change in development mode
    if (this._context.extensionMode === vscode.ExtensionMode.Development) {
      const distWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this._extensionUri, 'webview/dist/**/*')
      );

      let debounceTimeout: any;
      const reloadWebview = () => {
        if (debounceTimeout) {
          clearTimeout(debounceTimeout);
        }
        debounceTimeout = setTimeout(() => {
          if (this._view) {
            this.setWebviewHtml(this._view);
          }
        }, 150);
      };

      distWatcher.onDidChange(reloadWebview);
      distWatcher.onDidCreate(reloadWebview);
      distWatcher.onDidDelete(reloadWebview);

      webviewView.onDidDispose(() => {
        distWatcher.dispose();
        if (debounceTimeout) {
          clearTimeout(debounceTimeout);
        }
      });
    }

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

  /**
   * `retainContextWhenHidden` keeps the webview running when another view takes
   * over the sidebar, and a retained webview is an iframe whose
   * `document.hidden` follows the window rather than the sidebar — so from
   * inside it, "hidden behind another view" and "visible" look the same. Feed
   * the host's authoritative signal to both the collapse gate and the webview's
   * width watch, so a resize that happens while the view is off screen is never
   * mistaken for the user dragging the sash.
   */
  private trackVisibility(webviewView: vscode.WebviewView): void {
    const publish = () => {
      noteWorkspaceGptViewVisibility(webviewView.visible);
      void webviewView.webview.postMessage({
        type: MESSAGE_TYPES.VIEW_VISIBILITY,
        visible: webviewView.visible,
      });
    };

    publish();
    webviewView.onDidChangeVisibility(publish);
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
      if (data?.type === MESSAGE_TYPES.COLLAPSE_SIDEBAR) {
        await collapseWorkspaceGptSidebar(data.dock);
        return;
      }
      await this.messageHandler?.handleMessage(data);
    });
  }

  public async sendMessage(data: any): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler.handleMessage(data);
    }
  }

}
