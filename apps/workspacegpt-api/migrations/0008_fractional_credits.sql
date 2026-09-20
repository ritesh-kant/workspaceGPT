-- A one-credit minimum per model call made agent loops wildly expensive: one
-- hundred 20-token follow-ups were recorded as 100 credits instead of 2.
-- Keep the user-facing credit counter integral, but retain one-millionth-credit
-- units in the ledger and round only the accumulated weekly balance.
--
-- Existing balances are deliberately preserved at their already-displayed
-- whole-credit value. New charges use the precise units from this migration on.
ALTER TABLE usage_weekly ADD COLUMN credit_units INTEGER NOT NULL DEFAULT 0;

UPDATE usage_weekly
SET credit_units = credits * 1000000
WHERE credit_units = 0 AND credits > 0;
