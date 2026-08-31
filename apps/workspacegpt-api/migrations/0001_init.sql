-- Accounts gated on GitHub sign-in. `plan`/`status` exist now so a future
-- paywall/entitlement check has somewhere to read from without a schema
-- migration; both default to a permissive "everyone's in" state today.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,          -- GitHub numeric user id, as text
  login TEXT NOT NULL,          -- GitHub login (handle), may change over time
  created_at INTEGER NOT NULL,  -- unix ms, first sign-in
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_users_login ON users (login);
