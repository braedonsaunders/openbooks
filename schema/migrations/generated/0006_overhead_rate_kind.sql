-- Overhead rates carry a rate KIND: per_hour ($/labor-hour — the NetSuite/adminapp
-- model) or percent (% of labor cost). The rate_percent column holds the value
-- either way (name kept for back-compat). Existing imported NetSuite labor-burden
-- rates are per-hour dollar figures. Idempotent.

ALTER TABLE overhead_rates ADD COLUMN IF NOT EXISTS rate_kind text NOT NULL DEFAULT 'per_hour';

-- Any rows already present (e.g. the imported NetSuite labor-burden rates) are $/hr.
UPDATE overhead_rates SET rate_kind = 'per_hour' WHERE rate_kind IS NULL OR rate_kind = '';
