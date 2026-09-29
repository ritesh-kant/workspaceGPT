/**
 * One assistant turn, read from EVERY choice of a non-streaming completion.
 *
 * We never ask for alternates (no `n`), so a response with several choices is
 * one reply split into parts, not a menu to pick from. GitHub Copilot's API
 * does this for Claude models: the prose goes in one choice and the tool calls
 * in others. Reading `choices[0]` alone kept whichever part came first.
 *
 * Observed on spike #1537001 (desktop, Copilot direct, claude-sonnet-5): the
 * saved transcript had 27 tool turns with no prose and exactly one call each,
 * and the run twice ended on "Let's check the RetailCheckout mapper further…".
 * That is a lead-in whose tool call was in a later choice. It only happened on
 * the turns where the model wrote a sentence first, which is why it was
 * intermittent. The VS Code path (copilotBridge.ts) builds a single choice
 * itself, so only the desktop's pass-through ever saw the split.
 */

export interface MergedChoice {
  /** The message's text, joined across choices in order. */
  content: string;
  /** Tool calls from all choices in order; an id repeated across choices is kept once. */
  toolCalls: any[];
  /** A choice that carries tool calls decides this, so a text part's 'stop' can't hide them. */
  finishReason: string | null;
  reasoningContent: string;
  /** How many choices the response had, and which of them carried text or tool calls. */
  choiceCount: number;
  contentChoices: number[];
  toolCallChoices: number[];
}

export function mergeChoices(choices: any[] | undefined | null): MergedChoice {
  const list = Array.isArray(choices) ? choices : [];
  const texts: string[] = [];
  const toolCalls: any[] = [];
  const seenIds = new Set<string>();
  const contentChoices: number[] = [];
  const toolCallChoices: number[] = [];
  let reasoningContent = '';
  let toolFinish: string | null = null;

  list.forEach((choice, idx) => {
    const message = choice?.message;
    const text = typeof message?.content === 'string' ? message.content : '';
    if (text.trim()) {
      texts.push(text);
      contentChoices.push(idx);
    }
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (calls.length) {
      toolCallChoices.push(idx);
      if (toolFinish === null) toolFinish = choice?.finish_reason ?? null;
    }
    for (const tc of calls) {
      if (tc?.id && seenIds.has(tc.id)) continue;
      if (tc?.id) seenIds.add(tc.id);
      toolCalls.push(tc);
    }
    if (!reasoningContent) reasoningContent = message?.reasoning_content ?? message?.reasoning ?? '';
  });

  return {
    content: texts.join('\n\n'),
    toolCalls,
    finishReason: toolFinish ?? list[0]?.finish_reason ?? null,
    reasoningContent,
    choiceCount: list.length,
    contentChoices,
    toolCallChoices,
  };
}
