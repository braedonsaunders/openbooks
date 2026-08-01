BEGIN;

ALTER TABLE wip_prebill_lines
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN wip_prebill_lines.pricing_snapshot IS
  'Effective project financial policy, pricing basis, direct cost, overhead, and cap evidence frozen when the prebill line is created.';

COMMIT;
