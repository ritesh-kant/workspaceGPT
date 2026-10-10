import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { COPILOT_PROVIDER, MESSAGE_TYPES, MODEL_PROVIDERS } from '../../constants';
import { ChatService } from '../services/chatService';
import { ensureCopilotBridge, getCopilotStatus, listCopilotModels } from '../services/copilotBridge';
import { ensureDirectCopilotReady, signOutDirectCopilot, usesDirectCopilot } from '../services/copilotDirect';
import { HistoryService } from '../services/historyService';
import { openFolderIn } from '../services/openFolderIn';
import { AnalyticsService } from '../services/analyticsService';
import { fetchAvailableModels } from 'src/utils/fetchAvailableModels';
import { getNamedRoots, NamedRoot, resolveAgainstRoots } from '../services/codebase/codebaseTools';
import { openAgentDiff } from '../services/agent/agentDiffProvider';
import { searchMentionTargets } from '../services/codebase/mentionSearch';
import { getGitStatus } from '../services/agent/gitStatusService';
import { shipAllChanges } from '../services/agent/shipService';
import { getCiSnapshot, getCiSnapshotViaHost, getFailureLog, getFailureLogViaHost, pushCiFix } from '../services/agent/ciService';
import { CodeHostConnections } from '../services/codehost/connections';
import { isPermission } from '../services/agent/permissionPolicy';
import { ensureWorktree, getDefaultFolder, getRecentFolders, listBranches, openFolder, savePendingStart, setDefaultFolder, switchBranch, takePendingStart } from '../services/agent/workspaceControls';
import { isBrowserConnected } from '../services/browser/browserBridge';
import { openChromeExtensionInstall } from '../services/browser/installChromeExtension';
import { isControlChromeEnabled, setControlChromeEnabled } from '../services/browser/browserPrefs';
import { ImportService } from '../services/import/importService';
import type { ImportSource } from '../services/import/types';

/** Quiet period after the last file event before the bar's `git status` re-runs. */
const GIT_STATUS_DEBOUNCE_MS = 500;

const fileExists = async (absPath: string): Promise<boolean> => {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    return true;
  } catch {
    return false;
  }
};

export class ChatMessageHandler {
  private chatService?: ChatService;
  /** Files the chat on screen recorded — what the last GET_GIT_STATUS asked about; pushes reuse them. */
  private gitStatusPaths: string[] = [];
  private gitStatusWatch?: vscode.Disposable;
  private gitStatusTimer?: ReturnType<typeof setTimeout>;
  /** The chat on screen (SESSION_CHANGED); null for a new chat that has not sent yet. */
  private viewedSessionId: string | null = null;
  private gitStatusWatchRoot?: string;
  private sessionChangeSeq = 0;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService,
    private readonly historyService: HistoryService
  ) {}

  /**
   * Eagerly create the ChatService and warm its search workers, so the first
   * query lands on an already-warmed worker instead of paying cold-start cost.
   */
  public prewarm(): void {
    if (!this.chatService) {
      this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
    }
    this.chatService.prewarm();
  }

  public dispose(): void {
    this.chatService?.dispose();
    clearTimeout(this.gitStatusTimer);
    this.gitStatusWatch?.dispose();
    this.gitStatusWatch = undefined;
  }

  /**
   * Drop and re-warm the search workers. Used after the embedding provider
   * changes so queries stop hitting a worker that was initialized with the old
   * provider; workers lazily re-spawn (with the new provider) on the next query.
   */
  public refreshSearchWorkers(): void {
    this.chatService?.dispose();
    this.chatService?.prewarm();
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.NEW_CHAT:
        this.analyticsService.trackEvent('new_chat_created');
        await this.handleNewChat();
        return true;
      case MESSAGE_TYPES.SEND_MESSAGE:
        this.analyticsService.trackEvent('message_sent', {
          messageLength: data.message?.length || 0,
          attachmentCount: data.attachments?.length || 0,
          mentionCount: data.mentions?.length || 0,
        });
        await this.handleSendMessage(data);
        return true;
      case MESSAGE_TYPES.STOP_MESSAGE:
        this.analyticsService.trackEvent('message_stopped');
        await this.handleStopMessage(data.sessionId);
        return true;
      case MESSAGE_TYPES.MESSAGE_FEEDBACK:
        this.analyticsService.trackEvent('message_feedback', {
          rating: data.rating,
          messageIndex: data.messageIndex,
        });
        return true;
      case MESSAGE_TYPES.AGENT_WRITE_DECISION:
        this.analyticsService.trackEvent('agent_write_decision', { approved: !!data.approved, scope: data.scope });
        this.chatService?.resolveAgentWrite(data.id, !!data.approved, data.feedback, data.scope);
        return true;
      case MESSAGE_TYPES.OPEN_FILE_IN_EDITOR:
        await this.handleOpenFileInEditor(data.path, data.line, data.endLine);
        return true;
      case MESSAGE_TYPES.OPEN_EXTERNAL:
        await this.handleOpenExternal(data.url);
        return true;
      case MESSAGE_TYPES.AGENT_REVERT_CHECKPOINT:
        this.analyticsService.trackEvent('agent_revert_checkpoint_triggered');
        await this.handleRevertCheckpoint(data.sha);
        return true;
      case MESSAGE_TYPES.OPEN_DIFF_IN_EDITOR:
        await this.handleOpenDiffInEditor(data.path);
        return true;
      case MESSAGE_TYPES.AGENT_SHIP:
        this.analyticsService.trackEvent('agent_ship_triggered');
        await this.chatService?.shipTurn(data.sessionId, data.requestId, data.shipInput);
        return true;
      case MESSAGE_TYPES.GET_GIT_STATUS:
        await this.handleGetGitStatus(data.paths);
        return true;
      case MESSAGE_TYPES.CI_GET_STATUS:
        await this.handleCiStatus(data.sessionId);
        return true;
      case MESSAGE_TYPES.CI_PUSH_FIX:
        await this.handleCiPushFix(data);
        return true;
      case MESSAGE_TYPES.AGENT_SHIP_ALL:
        this.analyticsService.trackEvent('agent_ship_all_triggered');
        await this.handleShipAll(data.requestId);
        return true;
      case MESSAGE_TYPES.INSTALL_CHROME_EXTENSION:
        this.analyticsService.trackEvent('chrome_extension_install_clicked');
        this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.BROWSER_INSTALL_OPENED, ...(await openChromeExtensionInstall()) });
        return true;
      case MESSAGE_TYPES.GET_BROWSER_STATUS:
      case MESSAGE_TYPES.SET_BROWSER_ENABLED:
        if (data.type === MESSAGE_TYPES.SET_BROWSER_ENABLED) {
          await setControlChromeEnabled(this.context, data.enabled === true);
          this.analyticsService.trackEvent('control_chrome_toggled', { enabled: data.enabled === true });
        }
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.BROWSER_STATUS,
          enabled: isControlChromeEnabled(this.context),
          connected: isBrowserConnected(),
        });
        return true;
      case MESSAGE_TYPES.GET_RECENT_FOLDERS:
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.RECENT_FOLDERS,
          current: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
          recent: getRecentFolders(this.context),
          home: os.homedir(),
          defaultFolder: getDefaultFolder(this.context) ?? '',
        });
        return true;
      case MESSAGE_TYPES.SET_DEFAULT_FOLDER:
        this.analyticsService.trackEvent('default_folder_set', { cleared: typeof data.path !== 'string' });
        try {
          await setDefaultFolder(this.context, typeof data.path === 'string' ? data.path : undefined);
          this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.DEFAULT_FOLDER_RESULT, ok: true });
          await this.handleMessage({ type: MESSAGE_TYPES.GET_RECENT_FOLDERS });
        } catch (error) {
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.DEFAULT_FOLDER_RESULT,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      case MESSAGE_TYPES.GET_PENDING_FOLDER_START:
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.PENDING_FOLDER_START,
          start: await takePendingStart(this.context, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
        });
        return true;
      case MESSAGE_TYPES.OPEN_WORKSPACE_FOLDER:
        // A ticket started outside its default folder: save the start for the
        // page that loads in the new folder, since this host ends on open.
        if (data.resume && typeof data.path === 'string') {
          this.analyticsService.trackEvent('workspace_folder_switch', { picker: false, fromTicket: true });
          const folder = data.path;
          await this.runWorkspaceAction('switch-default-folder', async () => {
            await savePendingStart(this.context, folder, data.resume);
            await openFolder(folder);
          });
          return true;
        }
        this.analyticsService.trackEvent('workspace_folder_switch', { picker: typeof data.path !== 'string' });
        // 'pick-folder' answers once the picker closes, picked or cancelled;
        // a picked folder then restarts the host like 'open-folder' does.
        await this.runWorkspaceAction(typeof data.path === 'string' ? 'open-folder' : 'pick-folder', () =>
          openFolder(typeof data.path === 'string' ? data.path : undefined)
        );
        return true;
      case MESSAGE_TYPES.LIST_GIT_BRANCHES:
        await this.handleListGitBranches();
        return true;
      case MESSAGE_TYPES.SWITCH_GIT_BRANCH:
        this.analyticsService.trackEvent('git_branch_switch', { create: !!data.create, worktree: !!data.worktree });
        await this.runWorkspaceAction(data.worktree ? 'open-folder' : 'switch-branch', async () => {
          const cwd = this.viewedRoots()[0]?.uri.fsPath;
          if (!cwd) throw new Error('No folder is open.');
          if (data.worktree) {
            // Opening the worktree ends this host, like any folder open.
            await openFolder(await ensureWorktree(cwd, String(data.branch ?? ''), !!data.create));
            return;
          }
          await switchBranch(cwd, String(data.branch ?? ''), !!data.create);
          await this.handleGetGitStatus();
        });
        return true;
      case MESSAGE_TYPES.SEARCH_MENTION_TARGETS:
        await this.handleSearchMentionTargets(data);
        return true;
      case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS:
        this.analyticsService.trackEvent('models_fetched');
        await this.handleFetchAvailableModels(data);
        return true;
      case MESSAGE_TYPES.COPILOT_STATUS:
        await this.postCopilotStatus();
        return true;
      case MESSAGE_TYPES.COPILOT_SIGN_OUT:
        await signOutDirectCopilot();
        await this.postCopilotStatus();
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
      case MESSAGE_TYPES.SESSION_CHANGED:
        await this.handleSessionChanged(data.sessionId ?? null);
        return true;
      case MESSAGE_TYPES.DELETE_CHAT_HISTORY:
        await this.handleDeleteChatHistory(data);
        return true;
      case MESSAGE_TYPES.UPDATE_CHAT_SESSION_META:
        await this.handleUpdateChatSessionMeta(data);
        return true;
      case MESSAGE_TYPES.OPEN_SESSION_IN:
        await this.handleOpenSessionIn(data);
        return true;
      case MESSAGE_TYPES.IMPORT_DETECT:
        await this.handleImportDetect();
        return true;
      case MESSAGE_TYPES.IMPORT_RUN:
        await this.handleImportRun(data);
        return true;
    }
    return false;
  }

  private async handleNewChat(): Promise<void> {
    try {
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
      }
      await this.chatService.newChat();
    } catch (error) {
      this.handleError('Error starting new chat:', error);
    }
  }

  private async handleSendMessage(data: any): Promise<void> {
    try {
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
      }
      const { sessionId, message, modelId, apiKey, provider, contextSelection, attachments, mentions, historyOverride, autonomous, planMode, assistantMode, executePlan, turnAction, permission } = data;
      await this.chatService.sendMessage(sessionId, message, modelId, apiKey, provider, contextSelection, attachments, mentions, historyOverride, !!autonomous, !!planMode, assistantMode === 'chat' ? 'chat' : 'work', !!executePlan, turnAction === 'publish-spike' ? 'publish-spike' : undefined, isPermission(permission) ? permission : undefined);
    } catch (error) {
      this.analyticsService.trackEvent('message_send_error', {
        modelId: data.modelId,
        provider: data.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.handleError('Error:', error);
    }
  }

  /**
   * Composer @-mention picker: answer with the workspace files/folders matching
   * what the user has typed so far. Always replies (even on failure or with no
   * workspace open) so the webview can clear its in-flight state rather than
   * leaving a spinner up.
   */
  private async handleSearchMentionTargets(data: any): Promise<void> {
    let targets: Awaited<ReturnType<typeof searchMentionTargets>> = [];
    try {
      const roots = this.viewedRoots();
      targets = await searchMentionTargets(String(data.query ?? ''), roots);
    } catch (error) {
      console.warn('Mention search failed:', error);
    }
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.SEARCH_MENTION_TARGETS_RESPONSE,
      requestId: data.requestId,
      targets,
    });
  }

  /** Open a reviewed file (workspace-relative, possibly root-prefixed) in the editor. */
  private async handleOpenFileInEditor(relOrPrefixed: string, line?: number, endLine?: number): Promise<void> {
    if (!relOrPrefixed) return;
    try {
      const roots = this.viewedRoots();
      const resolved = resolveAgainstRoots(roots, relOrPrefixed);
      let absPath = resolved ? path.resolve(resolved.root.uri.fsPath, resolved.relPath) : undefined;
      if (absPath && !(await fileExists(absPath))) absPath = undefined;
      if (!absPath && !relOrPrefixed.includes('/')) {
        // A bare `file.ts:L12` citation: the report format asks for full
        // paths, but models cite the file they just edited by name alone.
        // Resolve by name when the workspace holds exactly one such file.
        const hits = await vscode.workspace.findFiles(`**/${relOrPrefixed}`, '**/node_modules/**', 2);
        if (hits.length === 1) absPath = hits[0].fsPath;
      }
      if (!absPath) {
        vscode.window.showWarningMessage(`Could not resolve "${relOrPrefixed}" in the current workspace.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      if (line) {
        const start = new vscode.Position(Math.max(0, line - 1), 0);
        const end = new vscode.Position(Math.max(0, (endLine ?? line) - 1), 0);
        editor.selection = new vscode.Selection(start, start);
        editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      this.handleError('Error opening file:', error);
    }
  }

  /**
   * Open a URL in the user's browser (ticket chip, links in model prose).
   * The URL may originate from model output, so only http(s) is honored — a
   * `command:` or `file:` URI would turn a chat link into arbitrary local
   * action.
   */
  private async handleOpenExternal(rawUrl: string): Promise<void> {
    if (!rawUrl) return;
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(rawUrl, true);
    } catch {
      vscode.window.showWarningMessage(`Not a valid link: ${rawUrl}`);
      return;
    }
    if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
      vscode.window.showWarningMessage(`Refusing to open a "${parsed.scheme}:" link from chat.`);
      return;
    }
    await vscode.env.openExternal(parsed);
  }

  /** Open a review diff (original ⟷ current) for a file the agent changed this session. */
  private async handleOpenDiffInEditor(relOrPrefixed: string): Promise<void> {
    if (!relOrPrefixed) return;
    try {
      const roots = this.viewedRoots();
      const resolved = resolveAgainstRoots(roots, relOrPrefixed);
      if (!resolved) {
        vscode.window.showWarningMessage(`Could not resolve "${relOrPrefixed}" in the current workspace.`);
        return;
      }
      const absPath = path.resolve(resolved.root.uri.fsPath, resolved.relPath);
      await openAgentDiff(this.context, absPath);
    } catch (error) {
      this.handleError('Error opening diff:', error);
    }
  }

  private service(): ChatService {
    if (!this.chatService) {
      this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
    }
    return this.chatService;
  }

  /**
   * The roots of the chat on screen: its own folder, which need not be the
   * one open in the window. A new chat that has not sent yet works in the open one.
   */
  private viewedRoots(): NamedRoot[] {
    if (!this.viewedSessionId) return getNamedRoots(vscode.workspace.workspaceFolders ?? []);
    return this.service().sessionRoots(this.viewedSessionId);
  }

  /** The chat on screen changed: learn its recorded folder once, then refresh the git bar for it. */
  private async handleSessionChanged(sessionId: string | null): Promise<void> {
    // Read the recorded folder before the session becomes the viewed one, so
    // nothing in between resolves it to the open folder instead.
    const change = ++this.sessionChangeSeq;
    const stored = sessionId ? (await this.historyService.getChatSession(sessionId))?.workspaceFolder : undefined;
    if (change !== this.sessionChangeSeq) return;
    if (sessionId) this.service().sessionRoots(sessionId, stored);
    this.viewedSessionId = sessionId;
    await this.handleGetGitStatus();
  }

  /** Failing-log cache: the log of a given head commit is fetched once, not on every poll. */
  private ciLog?: { sha: string; log: string };

  /** Snapshot of CI for the PR on the chat's branch; the failing log rides along once it has failed. */
  private async handleCiStatus(sessionId: unknown): Promise<void> {
    const sid = typeof sessionId === 'string' ? sessionId : null;
    try {
      const cwd = this.viewedRoots()[0]?.uri.fsPath;
      // The code-host connection that owns this repo when there is one; the gh CLI otherwise.
      const target = cwd ? await new CodeHostConnections(this.context).forRepo(cwd) : null;
      const snapshot = cwd ? ((target && (await getCiSnapshotViaHost(cwd, target))) || (await getCiSnapshot(cwd))) : { state: 'none' as const, checks: [] };
      if (cwd && snapshot.state === 'failed' && snapshot.pr) {
        if (this.ciLog?.sha !== snapshot.pr.sha) {
          const log = (target && (await getFailureLogViaHost(snapshot.checks, target))) || (await getFailureLog(cwd, snapshot.checks));
          this.ciLog = { sha: snapshot.pr.sha, log };
        }
        snapshot.failureLog = this.ciLog.log;
      }
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.CI_STATUS, sessionId: sid, ...snapshot });
    } catch (error) {
      this.handleError('Error getting CI status:', error);
    }
  }

  /** Commit the fix to the PR's own branch and push it, so CI runs again. */
  private async handleCiPushFix(data: { requestId?: string; files?: unknown; branch?: unknown; subject?: unknown }): Promise<void> {
    const files = Array.isArray(data.files) ? data.files.filter((f): f is string => typeof f === 'string') : [];
    const result = await pushCiFix(this.viewedRoots(), files, String(data.branch ?? ''), String(data.subject || 'fix: address failing CI'));
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.CI_PUSH_FIX_DONE, requestId: data.requestId, ok: result.pushed, error: result.error });
    if (result.pushed) await this.handleGetGitStatus();
  }

  /**
   * Refresh for the composer's git status bar: branch, working-tree diff
   * stats, and which of the on-screen chat's recorded `paths` are still
   * uncommitted. Called with no paths by the watcher, which reuses the last.
   */
  private async handleGetGitStatus(paths?: unknown): Promise<void> {
    if (Array.isArray(paths)) this.gitStatusPaths = paths.filter((p): p is string => typeof p === 'string');
    this.watchGitStatus();
    try {
      const roots = this.viewedRoots();
      const status = await getGitStatus(roots, this.gitStatusPaths);
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.GIT_STATUS, ...status });
    } catch (error) {
      this.handleError('Error getting git status:', error);
    }
  }

  private async handleListGitBranches(): Promise<void> {
    const reply = (payload: Record<string, unknown>) =>
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.GIT_BRANCHES, ...payload });
    const cwd = this.viewedRoots()[0]?.uri.fsPath;
    if (!cwd) {
      reply({ branches: [], error: 'No folder is open.' });
      return;
    }
    try {
      reply(await listBranches(cwd));
    } catch (error) {
      reply({ branches: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Folder and branch switches from the new-chat screen. Both change the files
   * every chat's agent is working on, so they wait until no run is in flight.
   */
  private async runWorkspaceAction(action: string, work: () => Promise<void>): Promise<void> {
    const reply = (ok: boolean, error?: string) =>
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.WORKSPACE_ACTION_RESULT, action, ok, error });
    if (this.chatService?.hasRunInFlight()) {
      reply(false, 'A chat is still running. Stop it or let it finish first.');
      return;
    }
    try {
      await work();
      reply(true);
    } catch (error) {
      reply(false, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Push a fresh git status whenever the tree can change under the bar
   * without the webview knowing: a file written by anything (another chat, a
   * terminal `git checkout`, the editor), a commit or branch switch, or the
   * window regaining focus. Debounced: one checkout fires an event per file,
   * and one `git status` after they settle is all the bar needs.
   */
  private watchGitStatus(): void {
    // Watch the chat on screen's folder; re-arm when it moves to another one.
    const root = this.viewedRoots()[0]?.uri;
    if (this.gitStatusWatch && this.gitStatusWatchRoot === root?.fsPath) return;
    this.gitStatusWatch?.dispose();
    this.gitStatusWatchRoot = root?.fsPath;
    const schedule = () => {
      clearTimeout(this.gitStatusTimer);
      this.gitStatusTimer = setTimeout(() => void this.handleGetGitStatus(), GIT_STATUS_DEBOUNCE_MS);
    };
    const onFile = (uri: vscode.Uri) => {
      // Inside .git only a moved HEAD or ref changes the diff against HEAD.
      // The index is rewritten by `git add` and by status runs themselves, so
      // reacting to it would feed a refresh loop.
      const inGit = uri.path.match(/\/\.git\/(.+)$/);
      if (inGit && !/^(HEAD|packed-refs|refs\/)/.test(inGit[1])) return;
      schedule();
    };
    const watcher = vscode.workspace.createFileSystemWatcher(root ? new vscode.RelativePattern(root, '**/*') : '**/*');
    this.gitStatusWatch = vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(onFile),
      watcher.onDidChange(onFile),
      watcher.onDidDelete(onFile),
      vscode.window.onDidChangeWindowState((state) => state.focused && schedule())
    );
  }

  /** "Create PR" from the git status bar — ships the whole working tree, not just this turn's files. */
  private async handleShipAll(requestId?: string): Promise<void> {
    const reply = (payload: Record<string, unknown>) =>
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.AGENT_SHIP_ALL_DONE, requestId, ...payload });
    try {
      const roots = this.viewedRoots();
      const result = await shipAllChanges(roots, () => undefined, (suggestion, paths) =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: 'Create pull request',
            // Name what is about to be committed: this ships every uncommitted
            // file, whichever chat (or editor) changed it.
            prompt:
              `Commits all ${paths.length} uncommitted file${paths.length === 1 ? '' : 's'} in the working tree, from any chat or editor: ` +
              `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}. ` +
              'Commit subject, Conventional Commits style — it names the branch too.',
            value: suggestion,
            // Preselect just the subject, so Enter accepts and typing replaces
            // the wording without clobbering the inferred type prefix.
            valueSelection: [suggestion.indexOf(': ') + 2, suggestion.length],
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Enter a short description of the change.'),
          })
        ),
        new CodeHostConnections(this.context)
      );
      if (!result) {
        reply({ ok: false, cancelled: true });
        return;
      }
      reply({ ok: true, branch: result.branch, baseBranch: result.baseBranch, pushed: result.pushed, prUrl: result.prUrl, warnings: result.warnings });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Webview AGENT_REVERT_CHECKPOINT handler — confirm, then undo everything checkpointed since that turn began. */
  private async handleRevertCheckpoint(sha: string): Promise<void> {
    if (!sha) return;
    try {
      const confirm = await vscode.window.showWarningMessage(
        'Undo all changes made since this message? Anything you edited yourself afterward, and never checkpointed, is left alone.',
        { modal: true },
        'Undo'
      );
      if (confirm !== 'Undo') return;
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
      }
      const { restored, removed } = await this.chatService.revertToCheckpoint(sha);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.AGENT_REVERT_DONE,
        sha,
        ok: true,
        restored: restored.length,
        removed: removed.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`WorkspaceGPT: could not undo — ${errorMessage}`);
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.AGENT_REVERT_DONE, sha, ok: false, error: errorMessage });
    }
  }

  private async handleStopMessage(sessionId?: string): Promise<void> {
    try {
      if (this.chatService) {
        this.chatService.stopMessage(sessionId);
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

  private async postCopilotStatus(): Promise<void> {
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.COPILOT_STATUS_RESPONSE, ...(await getCopilotStatus()) });
  }

  private async handleFetchAvailableModels(data: any) {
    if (data.provider === COPILOT_PROVIDER) {
      // Selecting Copilot is what starts its loopback bridge; the bridge's URL
      // and token then stand in for the provider's (see copilotBridge.ts).
      const bridge = await ensureCopilotBridge().catch(() => undefined);
      // Desktop: no vscode.lm, so picking Copilot opens the (unofficial,
      // opt-in) GitHub sign-in — see copilotDirect.ts.
      const directError = bridge && usesDirectCopilot() ? await ensureDirectCopilotReady(!!data.signIn) : undefined;
      await this.postCopilotStatus();
      // No models: not signed in to Copilot, or a window without it (the
      // Extension Development Host doesn't load the built-in Copilot).
      if (!bridge || directError || (!usesDirectCopilot() && !(await listCopilotModels().catch(() => [])).length)) {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_ERROR,
          provider: data.provider,
          models: [],
          message:
            directError ?? 'No GitHub Copilot models found. Sign in to GitHub Copilot in VS Code, then reopen Settings.',
        });
        return;
      }
      data = { ...data, baseUrl: bridge.baseUrl, apiKey: bridge.token };
    }
    const baseURL =
      data.baseUrl || MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === data.provider)?.BASE_URL;
    const apiKey = data.apiKey;
    if (!baseURL || !apiKey) return;
    try {
      const models = await fetchAvailableModels(baseURL, data.apiKey);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_RESPONSE,
        // Echoed so the webview can drop a late response for a provider the
        // user has already switched away from.
        provider: data.provider,
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
        provider: data.provider,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleSaveChatHistory(data: any): Promise<void> {
    try {
      // Taken from the run, not from the message: the webview's switch shows
      // the mode of whatever chat is on screen, which is not necessarily the
      // one being saved (a backgrounded session saves itself while the user
      // is elsewhere). Only used when the file has no mode yet — see
      // saveHistory, where the first stored value wins.
      // The folder is this host's: every run in it works in that folder.
      await this.historyService.saveHistory(
        data.sessionId,
        data.messages,
        this.chatService?.assistantModeFor(data.sessionId),
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      );
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
      const session = await this.historyService.getChatSession(data.sessionId);
      const messages = session?.messages ?? null;
      // Seed the opened session's model-facing context from its transcript.
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
      }
      this.chatService.loadHistory(data.sessionId, messages as any[], session?.workspaceFolder);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.GET_CHAT_SESSION_RESPONSE,
        sessionId: data.sessionId,
        messages,
        // Reopening puts the UI back in the mode the conversation was held in,
        // so continuing it does not silently run the next turn with a
        // different set of sources than the turns above it.
        assistantMode: session?.assistantMode ?? 'work',
      });
      // Restore the context meter for the chat being opened. Without this the
      // webview has nothing to show for a session it did not run this
      // lifetime, and the meter reads 0% on a conversation that is nearly
      // full — see AGENT_CONTEXT handling in App.tsx.
      const lastContext = this.chatService.lastContextFor(data.sessionId);
      if (lastContext) {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.AGENT_CONTEXT,
          sessionId: data.sessionId,
          ...lastContext,
        });
      }
    } catch (error) {
      console.error('Error getting chat session:', error);
    }
  }

  private async handleImportDetect(): Promise<void> {
    const sources = await new ImportService(this.historyService).detect();
    const log = await this.historyService.readImportLog();
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.IMPORT_DETECT_RESULT, sources, log });
  }

  private async handleImportRun(data: any): Promise<void> {
    if (data?.source !== 'claude-code' && data?.source !== 'cursor') return;
    const source = data.source as ImportSource;
    const result = await new ImportService(this.historyService).run(source, (done, total) =>
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.IMPORT_PROGRESS, source, done, total })
    );
    // Counts only: what was in the chats never reaches analytics.
    this.analyticsService.trackEvent('chats_imported', { source, imported: result.imported, failed: result.failed });
    // A run that found nothing new is not worth a history line.
    if (result.imported || result.failed || result.error) {
      await this.historyService.appendImportLog({
        source,
        at: Date.now(),
        imported: result.imported,
        failed: result.failed,
        ...(result.error && { error: result.error }),
      });
    }
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.IMPORT_RESULT, result });
    await this.handleGetChatHistoryList();
  }

  private async handleUpdateChatSessionMeta(data: any): Promise<void> {
    if (typeof data?.sessionId !== 'string') return;
    const patch: { title?: string; pinned?: boolean; group?: string } = {};
    if (typeof data.title === 'string') patch.title = data.title;
    if (typeof data.pinned === 'boolean') patch.pinned = data.pinned;
    if (typeof data.group === 'string') patch.group = data.group;
    try {
      await this.historyService.updateSessionMeta(data.sessionId, patch);
      await this.handleGetChatHistoryList();
    } catch (error) {
      console.error('Error updating chat session:', error);
    }
  }

  /** Open the folder a chat was held in. The path comes from the stored chat, not from the webview. */
  private async handleOpenSessionIn(data: any): Promise<void> {
    const list = await this.historyService.getHistoryList();
    const folder = list.find((session) => session.id === data?.sessionId)?.workspaceFolder;
    if (!folder) return;
    await openFolderIn(data.target, folder);
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
