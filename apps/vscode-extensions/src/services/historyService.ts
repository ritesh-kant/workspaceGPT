import * as vscode from 'vscode';
import * as path from 'path';
import { ensureDirectoryExists } from '../utils/ensureDirectoryExists';

export interface ChatSessionPreview {
  id: string;
  title: string;
  updatedAt: number;
}

export interface ChatMessage {
  content: string;
  isUser: boolean;
  isError?: boolean;
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

export class HistoryService {
  private historyDir: vscode.Uri;

  constructor(private context: vscode.ExtensionContext) {
    this.historyDir = vscode.Uri.file(
      path.join(this.context.globalStorageUri.fsPath, 'chats')
    );
  }

  private async initializeDirectory() {
    await ensureDirectoryExists(this.historyDir.fsPath);
  }

  public async saveHistory(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    const firstUserMessage = messages.find(m => m.isUser);
    const title = firstUserMessage ? deriveSessionTitle(firstUserMessage.content) : 'New Chat';

    let updatedAt = Date.now();
    try {
      const existingBytes = await vscode.workspace.fs.readFile(filePath);
      const existingData = JSON.parse(new TextDecoder().decode(existingBytes));
      
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
      messages,
    };

    const writeData = new TextEncoder().encode(JSON.stringify(data));
    await vscode.workspace.fs.writeFile(filePath, writeData);
  }

  public async getHistoryList(): Promise<ChatSessionPreview[]> {
    await this.initializeDirectory();
    try {
      const files = await vscode.workspace.fs.readDirectory(this.historyDir);
      const previews: ChatSessionPreview[] = [];

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

            previews.push({
              id: data.id,
              title,
              updatedAt: data.updatedAt,
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

  public async getChatSession(sessionId: string): Promise<ChatMessage[] | null> {
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    try {
      const dataBytes = await vscode.workspace.fs.readFile(filePath);
      const dataString = new TextDecoder().decode(dataBytes);
      const data = JSON.parse(dataString);
      return data.messages || [];
    } catch (e) {
      // It's possible the file doesn't exist yet, which is fine
      return null;
    }
  }

  public async deleteChatSession(sessionId: string): Promise<void> {
    await this.initializeDirectory();
    const filePath = vscode.Uri.file(path.join(this.historyDir.fsPath, `${sessionId}.json`));
    
    try {
      await vscode.workspace.fs.delete(filePath, { useTrash: false });
    } catch (e) {
      console.error(`Error deleting chat session ${sessionId}:`, e);
    }
  }
}
