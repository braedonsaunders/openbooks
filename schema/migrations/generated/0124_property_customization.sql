BEGIN;

ALTER TABLE managed_properties
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
