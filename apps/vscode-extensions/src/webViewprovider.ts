import * as vscode from 'vscode';
import { WebviewMessageHandler } from './handlers/WebviewMessageHandler';
import { WebviewHtmlTemplate } from './templates/WebviewHtmlTemplate';
import { EXTENSION, MESSAGE_TYPES, STORAGE_KEYS } from '../constants';
import {
  collapseWorkspaceGptSidebar,
  noteWorkspaceGptViewVisibility,
} from './utils/collapseSidebar';
import { ChatWebviewHub } from './utils/chatWebviewHub';
import { registerWebviewPoster } from './utils/webviewBroadcast';
import {
  closeEmptyEditorGroups,
  maximizeChatWorkbench,
  openEmptyEditorGroup,
  unmaximizeChatWorkbench,
} from './utils/chatMaximizeLayout';
import { SessionsViewProvider } from './sessionsViewProvider';

const SNAPSHOT_TIMEOUT_MS = 1500;

/**
 * Chat messages that speak for the whole session rather than for the surface
 * that sent them: writing its history, and naming the session the Sessions
 * list should highlight. Only the surface that currently owns the chat may
 * send these — see `routeMessage`.
 */
const SURFACE_OWNED_MESSAGES = new Set<string>([
  MESSAGE_TYPES.SAVE_CHAT_HISTORY,
  MESSAGE_TYPES.SESSION_CHANGED,
]);

export class WebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _editorPanel?: vscode.WebviewPanel;
  private _restoringToSidebar = false;
  private _snapshotWaiter?: (snapshot: unknown) => void;
  private _pendingEditorSnapshot?: unknown;
  private _pendingSidebarSnapshot?: unknown;
  /** Session the editor panel is showing, so the sidebar can pick it back up. */
  private _editorSessionId: string | null = null;
  /** That session, waiting for a sidebar webview that is not up yet. */
  private _pendingSidebarSessionId?: string;
  private messageHandler?: WebviewMessageHandler;
  private htmlTemplate: WebviewHtmlTemplate;
  private readonly hub = new ChatWebviewHub();
  private sessionsView?: SessionsViewProvider;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this.htmlTemplate = new WebviewHtmlTemplate(_extensionUri);
    // Lets the sync schedulers — which outlive any single webview and are
    // constructed before this one exists — push state into the UI.
    registerWebviewPoster((message) => this.postMessage(message));
  }

  public setSessionsView(sessionsView: SessionsViewProvider): void {
    this.sessionsView = sessionsView;
  }

  /** Load a stored chat into the active chat surface (sidebar or editor). */
  public loadSession(sessionId: string): void {
    this.revealChat();
    void this.postMessage({ type: MESSAGE_TYPES.LOAD_CHAT_SESSION, sessionId });
  }

  /** A stored chat was deleted elsewhere (Sessions panel) — let the chat drop it. */
  public notifySessionDeleted(sessionId: string): void {
    void this.postMessage({ type: MESSAGE_TYPES.SESSION_DELETED, sessionId });
  }

  public getWebviewView(): vscode.WebviewView | undefined {
    return this._view;
  }

  public isChatInEditor(): boolean {
    return !!this._editorPanel;
  }

  /** Reveal whichever surface currently owns the chat. */
  public revealChat(): void {
    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    void vscode.commands.executeCommand(
      `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
    );
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.hub.postToActive(message);
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this.hub.setSidebar(webviewView.webview);
    if (!this._editorPanel) {
      this.hub.setActive('sidebar');
    }

    this.ensureHandler();

    webviewView.description = 'Close';
    webviewView.title = 'WorkspaceGPT';
    webviewView.onDidDispose(() => {
      this.hub.setSidebar(undefined);
      noteWorkspaceGptViewVisibility(false);
      this._view = undefined;
      this.maybeDisposeHandler();
    });

    this.trackVisibility(webviewView);
    this.configureWebview(webviewView.webview);
    this.setWebviewHtml(webviewView.webview, 'sidebar');
    this.subscribeToMessages(webviewView.webview, 'sidebar');

    if (this._context.extensionMode === vscode.ExtensionMode.Development) {
      this.watchWebviewDist(webviewView);
    }

    // Interrupted indexing is resumed by the sync schedulers (checkAndSync),
    // not here. On the desktop this view resolves before their restart
    // recovery has flagged anything, and a later resolve would restart a run
    // that is already live.
  }

  /**
   * Copilot-style maximize: put the live conversation in its own editor group,
   * then reopen Sessions in the primary sidebar so the list sits on the left
   * and chat fills the center editor.
   */
  public async openChatInEditor(): Promise<void> {
    this.ensureHandler();

    if (this._editorPanel) {
      this._editorPanel.reveal(vscode.ViewColumn.Active);
      this.hub.setActive('editor');
      await this.releaseSurface('sidebar');
      await this.setChatInEditorContext(true);
      await maximizeChatWorkbench();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await this.sessionsView?.revealInPrimarySidebar(true);
      return;
    }

    const snapshot = await this.requestSnapshot('sidebar');

    // Own editor group first — maximize hides other *groups*, not sibling tabs.
    await openEmptyEditorGroup();

    const panel = vscode.window.createWebviewPanel(
      EXTENSION.EDITOR_VIEW_TYPE,
      'WorkspaceGPT',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'resources', 'sidebar-icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'resources', 'sidebar-icon-light.svg'),
    };

    this._editorPanel = panel;
    this.configureWebview(panel.webview);
    this.hub.setEditor(panel.webview);
    this.hub.setActive('editor');
    this.setWebviewHtml(panel.webview, 'editor');
    this.subscribeToMessages(panel.webview, 'editor');

    panel.onDidDispose(() => {
      this.hub.setEditor(undefined);
      this._editorPanel = undefined;
      this.hub.setActive('sidebar');
      void this.setChatInEditorContext(false);
      this.maybeDisposeHandler();
      void closeEmptyEditorGroups();
      if (!this._restoringToSidebar) {
        void vscode.commands.executeCommand(
          `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
        );
        // Closing the tab is not "unmaximize", so there is no snapshot to hand
        // back — and the sidebar was released when the chat moved here. Reopen
        // the same session from its saved history instead of dropping the user
        // on an empty chat.
        if (this._editorSessionId) {
          // Revealing the container may still have to build the webview, so
          // hand the load to `onChatWebviewReady` when one isn't up yet.
          if (this.hub.hasSidebar()) {
            void this.hub.postTo('sidebar', {
              type: MESSAGE_TYPES.LOAD_CHAT_SESSION,
              sessionId: this._editorSessionId,
            });
          } else {
            this._pendingSidebarSessionId = this._editorSessionId;
          }
        }
      }
      this._editorSessionId = null;
      this._restoringToSidebar = false;
    });

    this._pendingEditorSnapshot = snapshot;
    // Only once the transcript is safely queued for the new panel.
    await this.releaseSurface('sidebar');
    await this.setChatInEditorContext(true);
    // Let the workbench register the new editor before maximize looks at it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await maximizeChatWorkbench();
    // maximizeEditorHideSidebar closes the primary sidebar; reopen Sessions on the left.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await this.sessionsView?.revealInPrimarySidebar(true);
  }

  /**
   * Hand the conversation over: the surface the chat just left keeps a full
   * copy of it — a retained webview is not torn down when it goes off screen —
   * and that copy is frozen at the moment of the handover. Left in place it
   * shadows the live chat: its "New chat" button force-saves the session id it
   * still holds, writing the pre-handover transcript over every turn taken
   * since. Reset it to an empty chat so it owns no session at all.
   */
  private releaseSurface(surface: 'sidebar' | 'editor'): Thenable<boolean> {
    return this.hub.postTo(surface, {
      type: MESSAGE_TYPES.CHAT_SNAPSHOT_APPLY,
      snapshot: { pendingStreamText: '' },
    });
  }

  public async restoreChatToSidebar(): Promise<void> {
    if (!this._editorPanel) {
      this.revealChat();
      return;
    }

    const snapshot = await this.requestSnapshot('editor');
    this._pendingSidebarSnapshot = snapshot;
    this._restoringToSidebar = true;
    this.hub.setActive('sidebar');
    await this.setChatInEditorContext(false);
    await unmaximizeChatWorkbench();

    void vscode.commands.executeCommand(
      `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
    );

    if (snapshot && this.hub.hasSidebar()) {
      await this.hub.postTo('sidebar', {
        type: MESSAGE_TYPES.CHAT_SNAPSHOT_APPLY,
        snapshot,
      });
      await this.hub.postTo('sidebar', {
        type: MESSAGE_TYPES.CHAT_LAYOUT,
        layout: 'sidebar',
      });
    }

    this._editorPanel.dispose();
    await closeEmptyEditorGroups();
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

  private configureWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };
  }

  private setWebviewHtml(webview: vscode.Webview, layout: 'sidebar' | 'editor'): void {
    webview.html = this.htmlTemplate.getHtml(webview, layout);
  }

  private subscribeToMessages(webview: vscode.Webview, surface: 'sidebar' | 'editor'): void {
    webview.onDidReceiveMessage(async (data) => {
      await this.routeMessage(data, surface);
    });
  }

  /**
   * Both chat surfaces stay alive while the chat is maximized — the sidebar
   * view is retained behind Sessions — so a history write has to say which one
   * it came from. Only the surface that currently owns the chat may write: an
   * inactive surface still holds the transcript as it stood when the chat left
   * it, and its save-before-new-chat would replace the live session file with
   * that older, shorter conversation.
   */
  private async routeMessage(data: any, surface: 'sidebar' | 'editor' = 'sidebar'): Promise<void> {
    if (SURFACE_OWNED_MESSAGES.has(data?.type) && surface !== this.hub.getActive()) {
      return;
    }
    if (data?.type === MESSAGE_TYPES.COLLAPSE_SIDEBAR) {
      await collapseWorkspaceGptSidebar(data.dock);
      return;
    }
    if (data?.type === MESSAGE_TYPES.OPEN_CHAT_IN_EDITOR) {
      await this.openChatInEditor();
      return;
    }
    if (data?.type === MESSAGE_TYPES.RESTORE_CHAT_TO_SIDEBAR) {
      await this.restoreChatToSidebar();
      return;
    }
    if (data?.type === MESSAGE_TYPES.CHAT_SNAPSHOT) {
      this._snapshotWaiter?.(data.snapshot);
      this._snapshotWaiter = undefined;
      return;
    }
    if (data?.type === MESSAGE_TYPES.CHAT_WEBVIEW_READY) {
      await this.onChatWebviewReady(data.layout);
      return;
    }
    if (data?.type === MESSAGE_TYPES.SESSION_CHANGED) {
      if (surface === 'editor') {
        this._editorSessionId = data.sessionId ?? null;
      }
      this.sessionsView?.setActiveSession(data.sessionId ?? null);
      return;
    }
    if (data?.type === MESSAGE_TYPES.ASSISTANT_MODE_CHANGED) {
      this.sessionsView?.setAssistantMode(data.assistantMode === 'chat' ? 'chat' : 'work');
      return;
    }
    if (data?.type === MESSAGE_TYPES.SESSIONS_RUNNING_STATE) {
      this.sessionsView?.setRunningState(
        Array.isArray(data.runningSessionIds) ? data.runningSessionIds : [],
        Array.isArray(data.completedSessionIds) ? data.completedSessionIds : [],
        Array.isArray(data.erroredSessionIds) ? data.erroredSessionIds : []
      );
      return;
    }
    await this.messageHandler?.handleMessage(data);
  }

  private async onChatWebviewReady(layout?: 'sidebar' | 'editor'): Promise<void> {
    const surface = layout === 'editor' || this.hub.getActive() === 'editor' ? 'editor' : 'sidebar';
    await this.hub.postTo(surface, {
      type: MESSAGE_TYPES.CHAT_LAYOUT,
      layout: surface,
    });
    if (surface === 'editor' && this._pendingEditorSnapshot !== undefined) {
      const snapshot = this._pendingEditorSnapshot;
      this._pendingEditorSnapshot = undefined;
      await this.hub.postTo('editor', {
        type: MESSAGE_TYPES.CHAT_SNAPSHOT_APPLY,
        snapshot,
      });
    }
    if (surface === 'sidebar' && this._pendingSidebarSessionId) {
      const sessionId = this._pendingSidebarSessionId;
      this._pendingSidebarSessionId = undefined;
      await this.hub.postTo('sidebar', {
        type: MESSAGE_TYPES.LOAD_CHAT_SESSION,
        sessionId,
      });
    }
    if (surface === 'sidebar' && this._pendingSidebarSnapshot !== undefined) {
      const snapshot = this._pendingSidebarSnapshot;
      this._pendingSidebarSnapshot = undefined;
      await this.hub.postTo('sidebar', {
        type: MESSAGE_TYPES.CHAT_SNAPSHOT_APPLY,
        snapshot,
      });
    }
  }

  private requestSnapshot(from: 'sidebar' | 'editor'): Promise<unknown | undefined> {
    const webview = from === 'editor' ? this.hub.getEditor() : this.hub.getSidebar();
    if (!webview) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._snapshotWaiter = undefined;
        resolve(undefined);
      }, SNAPSHOT_TIMEOUT_MS);

      this._snapshotWaiter = (snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      };

      void webview.postMessage({ type: MESSAGE_TYPES.CHAT_SNAPSHOT_REQUEST });
    });
  }

  private ensureHandler(): void {
    if (!this.messageHandler) {
      this.messageHandler = new WebviewMessageHandler(this.hub.facade, this._context);
    }
  }

  private maybeDisposeHandler(): void {
    if (this._view || this._editorPanel) {
      return;
    }
    this.messageHandler?.dispose();
    this.messageHandler = undefined;
  }

  private async setChatInEditorContext(inEditor: boolean): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      EXTENSION.CONTEXT_CHAT_IN_EDITOR,
      inEditor
    );
  }

  private watchWebviewDist(webviewView: vscode.WebviewView): void {
    const distWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this._extensionUri, 'webview/dist/**/*')
    );

    let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
    const reloadWebview = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        if (this._view) {
          this.setWebviewHtml(this._view.webview, 'sidebar');
        }
        if (this._editorPanel) {
          this.setWebviewHtml(this._editorPanel.webview, 'editor');
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

  public async sendMessage(data: any): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler.handleMessage(data);
    }
  }
}
