/**
 * Token-metered credits — the pure half of usage accounting.
 *
 * Why credits, and why tokens underneath: the proxy used to count one unit per
 * HTTP call. That was fine for a chat turn (one call) and meaningless for an
 * agent turn, which makes 20–40 calls for one user message — a "200
 * requests/week" plan bought roughly five bug fixes. Cursor, Codex and Claude
 * Code each started with call/message counting and each moved off it (Cursor
 * in 2025, Codex in 2026); all three now meter tokens and present something
 * abstract on top (dollars, credits, a percentage). This follows them:
 *
 *   · METER tokens — precise, tracks the vendor bill, cannot be gamed by
 *     splitting or merging calls.
 *   · DISPLAY credits — `ceil(total_billable_tokens / tokensPerCredit)`, one
 *     small integer for the accumulated weekly total that a person can reason
 *     about. Rounding every individual call up would turn a hundred tiny
 *     agent follow-ups into a hundred credits even when they add up to only a
 *     few thousand tokens.
 *   · ONE allowance — the ISO-week cap, and nothing else.
 *
 * There was briefly a second, rolling five-hour allowance (as Codex and Claude
 * Code run). It was removed on 2026-09-06: it fired on ordinary use — one
 * afternoon of agent runs exhausted a fifth of the week's credits inside the
 * window and locked the account out for hours while ~78% of its weekly credits
 * sat unspent. Two clocks also meant two explanations for one refusal. The
 * weekly cap alone still bounds what any account can cost, which is the only
 * thing the limit exists to do; a burst just spends the week sooner.
 *
 * Everything in this file is side-effect free so it can be tested without a
 * Worker runtime; usage.ts owns the D1 statements, chat.ts the request flow.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** The part of `promptTokens` the vendor served from its prompt cache. */
  cachedPromptTokens: number;
}

/**
 * Read an OpenAI-shaped `usage` object. Tolerates a missing `total_tokens`
 * (some providers omit it) by summing the parts, and rejects anything that is
 * not a non-negative finite number so a malformed vendor payload can never
 * charge NaN credits.
 *
 * `prompt_tokens_details.cached_tokens` is OpenRouter's documented field for
 * the cache-hit share of the prompt; it appears automatically, with no request
 * flag. A few providers report a bare `cached_tokens` on the usage object
 * instead, so both are read. It is clamped to `promptTokens` because a cached
 * count larger than the prompt it describes is nonsense, and an unclamped one
 * would rebate more than the call ever cost (see {@link billableTokens}).
 */
export function usageFromObject(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
  const prompt = n(o.prompt_tokens);
  const completion = n(o.completion_tokens);
  const total = n(o.total_tokens);
  if (prompt === null && completion === null && total === null) return null;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const details = o.prompt_tokens_details;
  // Prefer the structured OpenRouter field, but fall back to the legacy bare
  // field if the wrapper is present without a value. Some compatible proxies
  // emit an empty details object and the bare count together.
  const cachedFromDetails =
    details && typeof details === 'object'
      ? n((details as Record<string, unknown>).cached_tokens)
      : null;
  const cachedRaw = cachedFromDetails ?? n(o.cached_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: total ?? promptTokens + completionTokens,
    cachedPromptTokens: Math.min(cachedRaw ?? 0, promptTokens),
  };
}

/**
 * What a cache-hit prompt token is charged, relative to a fresh one.
 *
 * An agent run resends its whole conversation every round, so after the first
 * round most of the prompt is a cache read — and OpenRouter bills those at
 * roughly a fifth of the input rate (chat.ts sends a stable `prompt_cache_key`
 * precisely so they stay warm). Charging them at full freight, which is what
 * this did until 2026-09-08, meant a 58-round agent run on ADO #1534774 cost
 * 2033 credits — a whole free-plan week for one ticket — while the underlying
 * vendor bill was a fraction of that. Credits are supposed to track the bill.
 *
 * 0.2 is the vendor's own typical cache-read multiple rather than a margin
 * decision. If it ever needs tuning per deployment it belongs in config.ts
 * beside `tokensPerCredit`; it is a constant here because one number in one
 * place is easier to reason about than a knob nobody turns.
 */
export const CACHED_TOKEN_WEIGHT = 0.2;

/**
 * Tokens actually charged for: the vendor's total, less the rebate on the part
 * it served from cache.
 *
 * Derived by REBATING from `totalTokens` rather than by re-adding the parts.
 * The parts do not always sum to the total — reasoning tokens, for one, are
 * counted in some providers' totals but not in `completion_tokens` — and a
 * parts-based sum would silently undercharge whenever that happens. Starting
 * from the number the vendor calls the total keeps this exact in every case
 * where nothing is cached, which is the case that must never drift.
 */
export function billableTokens(usage: TokenUsage): number {
  const total = Number.isFinite(usage.totalTokens) ? Math.max(0, usage.totalTokens) : 0;
  const cached = Math.min(Math.max(0, usage.cachedPromptTokens || 0), total);
  return Math.max(0, Math.round(total - cached * (1 - CACHED_TOKEN_WEIGHT)));
}

/**
 * Pull the usage out of a completed upstream response body.
 *
 * Streaming responses (SSE) carry it in the final `data:` chunk when
 * `stream_options.include_usage` is set — which chat.ts forces on every
 * streamed request precisely so this never comes back empty. Some providers
 * also emit `usage: null` on every earlier chunk; the LAST non-null one wins.
 * Non-streaming responses carry it at the top level.
 */
export function extractUsage(bodyText: string, contentType: string | null | undefined): TokenUsage | null {
  const isSse = (contentType ?? '').includes('text/event-stream') || /^\s*data:/.test(bodyText);
  if (!isSse) {
    try {
      return usageFromObject((JSON.parse(bodyText) as { usage?: unknown })?.usage);
    } catch {
      return null;
    }
  }
  let last: TokenUsage | null = null;
  for (const rawLine of bodyText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const u = usageFromObject((JSON.parse(payload) as { usage?: unknown })?.usage);
      if (u) last = u;
    } catch {
      // A truncated or non-JSON chunk is not our problem to fix here — skip it.
    }
  }
  return last;
}

/**
 * Tokens → credits. Always at least one credit for a call that produced any
 * tokens: a request that reached the vendor cost money even when it was tiny.
 * Zero (or nonsense) tokens charge nothing — that is the "nothing came back"
 * case, and the caller decides separately whether to estimate instead.
 */
export function creditsForTokens(totalTokens: number, tokensPerCredit: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  const per = Number.isFinite(tokensPerCredit) && tokensPerCredit > 0 ? tokensPerCredit : 1000;
  return Math.max(1, Math.ceil(totalTokens / per));
}

/**
 * Credits are stored as fixed-point units so a call does not have to consume a
 * whole credit by itself. Six decimal places keep the cumulative rounding
 * error below one millionth of a credit while staying well within SQLite's
 * integer range for realistic weekly usage.
 */
export const CREDIT_UNIT_SCALE = 1_000_000;

/**
 * Convert one call's cache-rebated token cost into fixed-point credit units.
 * The weekly bucket sums these units and rounds once when it is displayed or
 * admitted, avoiding per-call rounding inflation.
 */
export function creditUnitsForTokens(totalTokens: number, tokensPerCredit: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  const per = Number.isFinite(tokensPerCredit) && tokensPerCredit > 0 ? tokensPerCredit : 1000;
  return Math.ceil((Math.max(0, totalTokens) * CREDIT_UNIT_SCALE) / per);
}

/**
 * When the vendor returned no usage at all (a proxy that strips it, a
 * malformed body), estimate from what we DO know — the size of the prompt we
 * forwarded. Roughly four characters per token for English/code; completion
 * tokens are unknowable here and are not guessed. Under-charging a little on
 * a rare path beats over-charging, and the miss is logged so it can be seen.
 */
export function estimateTokensFromChars(requestBodyChars: number): number {
  if (!Number.isFinite(requestBodyChars) || requestBodyChars <= 0) return 0;
  return Math.ceil(requestBodyChars / 4);
}

export interface AdmissionInput {
  weeklyUsed: number;
  weeklyLimit: number;
  /** Seconds until the weekly bucket resets (Monday 00:00 UTC). */
  secondsUntilWeeklyReset: number;
}

export type AdmissionDecision =
  | { allowed: true }
  | { allowed: false; reason: 'weekly'; retryAfterSec: number; used: number; limit: number };

/**
 * May this request proceed? Checked BEFORE the upstream call, on usage already
 * recorded — tokens are only known after the response, so the request that
 * crosses the cap is always served (you cannot un-stream an answer) and the
 * next one is refused.
 *
 * A limit of zero or less means "uncapped", which is how a plan opts out.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  if (input.weeklyLimit > 0 && input.weeklyUsed >= input.weeklyLimit) {
    return {
      allowed: false,
      reason: 'weekly',
      retryAfterSec: Math.max(1, Math.ceil(input.secondsUntilWeeklyReset)),
      used: input.weeklyUsed,
      limit: input.weeklyLimit,
    };
  }
  return { allowed: true };
}

/** Human wording for a refused request — it is shown verbatim in the extension's error card. */
export function describeRefusal(d: Exclude<AdmissionDecision, { allowed: true }>): string {
  return `Weekly credit limit reached (${d.used} of ${d.limit} credits used). It resets Monday at 00:00 UTC.`;
}

export interface LimitConfig {
  planWeeklyCredits: Record<string, number>;
  fallbackWeeklyCredits: number;
}

export interface LimitUser {
  plan: string;
  /** Per-account weekly override; NULL means "use the plan's limit". */
  weekly_credit_limit: number | null;
}

/**
 * Weekly cap for one account, highest precedence first: the per-user override
 * → the plan's entry in the configured map → the configured fallback.
 */
export function weeklyCreditLimitFor(user: LimitUser, config: LimitConfig): number {
  const override = user.weekly_credit_limit;
  if (typeof override === 'number' && Number.isInteger(override) && override > 0) return override;
  return config.planWeeklyCredits[user.plan] ?? config.fallbackWeeklyCredits;
}
