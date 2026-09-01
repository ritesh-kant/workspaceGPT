-- Caps move from per-day to per-week (200 requests/week is the new default).
--
-- The bucket key changes, so this is a new table rather than a rename: rows in
-- `usage_daily` are keyed by calendar day and cannot be reinterpreted as weeks.
-- Nothing is migrated across — the Worker has never served a real user
-- (REMOTE_AUTH.API_BASE still points at localhost), so the only rows that could
-- exist are local smoke-test ones, and starting everyone's first week at zero is
-- strictly more generous than any reinterpretation.
CREATE TABLE IF NOT EXISTS usage_weekly (
  user_id  TEXT    NOT NULL,
  week     TEXT    NOT NULL,   -- ISO-8601 week in UTC, 'YYYY-Www' (e.g. '2026-W36')
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, week)
);

DROP TABLE IF EXISTS usage_daily;

-- Per-user override follows the window. SQLite keeps the column's values, so an
-- override set while caps were daily survives — reread as a weekly number,
-- which is the intended meaning going forward.
ALTER TABLE users RENAME COLUMN daily_request_limit TO weekly_request_limit;
