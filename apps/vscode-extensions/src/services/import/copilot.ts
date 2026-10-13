import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { ChatMessage } from '../historyService';
import type { ImportedChat } from './types';

/** Items in a response that sit inside a run of prose without ending it. */
const QUIET_KINDS = new Set(['thinking', 'codeblockUri', 'undoStop', 'prepareToolInvocation', 'mcpServersStarting']);

export interface CopilotSessionFile {
  file: string;
  sourceId: string;
  format: 'json' | 'jsonl';
  size: number;
  mtimeMs: number;
  workspaceFolder?: string;
}

/**
 * Copilot Chat keeps each chat as a .json snapshot, or as a .jsonl log: a
 * first line {kind:0, v: snapshot}, then {kind:1, k: path, v} to set a value
 * and {kind:2, k: path, v: items, i?} to append items (cut back to length i
 * first, when i is given). Replaying the log gives the same object the
 * snapshot holds.
 */
function replayLog(jsonl: string): any {
  let state: any;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    if (!state || !Array.isArray(entry.k) || !entry.k.length) continue;
    let parent = state;
    for (const key of entry.k.slice(0, -1)) parent = parent?.[key];
    if (parent == null || typeof parent !== 'object') continue;
    const last = entry.k[entry.k.length - 1];
    if (entry.kind === 1) {
      parent[last] = entry.v;
    } else if (entry.kind === 2 && Array.isArray(entry.v)) {
      if (!Array.isArray(parent[last])) parent[last] = [];
      if (typeof entry.i === 'number') parent[last].length = Math.min(entry.i, parent[last].length);
      for (const item of entry.v) parent[last].push(item);
    }
  }
  return state;
}

function inlineName(item: any): string {
  const ref = item.inlineReference;
  const name = item.name ?? path.basename(ref?.fsPath ?? ref?.path ?? '');
  return typeof name === 'string' ? name : '';
}

/**
 * What Copilot said for one request. Its text arrives in fragments that
 * continue each other, with file links in between, so they are joined as they
 * are; a tool call or edit ends the run, and the runs are the paragraphs.
 */
function responseText(items: unknown): string {
  const runs: string[] = [];
  let run = '';
  const end = () => {
    if (run.trim()) runs.push(run.trim());
    run = '';
  };
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind === undefined && typeof item?.value === 'string') run += item.value;
    else if (item?.kind === 'inlineReference') run += inlineName(item) ? `\`${inlineName(item)}\`` : '';
    else if (!QUIET_KINDS.has(item?.kind)) end();
  }
  end();
  return runs.join('\n\n');
}

/**
 * One Copilot chat as plain turns: what was typed and the prose Copilot
 * answered with. Tool calls, edits and thinking are dropped.
 */
export function parseCopilotSession(raw: string, format: 'json' | 'jsonl', sourceId: string, fallbackAt = Date.now()): ImportedChat | null {
  const session = format === 'jsonl' ? replayLog(raw) : JSON.parse(raw);
  const requests: any[] = Array.isArray(session?.requests) ? session.requests : [];
  const messages: ChatMessage[] = [];
  let updatedAt = Math.max(session?.lastMessageDate ?? 0, session?.creationDate ?? 0);
  for (const request of requests) {
    if (typeof request?.timestamp === 'number') updatedAt = Math.max(updatedAt, request.timestamp);
    const asked = typeof request?.message?.text === 'string' ? request.message.text.trim() : '';
    if (asked) messages.push({ content: asked, isUser: true });
    const answered = responseText(request?.response);
    if (answered) messages.push({ content: answered, isUser: false });
  }
  if (!messages.some((m) => m.isUser)) return null;
  const title = typeof session.customTitle === 'string' ? session.customTitle.trim() : '';
  return { sourceId, title: title || undefined, updatedAt: updatedAt || fallbackAt, messages };
}

/** The user-data folder of each VS Code build that can hold Copilot chats. */
export function copilotUserDirs(): string[] {
  const home = os.homedir();
  const apps = ['Code', 'Code - Insiders', 'VSCodium'];
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return apps.map((app) => path.join(base, app, 'User'));
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/** The folder a workspace-storage entry belongs to, when it is a local one. */
async function folderOf(storage: string): Promise<string | undefined> {
  try {
    const { folder } = JSON.parse(await fs.readFile(path.join(storage, 'workspace.json'), 'utf8'));
    return typeof folder === 'string' && folder.startsWith('file:') ? fileURLToPath(folder) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every Copilot chat file, one per chat. A chat can be on disk as both a
 * .json and a .jsonl; the newer one is kept.
 */
export async function listCopilotSessions(userDirs = copilotUserDirs()): Promise<CopilotSessionFile[]> {
  const byId = new Map<string, CopilotSessionFile>();
  const collect = async (dir: string, workspaceFolder?: string) => {
    for (const name of await readDir(dir)) {
      const format = name.endsWith('.jsonl') ? 'jsonl' : name.endsWith('.json') ? 'json' : null;
      if (!format) continue;
      const file = path.join(dir, name);
      try {
        const { size, mtimeMs } = await fs.stat(file);
        const sourceId = path.basename(name, `.${format}`);
        const known = byId.get(sourceId);
        if (!known || mtimeMs > known.mtimeMs) byId.set(sourceId, { file, sourceId, format, size, mtimeMs, workspaceFolder });
      } catch {
        // gone since it was listed
      }
    }
  };
  for (const user of userDirs) {
    const workspaces = path.join(user, 'workspaceStorage');
    for (const hash of await readDir(workspaces)) {
      await collect(path.join(workspaces, hash, 'chatSessions'), await folderOf(path.join(workspaces, hash)));
    }
    await collect(path.join(user, 'globalStorage', 'emptyWindowChatSessions'));
  }
  return [...byId.values()];
}

/**
 * Whether a file holds a conversation. Empty panels and inline edits with no
 * prompt are on disk too; they are not chats.
 */
export async function copilotHasChat(entry: CopilotSessionFile): Promise<boolean> {
  try {
    return parseCopilotSession(await fs.readFile(entry.file, 'utf8'), entry.format, entry.sourceId) !== null;
  } catch {
    return false;
  }
}

export async function readCopilotChat(entry: CopilotSessionFile): Promise<ImportedChat | null> {
  const chat = parseCopilotSession(await fs.readFile(entry.file, 'utf8'), entry.format, entry.sourceId, entry.mtimeMs);
  return chat && { ...chat, workspaceFolder: entry.workspaceFolder };
}
