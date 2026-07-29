BEGIN;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS void_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS void_requested_by uuid,
  ADD COLUMN IF NOT EXISTS void_reversal_date date,
  ADD COLUMN IF NOT EXISTS reversal_entry_id uuid;

CREATE INDEX IF NOT EXISTS documents_void_request
  ON documents (org_id, void_requested_at)
  WHERE void_requested_at IS NOT NULL;

ALTER TABLE customer_roles
  ADD COLUMN IF NOT EXISTS is_on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE vendor_roles
  ADD COLUMN IF NOT EXISTS is_on_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE party_bank_accounts
  ADD COLUMN IF NOT EXISTS submitted_by uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid,
  ADD COLUMN IF NOT EXISTS retirement_reason text;

UPDATE party_bank_accounts
   SET submitted_by = coalesce(submitted_by, created_by),
       submitted_at = coalesce(submitted_at, created_at)
 WHERE submitted_by IS NULL OR submitted_at IS NULL;

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
  ) NOT VALID;

ALTER TABLE documents
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

ALTER TABLE party_bank_accounts
  ADD CONSTRAINT party_bank_accounts_retirement_evidence
  CHECK (
    retired_at IS NULL
    OR (
      is_active = false
      AND retired_by IS NOT NULL
      AND retirement_reason IS NOT NULL
      AND length(btrim(retirement_reason)) BETWEEN 5 AND 500
    )
  ) NOT VALID;

COMMIT;
