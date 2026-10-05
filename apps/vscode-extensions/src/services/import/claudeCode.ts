import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage } from '../historyService';
import type { ImportedChat } from './types';

/**
 * Slash-command echoes, task notifications and injected reminders arrive as
 * "user" text; they are not something the person typed. They are one
 * hyphenated tag wrapped around the whole message (<task-notification>…,
 * <command-name>…), which plain HTML, having no hyphenated tags, never is.
 * This only adds a skip; a message it misses is imported as text, not lost.
 */
const NOT_TYPED = /^<([a-z]+(?:-[a-z]+)+)[\s>][\s\S]*<\/\1>\s*$|^<(command-|local-command|bash-|system-reminder)/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

/**
 * One Claude Code transcript (.jsonl, one event per line) as plain turns.
 *
 * Only what was said is kept: typed prompts and the assistant's text. Tool
 * calls, tool results and thinking are dropped, and the assistant text spread
 * across a tool-using turn is joined into the single answer it was. A line
 * that does not parse is skipped, not fatal — a transcript still being
 * written can end mid-line.
 */
export function parseClaudeCodeSession(jsonl: string, sourceId: string): ImportedChat | null {
  const messages: ChatMessage[] = [];
  let pending: string[] = [];
  let title: string | undefined;
  let cwd: string | undefined;
  let updatedAt = 0;

  const flush = () => {
    const content = pending.join('\n\n').trim();
    pending = [];
    if (content) messages.push({ content, isUser: false });
  };

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'custom-title' && event.customTitle) title = event.customTitle;
    else if (event.type === 'ai-title' && event.aiTitle && !title) title = event.aiTitle;

    if (event.type !== 'user' && event.type !== 'assistant') continue;
    if (event.isSidechain || event.isMeta) continue;
    cwd ??= typeof event.cwd === 'string' ? event.cwd : undefined;
    const at = Date.parse(event.timestamp);
    if (at > updatedAt) updatedAt = at;

    const text = textOf(event.message?.content).trim();
    if (!text) continue;
    if (event.type === 'assistant') {
      pending.push(text);
    } else if (!NOT_TYPED.test(text)) {
      flush();
      messages.push({ content: text, isUser: true });
    }
  }
  flush();

  if (!messages.some((m) => m.isUser)) return null;
  return { sourceId, title, updatedAt: updatedAt || Date.now(), workspaceFolder: cwd, messages };
}

export function claudeCodeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Every top-level transcript. Subagent transcripts live in nested folders and are not conversations of their own. */
export async function listClaudeCodeTranscripts(root = claudeCodeProjectsDir()): Promise<string[]> {
  const files: string[] = [];
  let projects: string[];
  try {
    projects = await fs.readdir(root);
  } catch {
    return files;
  }
  for (const project of projects) {
    try {
      for (const name of await fs.readdir(path.join(root, project))) {
        if (name.endsWith('.jsonl')) files.push(path.join(root, project, name));
      }
    } catch {
      // not a directory
    }
  }
  return files;
}

export function claudeCodeSourceId(file: string): string {
  return path.basename(file, '.jsonl');
}
