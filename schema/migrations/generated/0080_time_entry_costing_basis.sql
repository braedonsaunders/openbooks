BEGIN;

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS costing_basis text NOT NULL DEFAULT 'actual';

ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS time_entries_costing_basis_check;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_costing_basis_check
  CHECK (costing_basis IN ('actual', 'estimated'));

CREATE INDEX IF NOT EXISTS time_entries_costing_basis
  ON time_entries (org_id, project_id, costing_basis);

COMMIT;
