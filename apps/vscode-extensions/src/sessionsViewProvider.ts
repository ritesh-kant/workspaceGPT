import * as vscode from 'vscode';
import { EXTENSION, MESSAGE_TYPES } from '../constants';
import { HistoryService } from './services/historyService';
import { SessionsHtmlTemplate } from './templates/SessionsHtmlTemplate';
import { tryExecuteCommand } from './utils/chatMaximizeLayout';

const WATCH_DEBOUNCE_MS = 200;

export class SessionsViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private activeSessionId: string | null = null;
  private htmlTemplate = new SessionsHtmlTemplate();
  private watcher?: vscode.FileSystemWatcher;
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly historyService: HistoryService,
    private readonly onNewSession: () => void,
    private readonly onSelectSession: (sessionId: string) => void
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.title = 'Sessions';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.htmlTemplate.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      if (data?.type === MESSAGE_TYPES.NEW_CHAT) {
        this.activeSessionId = null;
        this.onNewSession();
        void this.postList();
        return;
      }
      if (data?.type === MESSAGE_TYPES.LOAD_CHAT_SESSION && data.sessionId) {
        this.activeSessionId = data.sessionId;
        this.onSelectSession(data.sessionId);
        void this.postList();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.refresh();
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this.disposeWatcher();
    });

    void this.refresh().then(() => this.watchHistoryDir());
  }

  public setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    void this.postList();
  }

  public async refresh(): Promise<void> {
    await this.postList();
  }

  public toggleSearch(): void {
    void this._view?.webview.postMessage({ type: MESSAGE_TYPES.SESSIONS_TOGGLE_SEARCH });
  }

  /**
   * Open Sessions in the primary (left) sidebar without stealing keyboard
   * focus from the maximized chat editor when the view is already resolved.
   */
  public async revealInPrimarySidebar(preserveFocus: boolean): Promise<void> {
    if (this._view) {
      this._view.show(preserveFocus);
      await this.refresh();
      return;
    }
    await tryExecuteCommand(`workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`);
    await tryExecuteCommand(`${EXTENSION.SESSIONS_VIEW_TYPE}.focus`);
    if (preserveFocus) {
      await tryExecuteCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  private async postList(): Promise<void> {
    if (!this._view) return;
    const sessions = await this.historyService.getHistoryList();
    await this._view.webview.postMessage({
      type: MESSAGE_TYPES.SESSIONS_LIST,
      sessions,
      activeSessionId: this.activeSessionId,
    });
  }

  private watchHistoryDir(): void {
    if (this.watcher) return;
    const dir = this.historyService.storageDir;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dir, '*.json')
    );
    const schedule = () => {
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        void this.refresh();
      }, WATCH_DEBOUNCE_MS);
    };
    this.watcher.onDidChange(schedule);
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidDelete(schedule);
  }

  private disposeWatcher(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
