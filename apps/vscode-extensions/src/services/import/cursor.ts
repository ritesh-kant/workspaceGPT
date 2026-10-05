import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../historyService';
import type { ImportedChat } from './types';

interface Composer {
  id: string;
  name: string | null;
  createdAt: number | null;
  lastUpdatedAt: number | null;
  /** JSON text: [{bubbleId, type}] in conversation order. */
  headers: string;
}

interface Bubble {
  bid: string;
  text: string | null;
}

export function cursorDbPath(): string {
  const home = os.homedir();
  const sub = path.join('Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', sub);
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), sub);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), sub);
}

/**
 * One Cursor chat as plain turns. Header type 1 is the person, 2 the model;
 * the model's tool-call bubbles carry no text and drop out, and consecutive
 * text bubbles from one turn are joined.
 */
export function buildCursorChat(composer: Composer, bubbles: Bubble[]): ImportedChat | null {
  let order: Array<{ bubbleId: string; type: number }>;
  try {
    order = JSON.parse(composer.headers);
  } catch {
    return null;
  }
  const byId = new Map(bubbles.map((b) => [b.bid, (b.text ?? '').trim()]));
  const messages: ChatMessage[] = [];
  let pending: string[] = [];
  const flush = () => {
    const content = pending.join('\n\n').trim();
    pending = [];
    if (content) messages.push({ content, isUser: false });
  };
  for (const { bubbleId, type } of order) {
    const text = byId.get(bubbleId);
    if (!text) continue;
    if (type === 1) {
      flush();
      messages.push({ content: text, isUser: true });
    } else if (type === 2) {
      pending.push(text);
    }
  }
  flush();
  if (!messages.some((m) => m.isUser)) return null;
  return {
    sourceId: composer.id,
    title: composer.name?.trim() || undefined,
    updatedAt: composer.lastUpdatedAt ?? composer.createdAt ?? Date.now(),
    messages,
  };
}

/**
 * Node's built-in SQLite (22.5+; the desktop app bundles 24) needs nothing
 * installed on any OS. Older hosts, such as a VS Code build on Node 18, fall
 * back to the sqlite3 command-line tool.
 */
async function sqlite(db: string, sql: string): Promise<any[]> {
  let DatabaseSync: (new (file: string, options: { readOnly: boolean }) => any) | undefined;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    // not available on this Node
  }
  if (DatabaseSync) {
    const handle = new DatabaseSync(db, { readOnly: true });
    try {
      return handle.prepare(sql).all().map((row: object) => ({ ...row }));
    } finally {
      handle.close();
    }
  }
  return sqliteCli(db, sql);
}

function sqliteCli(db: string, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', db, sql],
      { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : []);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

/** Cursor's database holds ids as uuids; anything else is not ours to put in a query. */
const SAFE_ID = /^[A-Za-z0-9-]+$/;

export async function cursorAvailable(db = cursorDbPath()): Promise<boolean> {
  try {
    await fs.access(db);
    return true;
  } catch {
    return false;
  }
}

/** Ids of the chats with at least one message, without loading any of them. */
export async function listCursorChatIds(db = cursorDbPath()): Promise<string[]> {
  const rows = await sqlite(
    db,
    `select substr(key, 14) as id from cursorDiskKV
     where key like 'composerData:%'
       and json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) > 0`
  );
  return rows.map((r) => r.id).filter((id) => SAFE_ID.test(id));
}

export async function readCursorChat(id: string, db = cursorDbPath()): Promise<ImportedChat | null> {
  if (!SAFE_ID.test(id)) return null;
  const [composer] = await sqlite(
    db,
    `select '${id}' as id,
            json_extract(value, '$.name') as name,
            json_extract(value, '$.createdAt') as createdAt,
            json_extract(value, '$.lastUpdatedAt') as lastUpdatedAt,
            json_extract(value, '$.fullConversationHeadersOnly') as headers
     from cursorDiskKV where key = 'composerData:${id}'`
  );
  if (!composer) return null;
  const bubbles = await sqlite(
    db,
    `select substr(key, ${'bubbleId:'.length + id.length + 2}) as bid, json_extract(value, '$.text') as text
     from cursorDiskKV where key like 'bubbleId:${id}:%'`
  );
  return buildCursorChat(composer, bubbles);
}
