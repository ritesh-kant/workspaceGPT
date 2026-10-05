import type { ChatMessage } from '../historyService';

export type ImportSource = 'claude-code' | 'cursor';

/** One conversation from another tool, already reduced to plain turns. */
export interface ImportedChat {
  /** The other tool's own id; the saved session id is derived from it. */
  sourceId: string;
  title?: string;
  updatedAt: number;
  workspaceFolder?: string;
  messages: ChatMessage[];
}

export interface ImportDetection {
  source: ImportSource;
  /** Whether this machine has data for the source at all. */
  available: boolean;
  /** Conversations found; 0 when unavailable. */
  found: number;
  /** Of those, how many are already in history. */
  imported: number;
  /** Why it cannot be read, when it is present but unreadable. */
  error?: string;
}

export interface ImportResult {
  source: ImportSource;
  imported: number;
  skipped: number;
  failed: number;
  error?: string;
}

export function importedSessionId(source: ImportSource, sourceId: string): string {
  return `imported-${source}-${sourceId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
