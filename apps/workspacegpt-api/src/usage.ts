import type { Env } from './env';
import { EVENT_RETENTION_SECONDS, WINDOW_SECONDS } from './metering';

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
  /** Credits charged inside the rolling window ending now. */
  windowCredits: number;
  /** Unix seconds of the oldest charge inside the window, or null when empty. */
  windowOldestTs: number | null;
}

/**
 * What the account has spent, in one D1 batch. Read before every proxied call
 * (admission) and by `/v1/me` (display), so the number a user sees is the
 * number that is enforced.
 */
export async function readUsageSnapshot(env: Env, userId: string, nowSec = Math.floor(Date.now() / 1000)): Promise<UsageSnapshot> {
  const since = nowSec - WINDOW_SECONDS;
  const [weekly, window] = await env.DB.batch([
    env.DB.prepare('SELECT credits FROM usage_weekly WHERE user_id = ? AND week = ?').bind(userId, utcWeek()),
    env.DB.prepare(
      'SELECT COALESCE(SUM(credits), 0) AS credits, MIN(ts) AS oldest FROM usage_events WHERE user_id = ? AND ts > ?'
    ).bind(userId, since),
  ]);
  const weeklyRow = weekly.results?.[0] as { credits?: number } | undefined;
  const windowRow = window.results?.[0] as { credits?: number; oldest?: number | null } | undefined;
  return {
    weeklyCredits: weeklyRow?.credits ?? 0,
    windowCredits: windowRow?.credits ?? 0,
    windowOldestTs: typeof windowRow?.oldest === 'number' ? windowRow.oldest : null,
  };
}

/**
 * Record one served request's cost. Three statements in one batch:
 *   1. a window event (the rolling allowance is a SUM over these),
 *   2. the weekly bucket upsert — credits and tokens accumulate, and the
 *      per-call count is kept as a statistic,
 *   3. pruning of events that have aged out of the window.
 * Called AFTER the upstream response has been fully read (tokens are only
 * known then), off the response path via `ctx.waitUntil`, so a slow D1 write
 * never delays the user's stream.
 */
export async function chargeCredits(
  env: Env,
  userId: string,
  charge: { credits: number; tokens: number },
  nowSec = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (charge.credits <= 0) return;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO usage_events (user_id, ts, credits, tokens) VALUES (?, ?, ?, ?)').bind(
      userId,
      nowSec,
      charge.credits,
      charge.tokens
    ),
    env.DB.prepare(
      `INSERT INTO usage_weekly (user_id, week, requests, credits, tokens) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(user_id, week) DO UPDATE SET
         requests = requests + 1,
         credits  = credits + excluded.credits,
         tokens   = tokens + excluded.tokens`
    ).bind(userId, utcWeek(), charge.credits, charge.tokens),
    env.DB.prepare('DELETE FROM usage_events WHERE user_id = ? AND ts < ?').bind(
      userId,
      nowSec - EVENT_RETENTION_SECONDS
    ),
  ]);
}
