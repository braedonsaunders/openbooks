BEGIN;

-- Connector period identities are source-owned master-data provenance. They
-- let a transaction resolve the exact source posting period, including an
-- adjustment period that overlaps an ordinary calendar period.
ALTER TABLE accounting_periods
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Transaction date and accounting period are independent accounting facts.
-- Existing documents retain date-derived behavior until a period is supplied.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS posting_period_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS accounting_periods_org_id_id_unique
  ON accounting_periods (org_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'documents_posting_period_org_fk'
       AND conrelid = 'documents'::regclass
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_posting_period_org_fk
      FOREIGN KEY (org_id, posting_period_id)
      REFERENCES accounting_periods (org_id, id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS documents_posting_period
  ON documents (org_id, posting_period_id)
  WHERE posting_period_id IS NOT NULL;

COMMIT;
