import type { Env } from './env';

/**
 * Resolved runtime configuration for one request.
 *
 * Three layers, highest precedence first:
 *   1. a row in the `app_config` D1 table   — changeable with no deploy
 *   2. a `var` in wrangler.jsonc            — deploy-time default
 *   3. the constants below                  — last-resort fallback
 *
 * (The per-user cap override in `users.weekly_credit_limit` sits above all
 * three; it is applied in metering.ts, which is the only place that needs it.)
 *
 * Layer 1 is read on every request, batched with the user lookup, so it costs
 * no extra round trip and an edit takes effect on the very next call — no
 * cache to wait out, no isolate to recycle.
 */
/** Upstream inference vendors the Worker knows how to talk to. */
export const PROVIDERS = {
  openrouter: {
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  gmicloud: {
    chatUrl: 'https://api.gmi-serving.com/v1/chat/completions',
    apiKeyEnv: 'GMICLOUD_API_KEY',
  },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

function isProviderName(value: string): value is ProviderName {
  return value in PROVIDERS;
}

export interface RuntimeConfig {
  /** Which upstream vendor remote-mode requests are routed to. */
  provider: ProviderName;
  /** Model id, in the format the chosen provider expects. */
  model: string;
  /** plan name → credits per ISO week. */
  planWeeklyCredits: Record<string, number>;
  /** credits/week for a plan absent from {@link planWeeklyCredits}. */
  fallbackWeeklyCredits: number;
  /** plan name → credits per rolling 5-hour window. Absent plans derive from the weekly cap (metering.ts). */
  planWindowCredits: Record<string, number>;
  /** window credits for a plan absent from {@link planWindowCredits}; undefined derives from weekly. */
  fallbackWindowCredits: number | undefined;
  /** How many vendor tokens one credit represents. */
  tokensPerCredit: number;
}

/**
 * Recognised `app_config.key` values.
 *
 * The request-era keys (`plan_weekly_limits`, `weekly_request_limit`) are
 * deliberately NOT read any more: a value written for them was a call count,
 * and reading it as credits would throttle every plan to a fraction of its
 * intent. New keys, new meaning.
 */
export const CONFIG_KEYS = {
  PROVIDER: 'inference_provider',
  MODEL: 'openrouter_model',
  PLAN_WEEKLY_CREDITS: 'plan_weekly_credits',
  FALLBACK_WEEKLY_CREDITS: 'weekly_credit_limit',
  PLAN_WINDOW_CREDITS: 'plan_window_credits',
  FALLBACK_WINDOW_CREDITS: 'window_credit_limit',
  TOKENS_PER_CREDIT: 'tokens_per_credit',
} as const;

const DEFAULT_PROVIDER: ProviderName = 'openrouter';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
/**
 * Placeholder plan sizes, in credits of 1,000 tokens. Sized from the eval
 * harness on 2026-09-05: a documentation answer is ~7 credits, an agent run
 * that edits code ~50. So free ≈ 280 questions or ~40 fixes a week; pro ≈ 25×
 * that. These are starting points for a pricing decision, not the decision.
 */
const DEFAULT_PLAN_WEEKLY_CREDITS: Record<string, number> = { free: 2000, pro: 50000 };
const DEFAULT_FALLBACK_WEEKLY_CREDITS = 2000;
const DEFAULT_TOKENS_PER_CREDIT = 1000;

export interface ConfigRow {
  key: string;
  value: string;
}

/** The statement to batch alongside the user lookup. */
export function configQuery(env: Env) {
  return env.DB.prepare('SELECT key, value FROM app_config');
}

/** A positive integer, or undefined — never NaN, never 0, never negative. */
function positiveInt(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Parse a `{"plan": credits}` map, dropping any entry that isn't a positive
 * integer. A malformed blob yields undefined so the next layer down applies —
 * a typo in one config value must never leave usage uncapped.
 */
function parsePlanLimits(raw: string | undefined, source: string): Record<string, number> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[workspacegpt-api] plan limits are not valid JSON; ignoring', { source });
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[workspacegpt-api] plan limits must be a JSON object; ignoring', { source });
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [plan, value] of Object.entries(parsed as Record<string, unknown>)) {
    const limit = positiveInt(value);
    if (limit === undefined) {
      console.error('[workspacegpt-api] dropping non-positive-integer plan limit', { source, plan });
      continue;
    }
    out[plan] = limit;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Collapse the three layers into the values this request will actually use. */
export function resolveConfig(env: Env, rows: ConfigRow[] | null | undefined): RuntimeConfig {
  const overrides = new Map((rows ?? []).map((r) => [r.key, r.value]));

  const rawProvider =
    overrides.get(CONFIG_KEYS.PROVIDER)?.trim() || env.INFERENCE_PROVIDER?.trim() || DEFAULT_PROVIDER;
  if (!isProviderName(rawProvider)) {
    console.error('[workspacegpt-api] unknown inference provider; falling back to default', {
      rawProvider,
    });
  }
  const provider = isProviderName(rawProvider) ? rawProvider : DEFAULT_PROVIDER;

  const model =
    overrides.get(CONFIG_KEYS.MODEL)?.trim() || env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const planWeeklyCredits =
    parsePlanLimits(overrides.get(CONFIG_KEYS.PLAN_WEEKLY_CREDITS), 'app_config') ??
    parsePlanLimits(env.PLAN_WEEKLY_CREDITS, 'wrangler var') ??
    DEFAULT_PLAN_WEEKLY_CREDITS;

  const fallbackWeeklyCredits =
    positiveInt(overrides.get(CONFIG_KEYS.FALLBACK_WEEKLY_CREDITS)) ??
    positiveInt(env.WEEKLY_CREDIT_LIMIT) ??
    DEFAULT_FALLBACK_WEEKLY_CREDITS;

  // Window caps have no constant fallback on purpose: absent, they derive from
  // the weekly cap (metering.ts), so one edit to the weekly number keeps both
  // in proportion.
  const planWindowCredits =
    parsePlanLimits(overrides.get(CONFIG_KEYS.PLAN_WINDOW_CREDITS), 'app_config') ??
    parsePlanLimits(env.PLAN_WINDOW_CREDITS, 'wrangler var') ??
    {};

  const fallbackWindowCredits =
    positiveInt(overrides.get(CONFIG_KEYS.FALLBACK_WINDOW_CREDITS)) ?? positiveInt(env.WINDOW_CREDIT_LIMIT);

  const tokensPerCredit =
    positiveInt(overrides.get(CONFIG_KEYS.TOKENS_PER_CREDIT)) ??
    positiveInt(env.TOKENS_PER_CREDIT) ??
    DEFAULT_TOKENS_PER_CREDIT;

  return {
    provider,
    model,
    planWeeklyCredits,
    fallbackWeeklyCredits,
    planWindowCredits,
    fallbackWindowCredits,
    tokensPerCredit,
  };
}
