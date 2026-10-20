/**
 * Summarize-and-continue compaction: what lets a run (or a chat) go on past a
 * full context instead of ending there.
 *
 * Modelled on the two reference tools:
 *  - Codex writes a "context checkpoint" handoff summary at the token limit and
 *    keeps up to ~20k tokens of recent messages beside it.
 *  - Claude Code clears old tool output first, then summarizes, then re-reads
 *    the rules and memory files from disk.
 *
 * Here: the loop's existing microcompaction (compactOldToolResults) stays the
 * fallback, the summary is one tool-less call with the run's own model and
 * provider, and the first message (harness instructions, the request, the
 * run-start rules and memory) is kept byte-identical so the provider's prefix
 * cache still serves it. Rules and memory that changed since the run started
 * are re-injected beside the summary.
 *
 * Pure: no I/O, no worker state. The loop owns when; this owns what.
 */

/** Recognisable by the mock model (and in logs) as the compaction request, not a forced answer. */
export const COMPACTION_REQUEST_MARKER = 'CONTEXT CHECKPOINT';

/** Output budget for the summary call — also the room the request must leave in the window. */
export const COMPACT_SUMMARY_MAX_TOKENS = 8192;

/** How much of the most recent conversation survives verbatim (Codex keeps ~20k tokens). */
export const RECENT_TAIL_TOKENS = 20_000;

/** A run summarizes at most this many times; past it, the truncating fallback is all there is. */
export const MAX_RUN_COMPACTIONS = 3;

/**
 * Turns that must pass before another summary. The context reading right after
 * a compaction is an estimate until the next completion reports real usage, and
 * a summary that did not bring the run below the threshold will not do better
 * by being summarized again.
 */
export const MIN_TURNS_BETWEEN_COMPACTIONS = 2;

/** Anything shorter is not a handoff a model could continue from. */
export const MIN_SUMMARY_CHARS = 200;

/** Rough, provider-neutral: the same 4-chars-per-token the meter's breakdown uses. */
export const CHARS_PER_TOKEN = 4;

/**
 * Prefix for the summary message, after Codex's: the model reading it must know
 * the work is real but its evidence is gone.
 */
export const SUMMARY_PREFIX =
  'Another model started this task and its context filled up, so the conversation was compacted. ' +
  'Here is its handoff summary of the work so far. Build on it and do not redo what it records as done. ' +
  'The tool results it saw are no longer in this conversation: re-read a file before editing it unless its exact text is quoted below.';

/** The one instruction the summary call is given, appended after the whole conversation. */
export const COMPACTION_REQUEST = [
  `${COMPACTION_REQUEST_MARKER}: your context window is nearly full, so this conversation is being compacted.`,
  'Write a handoff summary for another model that will continue this task with only the first message, your summary and the most recent turns.',
  'Do not call tools. Do not continue the task. Do not address the user. Use exactly these sections:',
  '1. **User requests and intent**: every request the user made and what they want, in their words where wording matters.',
  '2. **Key decisions**: what was decided and why.',
  '3. **Files touched**: each path read or changed, what was learned or changed there, with the key code snippets (exact text, with line numbers) needed to continue.',
  '4. **Errors and fixes**: errors hit, and how each was fixed or why it is still open.',
  '5. **Knowledge references**: every Confluence page, Jira or Azure DevOps item and pull request this run used, with its id exactly as a tool returned it. Never reformat or guess an id.',
  '6. **Pending tasks and current step**: what is still to do, what was being done right now, and the next step.',
].join('\n');

/** Instruction for summarizing the older part of a chat (no tool trace, just turns). */
export const CHAT_HISTORY_COMPACTION_REQUEST = [
  `${COMPACTION_REQUEST_MARKER}: the earlier part of this chat no longer fits, so it is being compacted.`,
  'Summarize the conversation above for a model that will continue it without seeing those messages.',
  'Keep: what the user asked and wants, decisions and conclusions reached, file paths and code that mattered, errors and fixes, ids of Confluence pages, Jira or Azure DevOps items and pull requests exactly as written, and anything left open.',
  'Do not answer anything and do not address the user. Plain markdown, at most about 600 words.',
].join('\n');

/** Model-facing message, as the loop holds it. */
type Msg = { role: string; content?: unknown; tool_calls?: { function?: { name?: string; arguments?: string } }[] };

export function messageChars(m: Msg): number {
  const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
  return c.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

export function estimateTokens(messages: readonly Msg[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Whether a summary should be attempted now. `usedTokens + COMPACT_SUMMARY_MAX_TOKENS`
 * must fit: the summary request is the whole conversation plus its own output,
 * and one the provider would reject is a wasted round trip.
 */
export function canSummarize(input: {
  usedTokens: number;
  windowTokens: number;
  compactionsDone: number;
  turnsSinceLastCompaction: number;
}): boolean {
  if (input.compactionsDone >= MAX_RUN_COMPACTIONS) return false;
  if (input.compactionsDone > 0 && input.turnsSinceLastCompaction < MIN_TURNS_BETWEEN_COMPACTIONS) return false;
  return input.usedTokens + COMPACT_SUMMARY_MAX_TOKENS <= input.windowTokens;
}

/**
 * Where the verbatim tail starts: the earliest assistant message at or after
 * `from` such that everything from it to the end fits in `budgetChars`.
 * Assistant boundaries only, so a tool result is never separated from the call
 * that asked for it. `messages.length` when not even the last round fits.
 */
export function recentTailStart(messages: readonly Msg[], from: number, budgetChars: number): number {
  let start = messages.length;
  let chars = 0;
  for (let i = messages.length - 1; i >= from; i--) {
    chars += messageChars(messages[i]);
    if (chars > budgetChars) break;
    if (messages[i].role === 'assistant') start = i;
  }
  return start;
}

/** Tools whose call arguments name a Knowledge record, and the argument that does. */
const KNOWLEDGE_ID_ARGS: Record<string, string[]> = {
  get_ticket: ['id'],
  get_confluence_page: ['pageId'],
  update_confluence_page: ['pageId'],
  get_pr: ['id', 'number'],
  get_repo_issue: ['id', 'number'],
};

/**
 * The Knowledge ids this run opened, read from its own tool calls — the record,
 * not the summary's recollection of it. Appended to the summary so an id
 * survives compaction exactly as it was used.
 */
export function knowledgeRefsFromToolCalls(messages: readonly Msg[]): string[] {
  const refs = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const call of m.tool_calls) {
      const name = call.function?.name ?? '';
      const keys = KNOWLEDGE_ID_ARGS[name];
      if (!keys) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        continue;
      }
      for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' || typeof value === 'number') {
          if (String(value).trim()) refs.add(`${name} ${String(value).trim()}`);
          break;
        }
      }
    }
  }
  return [...refs];
}

/** The parts of the prompt the host can re-read: rules files and both memories. */
export interface PromptContextBlocks {
  workspaceRules?: string;
  userMemory?: string;
  projectMemory?: string;
}

/**
 * Re-injection after compaction. The first message is kept and already holds
 * the run-start copies, so only what changed since is repeated — labelled as
 * superseding the copy above, the way Claude Code re-reads its files after a
 * compact.
 */
export function changedContextBlock(snapshot: PromptContextBlocks, current: PromptContextBlocks | null): string {
  if (!current) return '';
  const parts: string[] = [];
  const changed = (a?: string, b?: string) => (a ?? '').trim() !== (b ?? '').trim();
  if (changed(snapshot.workspaceRules, current.workspaceRules)) {
    parts.push(`**Project rules (current):**\n${current.workspaceRules?.trim() || '(none)'}`);
  }
  if (changed(snapshot.userMemory, current.userMemory)) {
    parts.push(current.userMemory?.trim() || '**User memory (current):** (empty)');
  }
  if (changed(snapshot.projectMemory, current.projectMemory)) {
    parts.push(current.projectMemory?.trim() || '**Project memory (current):** (empty)');
  }
  if (!parts.length) return '';
  return `These changed since this run started and supersede the copies in the first message:\n\n${parts.join('\n\n')}`;
}

/** The single user message that replaces everything between the kept head and the tail. */
export function buildSummaryMessage(summary: string, refs: readonly string[], contextBlock: string): string {
  const sections = [`${SUMMARY_PREFIX}\n\n${summary.trim()}`];
  if (refs.length) {
    sections.push(`Knowledge this run opened, ids exactly as its tool calls used them:\n${refs.map((r) => `- ${r}`).join('\n')}`);
  }
  if (contextBlock) sections.push(contextBlock);
  return sections.join('\n\n');
}

/** A summary the call returned that is not one: empty, too short, or the model carrying on instead. */
export function isUsableSummary(text: string | null | undefined): boolean {
  return String(text ?? '').trim().length >= MIN_SUMMARY_CHARS;
}
