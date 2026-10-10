import * as vscode from 'vscode';
import * as path from 'path';
import { ensureDirectoryExists } from '../utils/ensureDirectoryExists';

export interface ChatSessionPreview {
  id: string;
  title: string;
  updatedAt: number;
  /** Exact source link, so Home never matches the same number in another tracker/org. */
  ticketUrl?: string;
  /**
   * Which mode this chat was held in. Sessions written before the Chat/Work
   * switch existed have no stored value and read as 'work' — that is what
   * they actually were, since docs, tickets and the codebase were always in
   * play back then.
   */
  assistantMode: 'chat' | 'work';
  /**
   * The folder that was open when this chat was started — the one its agent
   * worked in. Absent when none was open, and for chats saved before this
   * was recorded (nothing in those files says which folder it was).
   */
  workspaceFolder?: string;
  /** Pinned chats are listed first. Stored beside the chats, not in them. */
  pinned?: boolean;
  /** Name of the user-made group the chat was filed under. */
  group?: string;
  /** Sum of agent turn diffs in this session; omitted when there were no edits. */
  added?: number;
  removed?: number;
}

export interface ChatMessage {
  content: string;
  isUser: boolean;
  isError?: boolean;
}

/** Resume only the ticket the run actually worked on, not another search hit. */
export function sessionTicketUrl(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (const message of [...messages].reverse()) {
    const summary = message?.turnSummary;
    if (!summary?.ticketId || !Array.isArray(summary.refs)) continue;
    const ref = summary.refs.find((r: any) => r.kind === 'work-item' && String(r.id) === String(summary.ticketId) && typeof r.url === 'string');
    if (ref) return ref.url;
  }
  return undefined;
}

/** Longest title the history list can show before it ellipsizes anyway. */
const TITLE_MAX_CHARS = 60;

/**
 * A chat's title, from its first user message.
 *
 * Ticket-seeded prompts all begin "Work on ticket 1324128 (Price rounding on
 * …) — read the ticket and any design doc behind it, …", so a plain
 * 30-character cut produced a history full of identical "Work on ticket
 * 1324128 (Price ..." rows. Those get "#1324128 Price rounding on …" instead;
 * anything else is the message's first line, trimmed to fit.
 */
export function deriveSessionTitle(firstMessage: string): string {
  const text = (firstMessage ?? '').trim();
  if (!text) return 'New Chat';

  // Greedy up to the last ")" before the prompt tail, so a summary that
  // itself contains parentheses survives whole.
  const ticket = text.match(/^work on ticket\s+#?(\d+)\s*\((.*)\)\s*(?:—|–|-|autonomously|$)/i);
  if (ticket) {
    const summary = ticket[2].trim();
    return truncate(summary ? `#${ticket[1]} ${summary}` : `#${ticket[1]}`);
  }

  const firstLine = text.split(/\r?\n/)[0].trim() || text;
  return truncate(firstLine);
}

function truncate(text: string): string {
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : text;
}

function sessionDiffStats(messages: unknown): { added: number; removed: number } | undefined {
  if (!Array.isArray(messages)) return undefined;
  let added = 0;
  let removed = 0;
  for (const message of messages) {
    const files = (message as { turnSummary?: { filesChanged?: Array<{ added?: number; removed?: number }> } })
      ?.turnSummary?.filesChanged;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      added += Number(file?.added) || 0;
      removed += Number(file?.removed) || 0;
    }
  }
  if (added === 0 && removed === 0) return undefined;
  return { added, removed };
}

/**
 * Sessions deleted during this host run. Deletion removes the file, but the
 * chat webview can still have a save in flight for the same id — the debounced
 * autosave, the save-before-new-chat, or a background run's per-turn save —
 * and that write would recreate the row the user just removed. Session ids are
 * never reused, so once an id is deleted no later write for it is legitimate.
 * Module level because the Sessions sidebar and the message handler each hold
 * their own HistoryService instance.
 */
const deletedSessionIds = new Set<string>();

/**
 * What the user has done to a chat from the history menu. Kept in one file
 * next to the chats folder rather than inside each chat: saveHistory rewrites
 * a chat file from scratch on every turn and would drop anything it did not
 * know about, and getHistoryList reads every *.json in the chats folder.
 */
export interface SessionMeta {
  title?: string;
  pinned?: boolean;
  group?: string;
}

/** One finished import run, kept so Settings can show what was brought in and when. */
export interface ImportLogEntry {
  source: 'claude-code' | 'cursor';
  at: number;
  imported: number;
  failed: number;
  error?: string;
}

export class HistoryService {
  private historyDir: vscode.Uri;

  constructor(private context: vscode.ExtensionContext) {
    this.historyDir = vscode.Uri.file(
      path.join(this.context.globalStorageUri.fsPath, 'chats')
    );
  }

  private get metaFile(): vscode.Uri {
    return vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'chat-meta.json'));
  }

  private async readMeta(): Promise<Record<string, SessionMeta>> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.metaFile);
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeMeta(meta: Record<string, SessionMeta>): Promise<void> {
    await ensureDirectoryExists(this.context.globalStorageUri.fsPath);
    await vscode.workspace.fs.writeFile(this.metaFile, new TextEncoder().encode(JSON.stringify(meta)));
  }

  /** Merge a change into a chat's meta; an empty string or false clears that field. */
  public async updateSessionMeta(sessionId: string, patch: SessionMeta): Promise<void> {
    const all = await this.readMeta();
    const next: SessionMeta = { ...all[sessionId], ...patch };
    if (!next.title?.trim()) delete next.title;
    else next.title = next.title.trim().slice(0, 120);
    if (!next.pinned) delete next.pinned;
    if (!next.group?.trim()) delete next.group;
    else next.group = next.group.trim().slice(0, 60);
    if (Object.keys(next).length) all[sessionId] = next;
    else delete all[sessionId];
    await this.writeMeta(all);
  }

  public get storageDir(): vscode.Uri {
    return this.historyDir;
  }

  private async initializeDirectory() {
    await ensureDirectoryExists(this.historyDir.fsPath);
  }

  public async saveHistory(
    sessionId: string,
    messages: ChatMessage[],
    assistantMode?: 'chat' | 'work',
    workspaceFolder?: string
  ): Promise<void> {
    if (deletedSessionIds.has(sessionId)) return;
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    const firstUserMessage = messages.find(m => m.isUser);
    const title = firstUserMessage ? deriveSessionTitle(firstUserMessage.content) : 'New Chat';

    let updatedAt = Date.now();
    // A session belongs to the mode it was STARTED in, so the first stored
    // value wins: re-filing a finished conversation because the switch was
    // flipped afterwards would move it out from under the user.
    let mode: 'chat' | 'work' = assistantMode === 'chat' ? 'chat' : 'work';
    // The folder is kept the same way. A file written before folders were
    // recorded stays without one (undefined, key left out) rather than being
    // filed under whatever folder is open when it happens to be re-saved.
    let folder: string | null | undefined = workspaceFolder || null;
    try {
      const existingBytes = await vscode.workspace.fs.readFile(filePath);
      const existingData = JSON.parse(new TextDecoder().decode(existingBytes));
      if (existingData.assistantMode === 'chat' || existingData.assistantMode === 'work') {
        mode = existingData.assistantMode;
      }
      folder = 'workspaceFolder' in existingData ? existingData.workspaceFolder || null : undefined;
      
      // If the number of messages hasn't changed, and the last message content is the same,
      // it's a spurious save (e.g., from just viewing the chat). Preserve the old updatedAt.
      if (existingData.messages && existingData.messages.length === messages.length) {
        const lastExisting = existingData.messages[existingData.messages.length - 1];
        const lastNew = messages[messages.length - 1];
        if (
          (!lastExisting && !lastNew) || 
          (lastExisting && lastNew && lastExisting.content === lastNew.content && lastExisting.isError === lastNew.isError)
        ) {
          updatedAt = existingData.updatedAt || updatedAt;
        }
      } else if (existingData.updatedAt && messages.length < existingData.messages?.length) {
         // Should ideally not happen, but if somehow messages are fewer, maybe don't bump updatedAt unless it's a real update
         // Actually, just let it bump if messages length changed.
      }
    } catch (e) {
      // File doesn't exist or is invalid, use Date.now()
    }

    const data = {
      id: sessionId,
      title,
      updatedAt,
      assistantMode: mode,
      ...(folder !== undefined && { workspaceFolder: folder }),
      messages,
    };

    const writeData = new TextEncoder().encode(JSON.stringify(data));
    await vscode.workspace.fs.writeFile(filePath, writeData);
  }

  private get importLogFile(): vscode.Uri {
    return vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'import-log.json'));
  }

  /** Past imports, newest first. */
  public async readImportLog(): Promise<ImportLogEntry[]> {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.importLogFile)));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public async appendImportLog(entry: ImportLogEntry): Promise<void> {
    const log = [entry, ...(await this.readImportLog())].slice(0, 50);
    await ensureDirectoryExists(this.context.globalStorageUri.fsPath);
    await vscode.workspace.fs.writeFile(this.importLogFile, new TextEncoder().encode(JSON.stringify(log)));
  }

  /** Whether a saved chat with this id exists. */
  public async hasSession(sessionId: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`)));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a chat that was made elsewhere, keeping its own time and title.
   * saveHistory cannot: it stamps "now" and derives the title. An id already
   * in history is left alone so importing twice never duplicates or overwrites.
   * Returns whether it was written.
   */
  public async importSession(
    sessionId: string,
    chat: { title?: string; updatedAt: number; workspaceFolder?: string; messages: ChatMessage[] }
  ): Promise<boolean> {
    if (await this.hasSession(sessionId)) return false;
    await this.initializeDirectory();
    const data = {
      id: sessionId,
      title: chat.title || deriveSessionTitle(chat.messages.find((m) => m.isUser)?.content ?? ''),
      updatedAt: chat.updatedAt,
      assistantMode: chat.workspaceFolder ? 'work' : 'chat',
      ...(chat.workspaceFolder && { workspaceFolder: chat.workspaceFolder }),
      messages: chat.messages,
    };
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    await vscode.workspace.fs.writeFile(filePath, new TextEncoder().encode(JSON.stringify(data)));
    return true;
  }

  public async getHistoryList(): Promise<ChatSessionPreview[]> {
    await this.initializeDirectory();
    try {
      const files = await vscode.workspace.fs.readDirectory(this.historyDir);
      const previews: ChatSessionPreview[] = [];
      const meta = await this.readMeta();

      for (const [filename, type] of files) {
        if (type === vscode.FileType.File && filename.endsWith('.json')) {
          const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, filename));
          try {
            const dataBytes = await vscode.workspace.fs.readFile(filePath);
            const dataString = new TextDecoder().decode(dataBytes);
            const data = JSON.parse(dataString);

            // Derive the title afresh from the stored messages rather than
            // trusting the saved one: sessions written before ticket-aware
            // titling carry "Work on ticket 1324128 (Price ..." cut at 30
            // characters, and they only get re-saved if the user reopens and
            // continues them. The list is what the user sees, so fix it here.
            const firstUserMessage = Array.isArray(data.messages)
              ? data.messages.find((m: ChatMessage) => m?.isUser && typeof m.content === 'string')
              : undefined;
            const title = firstUserMessage ? deriveSessionTitle(firstUserMessage.content) : data.title || 'New Chat';

            const diffs = sessionDiffStats(data.messages);
            const ticketUrl = sessionTicketUrl(data.messages);
            previews.push({
              id: data.id,
              title: meta[data.id]?.title || title,
              updatedAt: data.updatedAt,
              ...(ticketUrl && { ticketUrl }),
              ...(meta[data.id]?.pinned && { pinned: true }),
              ...(meta[data.id]?.group && { group: meta[data.id].group }),
              assistantMode: data.assistantMode === 'chat' ? 'chat' : 'work',
        ...(typeof data.workspaceFolder === 'string' && data.workspaceFolder && { workspaceFolder: data.workspaceFolder }),
              ...(typeof data.workspaceFolder === 'string' && data.workspaceFolder && { workspaceFolder: data.workspaceFolder }),
              ...(diffs ?? {}),
            });
          } catch (e) {
            console.error(`Error reading history file ${filename}:`, e);
          }
        }
      }

      // Sort by newest first
      return previews.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (e) {
      console.error('Error reading history directory:', e);
      return [];
    }
  }

  public async getChatSession(
    sessionId: string
  ): Promise<{ messages: ChatMessage[]; assistantMode: 'chat' | 'work'; workspaceFolder?: string } | null> {
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    try {
      const dataBytes = await vscode.workspace.fs.readFile(filePath);
      const dataString = new TextDecoder().decode(dataBytes);
      const data = JSON.parse(dataString);
      return {
        messages: data.messages || [],
        assistantMode: data.assistantMode === 'chat' ? 'chat' : 'work',
        ...(typeof data.workspaceFolder === 'string' && data.workspaceFolder && { workspaceFolder: data.workspaceFolder }),
      };
    } catch (e) {
      // It's possible the file doesn't exist yet, which is fine
      return null;
    }
  }

  public async deleteChatSession(sessionId: string): Promise<void> {
    deletedSessionIds.add(sessionId);
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    try {
      await vscode.workspace.fs.delete(filePath, { useTrash: false });
    } catch (e) {
      console.error(`Error deleting chat session ${sessionId}:`, e);
    }
    try {
      await this.updateSessionMeta(sessionId, { title: '', pinned: false, group: '' });
    } catch {
      // A stale meta entry is harmless: it only applies to an id that no longer lists.
    }
  }
}
