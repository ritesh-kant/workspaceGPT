/**
 * Consumes a streamed chat completion for the plain (non-agent) turn path,
 * forwarding visible content to the UI as it arrives and reporting what the
 * stream actually contained once it ends.
 *
 * Pulled out of modelWorker.ts so it can be driven by a fake stream in the
 * headless suite. This function is the only place the streamed path decides
 * what a turn produced, and until 2026-09-05 it had no test at all — which is
 * how a reasoning model could stream 965 characters of `reasoning_content`,
 * zero characters of `content`, and have the turn delivered as an empty answer
 * with nothing in any log to say why.
 */

export interface StreamOutcome {
  /** Visible answer text, `<think>…</think>` blocks removed, trimmed. */
  content: string;
  /**
   * Characters of `reasoning_content`/`reasoning` seen on this stream. A
   * reasoning model can spend an entire turn thinking and emit no visible
   * content at all, which is indistinguishable from a genuinely empty answer
   * unless the thinking is counted.
   */
  reasoningChars: number;
  /** The provider's finish reason; 'length' means the token budget ran out. */
  finishReason: string | null;
}

/** Minimal shape of an OpenAI-style streamed chunk — only what this reads. */
export interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } | null;
    finish_reason?: string | null;
  }>;
}

/**
 * @param emit Receives each piece of visible content in order, exactly as
 *   the UI should show it (thinking already stripped). The worker wires this
 *   to a 'chunk' postMessage; tests capture it.
 */
export async function consumeStream(
  stream: AsyncIterable<StreamChunk>,
  emit: (content: string) => void
): Promise<StreamOutcome> {
  let fullContent = '';
  let thinkingDone = false;
  let isCheckingThink = true;
  let reasoningChars = 0;
  let finishReason: string | null = null;

  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      // Recorded BEFORE the content guard below: a stream can be entirely
      // reasoning deltas, in which case `continue` would skip every chunk and
      // the turn would look empty for no discoverable reason.
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      reasoningChars += String(delta?.reasoning_content ?? delta?.reasoning ?? '').length;

      const contentDelta = delta?.content;
      if (!contentDelta) continue;

      fullContent += contentDelta;

      // Check for <think> tag at the very start
      if (isCheckingThink) {
        if (fullContent.length >= 7) {
          isCheckingThink = false;
          if (!fullContent.startsWith('<think>')) {
            thinkingDone = true;
            // Not a thinking model, send everything we buffered so far
            emit(fullContent);
          }
        }
        continue;
      }

      // Strip <think>...</think> blocks - only send content after thinking is done
      if (!thinkingDone) {
        const thinkEnd = fullContent.indexOf('</think>');
        if (thinkEnd !== -1) {
          thinkingDone = true;
          const afterThink = fullContent.substring(thinkEnd + 8).trim();
          if (afterThink) {
            emit(afterThink);
          }
        }
        continue;
      }

      // Send chunk to UI
      emit(contentDelta);
    }
  } catch (streamError) {
    // Some OpenAI-compatible providers/proxies close the SSE stream without a
    // proper terminator, which the SDK surfaces as "Premature close" even after
    // the full message has already arrived. If we've buffered any content,
    // treat it as a complete response and fall through rather than failing.
    const isPrematureClose =
      streamError instanceof Error && /premature close/i.test(streamError.message);
    if (!isPrematureClose || fullContent.length === 0) {
      throw streamError;
    }
    console.warn(
      '[workspaceGPT] LLM stream closed early after content was received — ' +
        'salvaging buffered response instead of erroring.'
    );
  }

  // Handle case where stream ended before 7 chars
  if (isCheckingThink) {
    emit(fullContent);
  }

  return {
    content: fullContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    reasoningChars,
    finishReason,
  };
}

/**
 * Should a streamed turn that produced no visible content be retried with a
 * larger budget? True when the model was demonstrably still thinking (reasoning
 * deltas seen) or was cut off by the token cap — the two shapes an "empty"
 * answer takes when the model never got to speak. A genuinely empty reply
 * (finish 'stop', no reasoning) is not retried: a second identical request
 * would just cost the same again.
 */
export function shouldRetryEmptyStream(outcome: StreamOutcome): boolean {
  return !outcome.content && (outcome.finishReason === 'length' || outcome.reasoningChars > 0);
}
