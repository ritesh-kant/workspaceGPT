import type { RuntimeConfig } from './config';
import type { UserRow } from './db';
import type { Env } from './env';

/**
 * The daily cap for one account, highest precedence first:
 *   1. `users.daily_request_limit` — a deliberate per-account override
 *   2. the plan's entry in the configured plan→limit map
 *   3. the configured fallback for unlisted plans
 *
 * Layers 2 and 3 are themselves configurable at runtime (config.ts), so raising
 * a whole plan's ceiling is a one-row edit and raising one customer's is a
 * one-column edit — neither needs a deploy.
 */
export function dailyLimitFor(user: Pick<UserRow, 'plan' | 'daily_request_limit'>, config: RuntimeConfig): number {
  const override = user.daily_request_limit;
  if (typeof override === 'number' && Number.isInteger(override) && override > 0) {
    return override;
  }
  return config.planDailyLimits[user.plan] ?? config.fallbackDailyLimit;
}

/** UTC calendar day, 'YYYY-MM-DD' — the reset boundary is midnight UTC for everyone. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Count one request against the caller's daily allowance and say whether it
 * may proceed. Increments first and compares after, in a single statement, so
 * two concurrent requests can't both read the same pre-increment value and
 * slip past the cap together. An over-limit request is still counted — it is
 * rejected anyway, and counting it keeps a hammering client from resetting
 * its own denominator.
 */
export async function consumeDailyRequest(env: Env, userId: string, limit: number): Promise<QuotaDecision> {
  const row = await env.DB.prepare(
    `INSERT INTO usage_daily (user_id, day, requests) VALUES (?, ?, 1)
     ON CONFLICT(user_id, day) DO UPDATE SET requests = requests + 1
     RETURNING requests`
  )
    .bind(userId, utcDay())
    .first<{ requests: number }>();

  const used = row?.requests ?? 1;
  return { allowed: used <= limit, used, limit };
}

/** Read today's count without spending one — for `/v1/me`. */
export async function readDailyUsage(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT requests FROM usage_daily WHERE user_id = ? AND day = ?')
    .bind(userId, utcDay())
    .first<{ requests: number }>();
  return row?.requests ?? 0;
}

/** Seconds until the UTC-midnight reset, for a `Retry-After` header. */
export function secondsUntilReset(now = new Date()): number {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}
