-- Runtime configuration, changeable without a deploy.
--
-- The Worker's `vars` in wrangler.jsonc are deploy-time defaults; a row here
-- overrides one of them for the next request, with no code change and no
-- redeploy. Read on every request (batched with the user lookup, so it costs no
-- extra round trip), so an edit takes effect immediately.
--
-- Recognised keys (see src/config.ts):
--   openrouter_model    -- e.g. 'anthropic/claude-sonnet-4.5'
--   plan_daily_limits   -- JSON object, e.g. '{"free":200,"pro":5000}'
--   daily_request_limit -- integer, fallback for plans absent from the above
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-user cap override, the highest-precedence rate limit. NULL means "use the
-- plan's limit"; set it to raise (or throttle) one account without inventing a
-- whole new plan for them.
ALTER TABLE users ADD COLUMN daily_request_limit INTEGER;
