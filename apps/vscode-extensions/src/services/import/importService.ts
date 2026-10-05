import * as fs from 'fs/promises';
import type { HistoryService } from '../historyService';
import {
  claudeCodeSourceId,
  listClaudeCodeTranscripts,
  parseClaudeCodeSession,
} from './claudeCode';
import { cursorAvailable, listCursorChatIds, readCursorChat } from './cursor';
import { importedSessionId, type ImportDetection, type ImportedChat, type ImportResult, type ImportSource } from './types';

/**
 * Brings chats from other tools into history. Everything is read from this
 * machine and written to this machine; nothing is sent anywhere.
 */
export class ImportService {
  constructor(private readonly history: HistoryService) {}

  public async detect(): Promise<ImportDetection[]> {
    return Promise.all([this.detectClaudeCode(), this.detectCursor()]);
  }

  private async countImported(source: ImportSource, sourceIds: string[]): Promise<number> {
    const flags = await Promise.all(sourceIds.map((id) => this.history.hasSession(importedSessionId(source, id))));
    return flags.filter(Boolean).length;
  }

  private async detectClaudeCode(): Promise<ImportDetection> {
    const ids = (await listClaudeCodeTranscripts()).map(claudeCodeSourceId);
    return {
      source: 'claude-code',
      available: ids.length > 0,
      found: ids.length,
      imported: await this.countImported('claude-code', ids),
    };
  }

  private async detectCursor(): Promise<ImportDetection> {
    if (!(await cursorAvailable())) return { source: 'cursor', available: false, found: 0, imported: 0 };
    try {
      const ids = await listCursorChatIds();
      return { source: 'cursor', available: true, found: ids.length, imported: await this.countImported('cursor', ids) };
    } catch (e) {
      return { source: 'cursor', available: true, found: 0, imported: 0, error: cursorError(e) };
    }
  }

  public async run(source: ImportSource, onProgress?: (done: number, total: number) => void): Promise<ImportResult> {
    const result: ImportResult = { source, imported: 0, skipped: 0, failed: 0 };
    try {
      if (source === 'claude-code') await this.runClaudeCode(result, onProgress);
      else await this.runCursor(result, onProgress);
    } catch (e) {
      result.error = source === 'cursor' ? cursorError(e) : e instanceof Error ? e.message : String(e);
    }
    return result;
  }

  private async save(result: ImportResult, source: ImportSource, chat: ImportedChat | null) {
    if (!chat) {
      result.skipped++;
      return;
    }
    // A folder that no longer exists would file the chat under a project that
    // cannot be opened; without one it lands under Chat instead.
    if (chat.workspaceFolder && !(await exists(chat.workspaceFolder))) chat = { ...chat, workspaceFolder: undefined };
    if (await this.history.importSession(importedSessionId(source, chat.sourceId), chat)) result.imported++;
    else result.skipped++;
  }

  private async runClaudeCode(result: ImportResult, onProgress?: (done: number, total: number) => void) {
    const files = await listClaudeCodeTranscripts();
    for (const [i, file] of files.entries()) {
      try {
        const id = claudeCodeSourceId(file);
        // Already-imported ids are skipped before the file is parsed.
        if (await this.history.hasSession(importedSessionId('claude-code', id))) result.skipped++;
        else await this.save(result, 'claude-code', parseClaudeCodeSession(await fs.readFile(file, 'utf8'), id));
      } catch {
        result.failed++;
      }
      onProgress?.(i + 1, files.length);
    }
  }

  private async runCursor(result: ImportResult, onProgress?: (done: number, total: number) => void) {
    const ids = await listCursorChatIds();
    for (const [i, id] of ids.entries()) {
      try {
        if (await this.history.hasSession(importedSessionId('cursor', id))) result.skipped++;
        else await this.save(result, 'cursor', await readCursorChat(id));
      } catch {
        result.failed++;
      }
      onProgress?.(i + 1, ids.length);
    }
  }
}

async function exists(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

function cursorError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === 'ENOENT') return 'Reading Cursor chats needs a newer Node or the sqlite3 command-line tool on your PATH.';
  return `Could not read Cursor’s chat database: ${err?.message ?? String(e)}`;
}
