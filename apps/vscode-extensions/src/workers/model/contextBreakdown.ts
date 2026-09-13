/**
 * WHERE the context went, not just how much of it is gone.
 *
 * The meter already reports occupancy from the provider's own
 * `usage.prompt_tokens` (see contextBudget.ts). That number answers "how
 * full", but not the question a user actually acts on: *what is filling it*.
 * A run at 80% because tool results are enormous is a different problem from
 * one at 80% because the conversation is long — the first is fixed by
 * narrower reads, the second by starting a fresh chat.
 *
 * ── What is measured, and what is estimated ──
 * The TOTAL is measured: it is the provider's count, passed in here.
 * The SPLIT is estimated: we do not run the provider's tokenizer, so each
 * segment is weighed in characters and then given its share of the measured
 * total. So the segments always add up to the real number, and their
 * proportions are accurate to roughly the degree that characters-per-token is
 * uniform across the payload — which it nearly is, because every segment is
 * the same kind of material (English prose and source code) for the same
 * tokenizer.
 *
 * Images are the one payload that breaks that assumption badly: a data URI is
 * megabytes of base64 that costs a flat, small number of tokens. Weighing one
 * by its characters would attribute essentially the whole window to it. They
 * are therefore weighed at a fixed per-image estimate instead.
 */

/** Rough bytes-per-token for OpenAI-family tokenizers on prose and source. */
const CHARS_PER_TOKEN = 4;

/**
 * Flat token cost assumed per attached image. Real cost is tile-based and
 * model-specific (~1.1k for a typical screenshot on GPT-4o-class vision); the
 * point here is only to keep an image's weight in the same order as its true
 * cost rather than its base64 length.
 */
const IMAGE_TOKENS_EST = 1_100;

export type ContextSegmentKey =
  | 'system'
  | 'tools'
  | 'conversation'
  | 'toolResults'
  | 'attachments';

export interface ContextSegment {
  key: ContextSegmentKey;
  /** Display name — the worker owns the wording so the webview stays dumb. */
  label: string;
  tokens: number;
}

const LABELS: Record<ContextSegmentKey, string> = {
  system: 'System prompt & rules',
  tools: 'Tool definitions',
  conversation: 'Conversation',
  toolResults: 'Tool results',
  attachments: 'Attachments',
};

/** Display order, largest-to-smallest being unhelpful when it reshuffles every turn. */
const ORDER: ContextSegmentKey[] = ['system', 'tools', 'conversation', 'toolResults', 'attachments'];

/**
 * Characters in one message's content, with image parts charged at their
 * estimated token cost rather than their base64 length.
 *
 * Returns the two weights separately: an image rides inside a user message,
 * but attributing it to "Conversation" would hide the single most expensive
 * thing in the window behind a label that reads as chat text.
 */
function weighContent(content: unknown): { textChars: number; imageChars: number } {
  if (typeof content === 'string') return { textChars: content.length, imageChars: 0 };
  if (!Array.isArray(content)) return { textChars: 0, imageChars: 0 };
  let textChars = 0;
  let imageChars = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as any).type;
    if (type === 'image_url') {
      imageChars += IMAGE_TOKENS_EST * CHARS_PER_TOKEN;
    } else if (typeof (part as any).text === 'string') {
      textChars += (part as any).text.length;
    }
  }
  return { textChars, imageChars };
}

/** Serialized size of whatever the message carries besides prose. */
function weighToolCalls(message: any): number {
  if (!Array.isArray(message?.tool_calls) || message.tool_calls.length === 0) return 0;
  try {
    return JSON.stringify(message.tool_calls).length;
  } catch {
    return 0;
  }
}

/**
 * Split a measured prompt-token count across the parts of the prompt.
 *
 * `messages` is the live conversation array and `toolDefs` the tool schemas
 * sent alongside it — together, everything the provider counted.
 */
export function contextBreakdown(input: {
  messages: any[];
  toolDefs: unknown[];
  promptTokens: number;
}): ContextSegment[] {
  const total = Math.max(0, Math.round(input.promptTokens || 0));
  if (total <= 0) return [];

  const chars: Record<ContextSegmentKey, number> = {
    system: 0,
    tools: 0,
    conversation: 0,
    toolResults: 0,
    attachments: 0,
  };

  try {
    chars.tools = JSON.stringify(input.toolDefs ?? []).length;
  } catch {
    chars.tools = 0;
  }

  const messages = Array.isArray(input.messages) ? input.messages : [];
  messages.forEach((message, index) => {
    const { textChars, imageChars } = weighContent(message?.content);
    chars.attachments += imageChars;
    // The first message is not chat: it is the built prompt — rules,
    // orientation, the rules files, the user's actual question. There is no
    // separate system message in this harness (see buildUserContent), so this
    // index IS the system prompt, and on a resumed run the same holds, since
    // the resumed transcript begins with the original first turn.
    if (index === 0) {
      chars.system += textChars;
      return;
    }
    if (message?.role === 'tool') {
      chars.toolResults += textChars;
      return;
    }
    chars.conversation += textChars + weighToolCalls(message);
  });

  const weighed = ORDER.map((key) => ({ key, chars: chars[key] })).filter((s) => s.chars > 0);
  const totalChars = weighed.reduce((sum, s) => sum + s.chars, 0);
  if (totalChars <= 0) return [];

  const segments: ContextSegment[] = weighed.map((s) => ({
    key: s.key,
    label: LABELS[s.key],
    tokens: Math.round((s.chars / totalChars) * total),
  }));

  // Rounding must not make the parts disagree with the measured whole the
  // meter shows beside them — hand the drift to the biggest segment, where it
  // is proportionally smallest.
  const drift = total - segments.reduce((sum, s) => sum + s.tokens, 0);
  if (drift !== 0) {
    let biggest = 0;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].tokens > segments[biggest].tokens) biggest = i;
    }
    segments[biggest].tokens = Math.max(0, segments[biggest].tokens + drift);
  }

  return segments;
}
