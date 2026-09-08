/**
 * Harness control messages that must NOT survive into a resumed run.
 *
 * When the agent loop hits its step cap or tool-output budget it pushes a
 * `user` message that says so and forbids further tool calls, then forces a
 * prose answer. That message is true for the segment it ends — and false for
 * every segment after it, because a resumed run starts with a fresh loop.
 *
 * Observed live on ADO #1534774 (2026-09-05): the first turn ran to the cap and
 * delivered a proposal; the user replied "go ahead"; the resumed transcript
 * still carried "No further tools can run this turn. Answer now" two messages
 * above the new request. The model made one tool call, then — reading that
 * stale instruction as current — wrote "Partially done — step limit reached"
 * and listed the files it would read "when the run resumes". Nothing was
 * edited, with 24 steps of budget unused.
 *
 * The producers in modelWorker.ts build these messages from the prefixes
 * exported here, so the recogniser below cannot drift from what is emitted.
 * Pure — no worker state — so it is pinned by the headless unit tests.
 */

export type LimitKind = 'steps' | 'budget' | 'clock' | 'context';

/**
 * Lead-ins of the "this run is over" messages, one per way the loop can end.
 *
 * There are four, and there used to be two labels for them: the loop also
 * breaks on the wall clock and on a full context window, and both of those
 * fell through to the `steps` wording. Observed on ticket #1384667: a run that
 * ran out of its 30-minute clock told the user "step limit reached" while its
 * own diagnostics footer read `62 turns (cap 200) · tool budget 49% used`.
 * A harness that misreports why it stopped sends the user looking for the
 * wrong fix — and, because this same text is what the model is told, it
 * launders the wrong reason into the user-facing report.
 */
export const HARNESS_LIMIT_PREFIX: Record<LimitKind, string> = {
  steps: 'The step limit for this run is reached',
  budget: 'The tool-OUTPUT budget for this run is exhausted',
  clock: 'The wall-clock limit for this run is reached',
  context: 'The context window for this run is full',
};

/** How each ending must be NAMED in the answer, when the task is unfinished. */
export const HARNESS_LIMIT_PHRASE: Record<LimitKind, string> = {
  steps: 'step limit reached',
  budget: 'tool-output budget exhausted',
  clock: 'time limit reached',
  context: 'context window full',
};

/** The same endings in the words the resume prompt uses ("it hit the harness's ..."). */
export const HARNESS_LIMIT_NOUN: Record<LimitKind, string> = {
  steps: 'step limit',
  budget: 'tool-output budget',
  clock: 'wall-clock limit',
  context: 'context window',
};

/** Lead-in of the retry nudge sent when the forced final answer came back empty. */
export const HARNESS_PROSE_RETRY_PREFIX = 'Answer now, in plain prose, using the';

/** Lead-in of the mid-run "N tool turn(s) left" commit nudge — a fact about the old segment's budget. */
export const HARNESS_CHECKPOINT_PREFIX = 'Checkpoint from the harness:';

/** The assistant placeholder pushed before the retry nudge, so the transcript alternates. */
export const EMPTY_RESPONSE_PLACEHOLDER = '(empty response)';

interface MessageLike {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
}

/** The text of a message's content — a string, or the first text part of a parts array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const part = content.find((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text');
    const text = (part as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

/** Which limit a harness message announces, or null if it is not one. */
export function limitKindOf(message: MessageLike): LimitKind | null {
  if (message.role !== 'user') return null;
  const text = textOf(message.content);
  for (const kind of Object.keys(HARNESS_LIMIT_PREFIX) as LimitKind[]) {
    if (text.startsWith(HARNESS_LIMIT_PREFIX[kind])) return kind;
  }
  return null;
}

/**
 * True for a message that describes the PREVIOUS segment's budget and would
 * mislead the next one: the limit announcements, the empty-answer retry, the
 * turns-left checkpoint, and the placeholder that pairs with the retry.
 */
export function isStaleHarnessMessage(message: MessageLike): boolean {
  if (message.role === 'assistant') {
    const calls = message.tool_calls;
    const hasCalls = Array.isArray(calls) && calls.length > 0;
    return !hasCalls && textOf(message.content) === EMPTY_RESPONSE_PLACEHOLDER;
  }
  if (message.role !== 'user') return false;
  if (limitKindOf(message)) return true;
  const text = textOf(message.content);
  return text.startsWith(HARNESS_PROSE_RETRY_PREFIX) || text.startsWith(HARNESS_CHECKPOINT_PREFIX);
}

export interface PruneResult<T> {
  messages: T[];
  /** How many messages were dropped. */
  removed: number;
  /** The limit that ended the previous segment, if one did. */
  endedAtLimit: LimitKind | null;
}

/**
 * Drop the stale harness messages from a transcript about to be resumed. The
 * model's own answers stay — including a "Partially done" report, which the
 * user has seen and which the continuation prompt addresses directly.
 */
export function pruneStaleHarnessMessages<T extends MessageLike>(messages: readonly T[]): PruneResult<T> {
  const kept: T[] = [];
  let removed = 0;
  let endedAtLimit: LimitKind | null = null;
  for (const message of messages) {
    const kind = limitKindOf(message);
    if (kind) endedAtLimit = kind;
    if (isStaleHarnessMessage(message)) {
      removed++;
      continue;
    }
    kept.push(message);
  }
  return { messages: kept, removed, endedAtLimit };
}
