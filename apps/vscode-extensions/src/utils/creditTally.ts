/**
 * What a turn cost in remote-mode credits, added up call by call from what the
 * server says it charged.
 *
 * Why this exists: the per-message footer used to be computed from the turn's
 * raw prompt + completion tokens over `tokens_per_credit`. The Worker never
 * charged that. It rebates cache-hit prompt tokens to a fifth
 * (CACHED_TOKEN_WEIGHT in apps/workspacegpt-api/src/metering.ts), and an agent
 * run resends its whole transcript every round, so most of its prompt is a
 * cache hit. On 2026-09-26 a nine-round agent run showed "80 credits"; its
 * rounds re-sent 7-10k tokens each, most of them already cached. The footer
 * was a second meter that disagreed with the real one.
 *
 * Now the Worker reports each non-streamed call's charge in a response header
 * (CREDITS_CHARGED_HEADER), and this adds those up. A call without the header
 * (a streamed call, whose headers go out before its tokens exist, or a server
 * that predates the header) is counted with the server's own formula on the
 * usage the vendor returned: the same cache rebate, and fractional credits
 * summed rather than each call rounded up. Those tokens are kept apart from
 * the reported charges because turning them into credits needs
 * `tokens_per_credit`, which only the webview knows (from `/v1/me`).
 */

/** Response header the Worker sets on a non-streamed call: credits charged, six decimals. */
export const CREDITS_CHARGED_HEADER = 'x-workspacegpt-credits-charged';

/** Mirrors CACHED_TOKEN_WEIGHT in apps/workspacegpt-api/src/metering.ts. */
export const CACHED_TOKEN_WEIGHT = 0.2;

/** Micro-credits per credit, so reported charges add up as integers. */
export const CREDIT_MICROS = 1_000_000;

export interface CreditTally {
  /** Micro-credits the server reported charging, summed over calls that carried the header. */
  chargedMicros: number;
  /** Cache-rebated tokens of calls that carried no charge header, for the webview to convert. */
  unmeteredTokens: number;
}

export function emptyCreditTally(): CreditTally {
  return { chargedMicros: 0, unmeteredTokens: 0 };
}

/** Add `add` into `into`. Tolerates a partial or malformed tally from a message. */
export function addCreditTally(into: CreditTally, add: Partial<CreditTally> | null | undefined): CreditTally {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  into.chargedMicros += n(add?.chargedMicros);
  into.unmeteredTokens += n(add?.unmeteredTokens);
  return into;
}

/** The header's credits as integer micro-credits, or null when absent or unreadable. */
export function parseCreditsCharged(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const credits = Number(value);
  return Number.isFinite(credits) && credits >= 0 ? Math.round(credits * CREDIT_MICROS) : null;
}

/**
 * The tokens the server charges for, from an OpenAI-shaped `usage` object:
 * the vendor's total less the rebate on its cache-hit share. Same reading as
 * `usageFromObject` + `billableTokens` in the Worker's metering.ts. The cached
 * count comes from `prompt_tokens_details.cached_tokens` (OpenRouter's field)
 * or a bare `cached_tokens`, and is clamped to the prompt.
 */
export function billableTokensFromUsage(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
  const prompt = n(o.prompt_tokens) ?? 0;
  const completion = n(o.completion_tokens) ?? 0;
  const total = n(o.total_tokens) ?? prompt + completion;
  const details = o.prompt_tokens_details;
  const cachedFromDetails =
    details && typeof details === 'object' ? n((details as Record<string, unknown>).cached_tokens) : null;
  const cached = Math.min(cachedFromDetails ?? n(o.cached_tokens) ?? 0, prompt, total);
  return Math.max(0, Math.round(total - cached * (1 - CACHED_TOKEN_WEIGHT)));
}

/**
 * One call's contribution: the server's reported charge when the response
 * carried it, otherwise its usage counted with the server's formula.
 */
export function creditTallyForCall(
  usage: unknown,
  headers?: { get(name: string): string | null } | null
): CreditTally {
  const charged = parseCreditsCharged(headers?.get(CREDITS_CHARGED_HEADER));
  if (charged !== null) return { chargedMicros: charged, unmeteredTokens: 0 };
  return { chargedMicros: 0, unmeteredTokens: billableTokensFromUsage(usage) };
}
