-- Usage moves from counting HTTP calls to metering tokens, presented as credits.
--
-- One user message can be one call (a doc answer) or forty (an agent run), so
-- "requests per week" stopped describing anything a person could plan around.
-- Every request now records the tokens the vendor reported and the credits
-- they convert to (see src/metering.ts); the per-call count is kept as a
-- statistic only and is no longer a limit.
--
-- Two allowances are enforced: the existing ISO-week bucket (now in credits)
-- and a rolling five-hour window, which needs per-charge rows rather than a
-- bucket — hence `usage_events`. Rows there are pruned as they age out of the
-- window; the weekly aggregate lives in `usage_weekly` as before.
--
-- Existing `usage_weekly.requests` values are NOT reinterpreted as credits: a
-- call is not a credit. Everyone's credit counters start at zero, which is
-- strictly more generous than any conversion for anyone mid-week.
ALTER TABLE usage_weekly ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_weekly ADD COLUMN tokens  INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS usage_events (
  user_id TEXT    NOT NULL,
  ts      INTEGER NOT NULL,   -- unix seconds the charge was recorded
  credits INTEGER NOT NULL,
  tokens  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_user_ts ON usage_events (user_id, ts);

-- Per-account weekly override, in credits. A NEW column rather than a reuse of
-- `weekly_request_limit`: any value there was a request count, and reading it
-- as credits would silently throttle that account to a fraction of its plan.
-- The old column is left in place, unread.
ALTER TABLE users ADD COLUMN weekly_credit_limit INTEGER;
