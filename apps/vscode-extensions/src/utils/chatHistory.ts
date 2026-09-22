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
export function formatModelHistory(messages: readonly ModelHistoryMessage[]): string {
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
