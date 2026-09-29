import { contextBreakdown } from './contextBreakdown';

/**
 * Per-call prompt-token accounting, for measuring where a run's prompt tokens
 * go. Off unless WGPT_DEBUG_PROMPT_TOKENS is set in the host's environment
 * (worker threads inherit it), so production runs log nothing.
 *
 * One `[wgpt-prompt-tokens]` JSON line per completion: the provider's measured
 * prompt/cached/completion tokens, plus that total split across system prompt,
 * tool schemas, conversation and tool results. The split is estimated from
 * character shares (see contextBreakdown.ts); the total is the provider's.
 * Logs sizes only, never content.
 */
export const PROMPT_TOKEN_DEBUG = !!process.env.WGPT_DEBUG_PROMPT_TOKENS;

export function logPromptCall(
  label: string,
  messages: unknown[],
  tools: unknown[] | undefined,
  rawUsage: any
): void {
  if (!PROMPT_TOKEN_DEBUG) return;
  try {
    const promptTokens = Number(rawUsage?.prompt_tokens ?? 0);
    const cachedTokens = Number(rawUsage?.prompt_tokens_details?.cached_tokens ?? rawUsage?.cached_tokens ?? 0);
    const segments = contextBreakdown({ messages: messages as any[], toolDefs: tools ?? [], promptTokens });
    const toolChars = tools?.length ? JSON.stringify(tools).length : 0;
    console.log(
      '[wgpt-prompt-tokens] ' +
        JSON.stringify({
          label,
          promptTokens,
          cachedTokens,
          completionTokens: Number(rawUsage?.completion_tokens ?? 0),
          messages: messages.length,
          tools: tools?.length ?? 0,
          toolChars,
          segments: Object.fromEntries(segments.map((s) => [s.key, s.tokens])),
        })
    );
  } catch {
    /* diagnostics must never break a run */
  }
}
