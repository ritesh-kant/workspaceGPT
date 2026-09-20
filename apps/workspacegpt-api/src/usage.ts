import type { Env } from './env';
import { CREDIT_UNIT_SCALE } from './metering';

/**
 * The D1 half of usage accounting: reading what an account has spent and
 * recording a charge. All the arithmetic — tokens → credits, limits,
 * admission — is in metering.ts, which has no runtime dependency and is
 * tested directly.
 */

/**
 * ISO-8601 week in UTC, `YYYY-Www` — weeks start Monday, and week 1 is the one
 * containing the year's first Thursday. Used as the weekly bucket key.
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

/** Seconds until the next Monday 00:00 UTC reset, for `Retry-After` and refusal copy. */
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

export interface UsageSnapshot {
  /** Credits charged in the current ISO week. */
  weeklyCredits: number;
}

/**
 * What the account has spent this week. Read before every proxied call
 * (admission) and by `/v1/me` (display), so the number a user sees is the
 * number that is enforced.
 */
export async function readUsageSnapshot(env: Env, userId: string): Promise<UsageSnapshot> {
  const row = await env.DB.prepare(
    `SELECT CAST((credit_units + ${CREDIT_UNIT_SCALE - 1}) / ${CREDIT_UNIT_SCALE} AS INTEGER) AS credits
       FROM usage_weekly WHERE user_id = ? AND week = ?`
  )
    .bind(userId, utcWeek())
    .first<{ credits?: number }>();
  return { weeklyCredits: row?.credits ?? 0 };
}

/**
 * Record one served request's cost: fractional credit units and tokens
 * accumulate into the week's bucket, and the per-call count is kept alongside
 * as a statistic. Credits are rounded once from the accumulated fixed-point
 * balance; never once per model call.
 *
 * Called AFTER the upstream response has been fully read (tokens are only
 * known then), off the response path via `ctx.waitUntil`, so a slow D1 write
 * never delays the user's stream.
 *
 * `tokens` is the vendor's RAW total, so the column stays reconcilable against
 * the provider's dashboard; `creditUnits` is computed from the cache-rebated
 * total (see metering.ts `billableTokens`). The two therefore no longer
 * satisfy `credits === ceil(tokens / tokensPerCredit)`, and nothing should
 * assume they do — on a long agent run the credits are several times smaller.
 */
export async function chargeCredits(
  env: Env,
  userId: string,
  charge: { creditUnits: number; tokens: number }
): Promise<void> {
  if (charge.creditUnits <= 0) return;
  await env.DB.prepare(
    `INSERT INTO usage_weekly (user_id, week, requests, credits, credit_units, tokens)
     VALUES (?, ?, 1, CAST((? + ${CREDIT_UNIT_SCALE - 1}) / ${CREDIT_UNIT_SCALE} AS INTEGER), ?, ?)
     ON CONFLICT(user_id, week) DO UPDATE SET
       requests = requests + 1,
       credit_units = credit_units + excluded.credit_units,
       credits  = CAST((credit_units + excluded.credit_units + ${CREDIT_UNIT_SCALE - 1}) / ${CREDIT_UNIT_SCALE} AS INTEGER),
       tokens   = tokens + excluded.tokens`
  )
    .bind(userId, utcWeek(), charge.creditUnits, charge.creditUnits, charge.tokens)
    .run();
}
