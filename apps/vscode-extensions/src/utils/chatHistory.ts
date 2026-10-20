import { createHash } from 'crypto';

export interface ModelHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const MODEL_HISTORY_MAX_CHARS = 48_000;
export const MODEL_HISTORY_MIN_RECENT_MESSAGES = 6;

const historyLine = (message: ModelHistoryMessage): string =>
  `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`;

/**
 * Keeps a generous tail of complete turns for inference without changing the
 * persisted conversation. Older rendered replies can grow indefinitely and
 * otherwise become prompt payload on every later request.
 */
export function formatModelHistory(
  messages: readonly ModelHistoryMessage[],
  /** A summary of the first `covers` messages (see planHistoryCompaction); they are replaced by it. */
  summary?: { text: string; covers: number }
): string {
  if (summary?.text?.trim()) {
    const rest = messages.slice(summary.covers);
    const head = `${CHAT_SUMMARY_HEADER}\n\n${summary.text.trim()}`;
    return rest.length ? `${head}\n\n${formatModelHistory(rest)}` : head;
  }
  if (!messages.length) return 'No prior conversation.';

  const kept: string[] = [];
  let chars = 0;
  let omitted = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const line = historyLine(messages[index]);
    const keepForContinuity = kept.length < MODEL_HISTORY_MIN_RECENT_MESSAGES;
    if (!keepForContinuity && chars + line.length > MODEL_HISTORY_MAX_CHARS) {
      omitted = index + 1;
      break;
    }
    kept.push(line);
    chars += line.length;
  }

  kept.reverse();
  const compacted = omitted
    ? `[Earlier conversation omitted for prompt efficiency; use the retained recent turns and ask for details if needed.]\n\n`
    : '';
  return compacted + kept.join('\n\n');
}

/** Header the summary of older turns is shown under in the prompt's conversation history. */
export const CHAT_SUMMARY_HEADER =
  '[Earlier conversation, compacted: another model summarized it. The retained recent turns follow.]';

/**
 * After summarizing, this much recent history stays verbatim: half the cap, so
 * the next several turns fit beside the summary before another one is needed.
 */
export const HISTORY_SUMMARY_TAIL_CHARS = Math.floor(MODEL_HISTORY_MAX_CHARS / 2);

/** A chat's summary of its older turns, as the host keeps it between turns. */
export interface HistorySummary {
  text: string;
  /** How many leading messages it replaces. */
  covers: number;
  /** Fingerprint of those messages: an edited or reloaded history invalidates the summary. */
  coveredKey: string;
}

export function historyKey(messages: readonly ModelHistoryMessage[]): string {
  const hash = createHash('sha256');
  for (const m of messages) hash.update(`${m.role}\u0000${m.content}\u0001`);
  return hash.digest('hex').slice(0, 32);
}

/** The summary, if it still describes the start of this history. */
export function validHistorySummary(
  messages: readonly ModelHistoryMessage[],
  summary: HistorySummary | undefined | null
): HistorySummary | undefined {
  if (!summary?.text || summary.covers <= 0 || summary.covers > messages.length) return undefined;
  return historyKey(messages.slice(0, summary.covers)) === summary.coveredKey ? summary : undefined;
}

export interface HistoryCompactionPlan {
  previousSummary?: string;
  /** The messages the new summary must add to the previous one. */
  toSummarize: ModelHistoryMessage[];
  covers: number;
  coveredKey: string;
}

/**
 * Whether this turn should summarize older history instead of omitting it.
 * Null while what is not yet summarized still fits the trim cap: then
 * formatModelHistory with the valid summary (or none) is the whole story.
 */
export function planHistoryCompaction(
  messages: readonly ModelHistoryMessage[],
  existing?: HistorySummary | null
): HistoryCompactionPlan | null {
  const valid = validHistorySummary(messages, existing);
  const base = valid?.covers ?? 0;
  let unsummarized = 0;
  for (let i = base; i < messages.length; i++) unsummarized += historyLine(messages[i]).length;
  if (unsummarized <= MODEL_HISTORY_MAX_CHARS) return null;

  let kept = 0;
  let chars = 0;
  for (let i = messages.length - 1; i >= base; i--) {
    const line = historyLine(messages[i]).length;
    if (kept >= MODEL_HISTORY_MIN_RECENT_MESSAGES && chars + line > HISTORY_SUMMARY_TAIL_CHARS) break;
    kept++;
    chars += line;
  }
  const covers = messages.length - kept;
  if (covers <= base) return null;
  return {
    previousSummary: valid?.text,
    toSummarize: messages.slice(base, covers),
    covers,
    coveredKey: historyKey(messages.slice(0, covers)),
  };
}

/**
 * The text a summary call is given: the previous summary, then the turns it
 * must add, newest kept when they exceed `maxChars`.
 */
export function historyCompactionInput(plan: Pick<HistoryCompactionPlan, 'previousSummary' | 'toSummarize'>, maxChars: number): string {
  const lines = plan.toSummarize.map(historyLine);
  let body = lines.join('\n\n');
  if (body.length > maxChars) body = '[older part omitted]\n' + body.slice(body.length - maxChars);
  return plan.previousSummary ? `Summary of the conversation before these turns:\n${plan.previousSummary}\n\nThe turns that followed:\n${body}` : body;
}
