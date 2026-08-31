-- Per-user, per-UTC-day request counter backing the daily cap in src/usage.ts.
-- Counts requests admitted to the OpenRouter proxy, not tokens: the vendor's
-- single OpenRouter key pays for every one of them, so admission is the
-- cheapest place to stop abuse. No request or response content is ever stored.
CREATE TABLE IF NOT EXISTS usage_daily (
  user_id  TEXT    NOT NULL,   -- users.id (GitHub numeric id as text)
  day      TEXT    NOT NULL,   -- UTC calendar day, 'YYYY-MM-DD'
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
