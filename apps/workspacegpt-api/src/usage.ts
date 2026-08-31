import type { Env } from './env';

/**
 * Daily request caps by plan. `plan` already exists on the `users` row (see
 * migrations/0001_init.sql), so raising a customer's ceiling is a one-column
 * UPDATE with no schema change and no deploy.
 */
const PLAN_DAILY_LIMITS: Record<string, number> = {
  free: 200,
  pro: 5000,
};

const FALLBACK_DAILY_LIMIT = 200;

export function dailyLimitFor(plan: string, env: Env): number {
  const known = PLAN_DAILY_LIMITS[plan];
  if (typeof known === 'number') return known;
  const configured = Number(env.DAILY_REQUEST_LIMIT);
  return Number.isFinite(configured) && configured > 0 ? configured : FALLBACK_DAILY_LIMIT;
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
