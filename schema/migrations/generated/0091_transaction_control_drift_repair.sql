BEGIN;

-- 0088 was edited after some clusters had already recorded its original
-- digest. Repair those clusters forward without manufacturing legacy actor or
-- reason evidence. NOT VALID check constraints protect every new/updated row;
-- historical exceptions remain visible for explicit remediation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'customer_roles'
       AND column_name = 'held_at'
       AND data_type = 'date'
  ) THEN
    ALTER TABLE customer_roles
      ALTER COLUMN held_at TYPE timestamptz
      USING held_at::timestamp AT TIME ZONE 'UTC';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'vendor_roles'
       AND column_name = 'held_at'
       AND data_type = 'date'
  ) THEN
    ALTER TABLE vendor_roles
      ALTER COLUMN held_at TYPE timestamptz
      USING held_at::timestamp AT TIME ZONE 'UTC';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'party_bank_accounts'
       AND column_name = 'submitted_at'
       AND data_type = 'date'
  ) THEN
    ALTER TABLE party_bank_accounts
      ALTER COLUMN submitted_at TYPE timestamptz
      USING submitted_at::timestamp AT TIME ZONE 'UTC';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'party_bank_accounts'
       AND column_name = 'retired_at'
       AND data_type = 'date'
  ) THEN
    ALTER TABLE party_bank_accounts
      ALTER COLUMN retired_at TYPE timestamptz
      USING retired_at::timestamp AT TIME ZONE 'UTC';
  END IF;
END
$$;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_void_reason_required,
  DROP CONSTRAINT IF EXISTS documents_void_request_evidence;
ALTER TABLE documents
  ADD CONSTRAINT documents_void_reason_required
  CHECK (
    status <> 'voided'
    OR (
      voided_at IS NOT NULL
      AND voided_by IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 5 AND 500
      AND (posted_entry_id IS NULL OR reversal_entry_id IS NOT NULL)
    )
  ) NOT VALID,
  ADD CONSTRAINT documents_void_request_evidence
  CHECK (
    (void_requested_at IS NULL
      AND void_requested_by IS NULL
      AND void_reversal_date IS NULL)
    OR
    (void_requested_at IS NOT NULL
      AND void_requested_by IS NOT NULL
      AND void_reversal_date IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) BETWEEN 5 AND 500
      AND status IN ('approved', 'posted'))
  ) NOT VALID;

ALTER TABLE customer_roles
  DROP CONSTRAINT IF EXISTS customer_roles_hold_evidence,
  ADD CONSTRAINT customer_roles_hold_evidence
  CHECK (
    is_on_hold = false
    OR (
      hold_reason IS NOT NULL
      AND length(btrim(hold_reason)) BETWEEN 5 AND 500
      AND held_at IS NOT NULL
      AND held_by IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE vendor_roles
  DROP CONSTRAINT IF EXISTS vendor_roles_hold_evidence,
  ADD CONSTRAINT vendor_roles_hold_evidence
  CHECK (
    is_on_hold = false
    OR (
      hold_reason IS NOT NULL
      AND length(btrim(hold_reason)) BETWEEN 5 AND 500
      AND held_at IS NOT NULL
      AND held_by IS NOT NULL
    )
  ) NOT VALID;

DROP INDEX IF EXISTS documents_void_request;
CREATE INDEX documents_void_request
  ON documents (org_id, void_requested_at)
  WHERE void_requested_at IS NOT NULL;

COMMIT;
