import type { Env } from './env';

/**
 * Resolved runtime configuration for one request.
 *
 * Three layers, highest precedence first:
 *   1. a row in the `app_config` D1 table   — changeable with no deploy
 *   2. a `var` in wrangler.jsonc            — deploy-time default
 *   3. the constants below                  — last-resort fallback
 *
 * (The per-user cap override in `users.daily_request_limit` sits above all
 * three; it is applied in usage.ts, which is the only place that needs it.)
 *
 * Layer 1 is read on every request, batched with the user lookup, so it costs
 * no extra round trip and an edit takes effect on the very next call — no
 * cache to wait out, no isolate to recycle.
 */
export interface RuntimeConfig {
  /** OpenRouter model id every remote-mode request is routed to. */
  model: string;
  /** plan name → requests/week. */
  planWeeklyLimits: Record<string, number>;
  /** requests/week for a plan absent from {@link planWeeklyLimits}. */
  fallbackWeeklyLimit: number;
}

/** Recognised `app_config.key` values. */
export const CONFIG_KEYS = {
  MODEL: 'openrouter_model',
  PLAN_WEEKLY_LIMITS: 'plan_weekly_limits',
  FALLBACK_WEEKLY_LIMIT: 'weekly_request_limit',
} as const;

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_PLAN_WEEKLY_LIMITS: Record<string, number> = { free: 200, pro: 5000 };
const DEFAULT_FALLBACK_WEEKLY_LIMIT = 200;

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
 * Parse a `{"plan": requestsPerWeek}` map, dropping any entry that isn't a
 * positive integer. A malformed blob yields undefined so the next layer down applies —
 * a typo in one config value must never leave requests uncapped.
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

  const model =
    overrides.get(CONFIG_KEYS.MODEL)?.trim() || env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;

  const planWeeklyLimits =
    parsePlanLimits(overrides.get(CONFIG_KEYS.PLAN_WEEKLY_LIMITS), 'app_config') ??
    parsePlanLimits(env.PLAN_WEEKLY_LIMITS, 'wrangler var') ??
    DEFAULT_PLAN_WEEKLY_LIMITS;

  const fallbackWeeklyLimit =
    positiveInt(overrides.get(CONFIG_KEYS.FALLBACK_WEEKLY_LIMIT)) ??
    positiveInt(env.WEEKLY_REQUEST_LIMIT) ??
    DEFAULT_FALLBACK_WEEKLY_LIMIT;

  return { model, planWeeklyLimits, fallbackWeeklyLimit };
}
