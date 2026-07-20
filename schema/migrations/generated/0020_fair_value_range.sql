-- Fair value range review (NetSuite fair-value range policy, ASC 606 SSP
-- allocation review): when an obligation's allocated per-unit price falls
-- outside the matched fair value price's low/high range, the obligation is
-- flagged for review — a warning surfaced on the revenue contract, never a
-- posting block. Policy: orgs.settings.revenue.fairValueRangePolicy
-- ('warn' default | 'off'). Idempotent.

ALTER TABLE performance_obligations ADD COLUMN IF NOT EXISTS fair_value_flag text;
ALTER TABLE performance_obligations ADD COLUMN IF NOT EXISTS fair_value_low numeric(19,4);
ALTER TABLE performance_obligations ADD COLUMN IF NOT EXISTS fair_value_high numeric(19,4);
