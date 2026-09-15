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
/**
 * Upstream inference vendors the Worker knows how to talk to.
 *
 * `openrouter` is the one vendor with a hardcoded chat URL and secret name.
 * `custom` is the escape hatch for anything else (TokenRouter, GMI Cloud, a
 * self-hosted OpenAI-compatible endpoint, ...): its base URL and key come
 * from env/D1 instead of a name baked into this file, so switching vendors
 * never needs a code change — see CUSTOM_API_BASE_URL in env.ts.
 */
const OPENROUTER = {
  chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
  apiKeyEnv: 'OPENROUTER_API_KEY',
} as const;

const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Turn whatever was configured for `custom` into a chat-completions URL.
 *
 * The setting is NAMED a base URL, so `https://api.tokenrouter.com/v1` is the
 * value a reasonable person sets — and it is exactly what was deployed on
 * 2026-09-07, while the code below fetched it verbatim. Every remote-mode
 * request then POSTed to `/v1`, the vendor answered `404 Invalid URL (POST
 * /v1)`, and the proxy passed that through to the extension, where it sat next
 * to this Worker's own baseUrl and read as if the Worker's URL were wrong.
 * Accept both forms instead of relying on whoever sets the var to know which
 * one this file wants. An empty value stays empty — chat.ts fails closed on
 * it, the same way it does on a missing key.
 */
function toChatCompletionsUrl(raw: string): string {
  const url = raw.replace(/\/+$/, '');
  if (!url) return '';
  return url.endsWith(CHAT_COMPLETIONS_PATH) ? url : `${url}${CHAT_COMPLETIONS_PATH}`;
}

export type ProviderName = 'openrouter' | 'custom';

function isProviderName(value: string): value is ProviderName {
  return value === 'openrouter' || value === 'custom';
}

export interface RuntimeConfig {
  /** Which upstream vendor remote-mode requests are routed to. */
  provider: ProviderName;
  /** Chat-completions endpoint for the resolved provider. */
  chatUrl: string;
  /** Which Env field holds the resolved provider's API key. */
  apiKeyEnv: 'OPENROUTER_API_KEY' | 'CUSTOM_API_KEY';
  /** Model id for the resolved provider, in the format it expects. */
  model: string;
  /** plan name → credits per ISO week. */
  planWeeklyCredits: Record<string, number>;
  /** credits/week for a plan absent from {@link planWeeklyCredits}. */
  fallbackWeeklyCredits: number;
  /** How many vendor tokens one credit represents. */
  tokensPerCredit: number;
}

/**
 * Recognised `app_config.key` values.
 *
 * The request-era keys (`plan_weekly_limits`, `weekly_request_limit`) are
 * deliberately NOT read any more: a value written for them was a call count,
 * and reading it as credits would throttle every plan to a fraction of its
 * intent. New keys, new meaning. The rolling-window keys (`plan_window_credits`,
 * `window_credit_limit`) are gone with the window itself — a row left behind
 * for either is simply ignored.
 */
export const CONFIG_KEYS = {
  PROVIDER: 'inference_provider',
  OPENROUTER_MODEL: 'openrouter_model',
  CUSTOM_BASE_URL: 'custom_api_base_url',
  CUSTOM_MODEL: 'custom_model',
  PLAN_WEEKLY_CREDITS: 'plan_weekly_credits',
  FALLBACK_WEEKLY_CREDITS: 'weekly_credit_limit',
  TOKENS_PER_CREDIT: 'tokens_per_credit',
} as const;

const DEFAULT_PROVIDER: ProviderName = 'openrouter';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
/**
 * Placeholder plan sizes, in credits of 1,000 tokens. Sized from the eval
 * harness on 2026-09-05: a documentation answer is ~7 credits, an agent run
 * that edits code ~50. So free ≈ 28 questions or ~4 fixes a week; pro ≈ 250×
 * that. These are starting points for a pricing decision, not the decision.
 */
const DEFAULT_PLAN_WEEKLY_CREDITS: Record<string, number> = { free: 200, pro: 50000 };
const DEFAULT_FALLBACK_WEEKLY_CREDITS = 200;
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

  // `custom`'s URL is the whole point of the escape hatch, so it comes from
  // env/D1 rather than a name in OPENROUTER above; an unset one resolves to
  // '' and chat.ts refuses the request the same way it does a missing key.
  const chatUrl =
    provider === 'custom'
      ? toChatCompletionsUrl(
          overrides.get(CONFIG_KEYS.CUSTOM_BASE_URL)?.trim() || env.CUSTOM_API_BASE_URL?.trim() || ''
        )
      : OPENROUTER.chatUrl;
  const apiKeyEnv = provider === 'custom' ? 'CUSTOM_API_KEY' : OPENROUTER.apiKeyEnv;

  // Each provider keeps its own model id — a vendor swap must never silently
  // reuse the other vendor's id format. `custom` has no built-in default: an
  // unset one resolves to '' and chat.ts fails closed, same as a missing key.
  const model =
    provider === 'custom'
      ? overrides.get(CONFIG_KEYS.CUSTOM_MODEL)?.trim() || env.CUSTOM_MODEL?.trim() || ''
      : overrides.get(CONFIG_KEYS.OPENROUTER_MODEL)?.trim() || env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const planWeeklyCredits =
    parsePlanLimits(overrides.get(CONFIG_KEYS.PLAN_WEEKLY_CREDITS), 'app_config') ??
    parsePlanLimits(env.PLAN_WEEKLY_CREDITS, 'wrangler var') ??
    DEFAULT_PLAN_WEEKLY_CREDITS;

  const fallbackWeeklyCredits =
    positiveInt(overrides.get(CONFIG_KEYS.FALLBACK_WEEKLY_CREDITS)) ??
    positiveInt(env.WEEKLY_CREDIT_LIMIT) ??
    DEFAULT_FALLBACK_WEEKLY_CREDITS;

  const tokensPerCredit =
    positiveInt(overrides.get(CONFIG_KEYS.TOKENS_PER_CREDIT)) ??
    positiveInt(env.TOKENS_PER_CREDIT) ??
    DEFAULT_TOKENS_PER_CREDIT;

  return {
    provider,
    chatUrl,
    apiKeyEnv,
    model,
    planWeeklyCredits,
    fallbackWeeklyCredits,
    tokensPerCredit,
  };
}
