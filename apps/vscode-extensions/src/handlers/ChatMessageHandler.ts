import * as vscode from 'vscode';
import * as path from 'path';
import { MESSAGE_TYPES, MODEL_PROVIDERS } from '../../constants';
import { ChatService } from '../services/chatService';
import { HistoryService } from '../services/historyService';
import { AnalyticsService } from '../services/analyticsService';
import { fetchAvailableModels } from 'src/utils/fetchAvailableModels';
import { getNamedRoots, resolveAgainstRoots } from '../services/codebase/codebaseTools';
import { openAgentDiff } from '../services/agent/agentDiffProvider';
import { searchMentionTargets } from '../services/codebase/mentionSearch';

export class ChatMessageHandler {
  private chatService?: ChatService;

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
      case MESSAGE_TYPES.AGENT_REVERT_CHECKPOINT:
        this.analyticsService.trackEvent('agent_revert_checkpoint_triggered');
        await this.handleRevertCheckpoint(data.sha);
        return true;
      case MESSAGE_TYPES.OPEN_DIFF_IN_EDITOR:
        await this.handleOpenDiffInEditor(data.path);
        return true;
      case MESSAGE_TYPES.SEARCH_MENTION_TARGETS:
        await this.handleSearchMentionTargets(data);
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
      const { sessionId, message, modelId, apiKey, provider, contextSelection, attachments, mentions, historyOverride } = data;
      await this.chatService.sendMessage(sessionId, message, modelId, apiKey, provider, contextSelection, attachments, mentions, historyOverride);
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
      const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
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
      const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
      const resolved = resolveAgainstRoots(roots, relOrPrefixed);
      if (!resolved) {
        vscode.window.showWarningMessage(`Could not resolve "${relOrPrefixed}" in the current workspace.`);
        return;
      }
      const absPath = path.resolve(resolved.root.uri.fsPath, resolved.relPath);
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

  /** Open a review diff (original ⟷ current) for a file the agent changed this session. */
  private async handleOpenDiffInEditor(relOrPrefixed: string): Promise<void> {
    if (!relOrPrefixed) return;
    try {
      const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
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

  /** Webview AGENT_REVERT_CHECKPOINT handler — confirm, then hard-reset to that turn's snapshot. */
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
      await this.chatService.revertToCheckpoint(sha);
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.AGENT_REVERT_DONE, sha, ok: true });
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

  private async handleFetchAvailableModels(data: any) {
    const baseURL =
      data.baseUrl || MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === data.provider)?.BASE_URL;
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
      // Seed the opened session's model-facing context from its transcript.
      if (!this.chatService) {
        this.chatService = new ChatService(this.webviewView, this.context, this.analyticsService);
      }
      this.chatService.loadHistory(data.sessionId, messages as any[]);
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
