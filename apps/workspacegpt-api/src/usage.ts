import type { RuntimeConfig } from './config';
import type { UserRow } from './db';
import type { Env } from './env';

/**
 * The weekly cap for one account, highest precedence first:
 *   1. `users.weekly_request_limit` — a deliberate per-account override
 *   2. the plan's entry in the configured plan→limit map
 *   3. the configured fallback for unlisted plans
 *
 * Layers 2 and 3 are themselves configurable at runtime (config.ts), so raising
 * a whole plan's ceiling is a one-row edit and raising one customer's is a
 * one-column edit — neither needs a deploy.
 */
export function weeklyLimitFor(
  user: Pick<UserRow, 'plan' | 'weekly_request_limit'>,
  config: RuntimeConfig
): number {
  const override = user.weekly_request_limit;
  if (typeof override === 'number' && Number.isInteger(override) && override > 0) {
    return override;
  }
  return config.planWeeklyLimits[user.plan] ?? config.fallbackWeeklyLimit;
}

/**
 * ISO-8601 week in UTC, `YYYY-Www` — weeks start Monday, and week 1 is the one
 * containing the year's first Thursday. Used as the usage bucket key.
 *
 * ISO weeks rather than "day-of-year / 7" so the boundary is always a Monday
 * midnight, never drifting per year, and so the last days of December fall in
 * the same bucket as the first days of January when they share a week — which
 * is why the year in the key is the ISO week-year, not `getUTCFullYear()`.
 */
export function utcWeek(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const isoDayNumber = date.getUTCDay() || 7; // Mon=1 … Sun=7
  // Step to the Thursday of this ISO week; its calendar year IS the week-year.
  date.setUTCDate(date.getUTCDate() + 4 - isoDayNumber);
  const weekYear = date.getUTCFullYear();
  const jan1 = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((date.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Count one request against the caller's weekly allowance and say whether it
 * may proceed. Increments first and compares after, in a single statement, so
 * two concurrent requests can't both read the same pre-increment value and
 * slip past the cap together. An over-limit request is still counted — it is
 * rejected anyway, and counting it keeps a hammering client from resetting
 * its own denominator.
 */
export async function consumeWeeklyRequest(env: Env, userId: string, limit: number): Promise<QuotaDecision> {
  const row = await env.DB.prepare(
    `INSERT INTO usage_weekly (user_id, week, requests) VALUES (?, ?, 1)
     ON CONFLICT(user_id, week) DO UPDATE SET requests = requests + 1
     RETURNING requests`
  )
    .bind(userId, utcWeek())
    .first<{ requests: number }>();

  const used = row?.requests ?? 1;
  return { allowed: used <= limit, used, limit };
}

/** Read this week's count without spending one — for `/v1/me`. */
export async function readWeeklyUsage(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT requests FROM usage_weekly WHERE user_id = ? AND week = ?')
    .bind(userId, utcWeek())
    .first<{ requests: number }>();
  return row?.requests ?? 0;
}

/** Seconds until the next Monday 00:00 UTC reset, for a `Retry-After` header. */
export function secondsUntilReset(now = new Date()): number {
  const isoDayNumber = now.getUTCDay() || 7; // Mon=1 … Sun=7
  const daysUntilMonday = 8 - isoDayNumber; // Monday → 7 (this week's has passed)
  const nextMonday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilMonday
  );
  return Math.max(1, Math.ceil((nextMonday - now.getTime()) / 1000));
}
