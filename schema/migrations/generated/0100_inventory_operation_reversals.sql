BEGIN;

-- A landed-cost voucher is posted financial evidence. Cancellation is an
-- append-only reversal, never a rewrite or deletion of the capitalization.
ALTER TABLE landed_cost_vouchers
  ADD COLUMN IF NOT EXISTS reversal_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid,
  ADD COLUMN IF NOT EXISTS void_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_vouchers'::regclass
       AND conname = 'landed_cost_vouchers_reversal_entry_fkey'
  ) THEN
    ALTER TABLE landed_cost_vouchers
      ADD CONSTRAINT landed_cost_vouchers_reversal_entry_fkey
      FOREIGN KEY (reversal_journal_entry_id) REFERENCES journal_entries(id)
      DEFERRABLE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_vouchers'::regclass
       AND conname = 'landed_cost_vouchers_voided_by_fkey'
  ) THEN
    ALTER TABLE landed_cost_vouchers
      ADD CONSTRAINT landed_cost_vouchers_voided_by_fkey
      FOREIGN KEY (voided_by) REFERENCES users(id)
      DEFERRABLE;
  END IF;
END
$$;

ALTER TABLE landed_cost_allocations
  ADD COLUMN IF NOT EXISTS voucher_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_allocation_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

UPDATE landed_cost_allocations allocation
   SET voucher_id = voucher.id
  FROM landed_cost_vouchers voucher
 WHERE allocation.voucher_id IS NULL
   AND allocation.org_id = voucher.org_id
   AND allocation.journal_entry_id = voucher.journal_entry_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_allocations'::regclass
       AND conname = 'landed_cost_allocations_voucher_fkey'
  ) THEN
    ALTER TABLE landed_cost_allocations
      ADD CONSTRAINT landed_cost_allocations_voucher_fkey
      FOREIGN KEY (voucher_id) REFERENCES landed_cost_vouchers(id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_allocations'::regclass
       AND conname = 'landed_cost_allocations_reversal_fkey'
  ) THEN
    ALTER TABLE landed_cost_allocations
      ADD CONSTRAINT landed_cost_allocations_reversal_fkey
      FOREIGN KEY (reverses_allocation_id) REFERENCES landed_cost_allocations(id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_allocations'::regclass
       AND conname = 'landed_cost_allocations_reversal_shape'
  ) THEN
    ALTER TABLE landed_cost_allocations
      ADD CONSTRAINT landed_cost_allocations_reversal_shape
      CHECK (
        (reverses_allocation_id IS NULL AND amount > 0 AND reversal_reason IS NULL)
        OR
        (reverses_allocation_id IS NOT NULL AND amount < 0
          AND length(btrim(reversal_reason)) BETWEEN 5 AND 500)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'landed_cost_vouchers'::regclass
       AND conname = 'landed_cost_vouchers_void_evidence'
  ) THEN
    ALTER TABLE landed_cost_vouchers
      ADD CONSTRAINT landed_cost_vouchers_void_evidence
      CHECK (
        (status <> 'void'
          AND reversal_journal_entry_id IS NULL
          AND voided_at IS NULL
          AND voided_by IS NULL
          AND void_reason IS NULL)
        OR
        (status = 'void'
          AND reversal_journal_entry_id IS NOT NULL
          AND voided_at IS NOT NULL
          AND voided_by IS NOT NULL
          AND length(btrim(void_reason)) BETWEEN 5 AND 500)
      ) NOT VALID;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS landed_cost_allocation_one_reversal
  ON landed_cost_allocations (reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS landed_cost_allocations_voucher
  ON landed_cost_allocations (voucher_id);

ALTER TABLE landed_cost_allocations
  VALIDATE CONSTRAINT landed_cost_allocations_reversal_shape;
ALTER TABLE landed_cost_vouchers
  VALIDATE CONSTRAINT landed_cost_vouchers_void_evidence;

CREATE OR REPLACE FUNCTION landed_cost_voucher_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft'
       OR openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'posted landed-cost vouchers cannot be deleted';
  END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF OLD.status = 'posted'
     AND NEW.status = 'void'
     AND NEW.org_id = OLD.org_id
     AND NEW.document_number = OLD.document_number
     AND NEW.amount = OLD.amount
     AND NEW.basis = OLD.basis
     AND NEW.freight_account_id = OLD.freight_account_id
     AND NEW.source_document_line_id IS NOT DISTINCT FROM OLD.source_document_line_id
     AND NEW.subsidiary_id = OLD.subsidiary_id
     AND NEW.voucher_date = OLD.voucher_date
     AND NEW.journal_entry_id = OLD.journal_entry_id
     AND NEW.memo IS NOT DISTINCT FROM OLD.memo
     AND NEW.created_at = OLD.created_at
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.reversal_journal_entry_id IS NOT NULL
     AND NEW.voided_at IS NOT NULL
     AND NEW.voided_by IS NOT NULL
     AND length(btrim(NEW.void_reason)) BETWEEN 5 AND 500 THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted and void landed-cost vouchers are immutable';
END
$$;

DROP TRIGGER IF EXISTS landed_cost_voucher_guard_trigger
  ON landed_cost_vouchers;
CREATE TRIGGER landed_cost_voucher_guard_trigger
BEFORE UPDATE OR DELETE ON landed_cost_vouchers
FOR EACH ROW EXECUTE FUNCTION landed_cost_voucher_guard();

CREATE OR REPLACE FUNCTION landed_cost_voucher_target_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
  parent_org uuid;
BEGIN
  SELECT status, org_id
    INTO parent_status, parent_org
    FROM landed_cost_vouchers
   WHERE id = coalesce(NEW.voucher_id, OLD.voucher_id);
  IF TG_OP = 'DELETE' AND parent_status IS NULL THEN RETURN OLD; END IF;
  IF parent_status IS NULL
     OR parent_org IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'landed-cost target must reference a tenant-owned voucher';
  END IF;
  IF parent_status <> 'draft' THEN
    IF TG_OP = 'DELETE'
       AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'targets of a posted landed-cost voucher are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS landed_cost_voucher_target_guard_trigger
  ON landed_cost_voucher_targets;
CREATE TRIGGER landed_cost_voucher_target_guard_trigger
BEFORE INSERT OR UPDATE OR DELETE ON landed_cost_voucher_targets
FOR EACH ROW EXECUTE FUNCTION landed_cost_voucher_target_guard();

CREATE OR REPLACE FUNCTION landed_cost_allocation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'landed-cost allocation evidence is append-only';
  END IF;
  IF OLD.journal_entry_id IS NULL
     AND NEW.journal_entry_id IS NOT NULL
     AND (to_jsonb(NEW) - 'journal_entry_id' - 'updated_at' - 'updated_by')
       = (to_jsonb(OLD) - 'journal_entry_id' - 'updated_at' - 'updated_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'landed-cost allocation evidence is immutable';
END
$$;

DROP TRIGGER IF EXISTS landed_cost_allocation_guard_trigger
  ON landed_cost_allocations;
CREATE TRIGGER landed_cost_allocation_guard_trigger
BEFORE UPDATE OR DELETE ON landed_cost_allocations
FOR EACH ROW EXECUTE FUNCTION landed_cost_allocation_guard();

COMMIT;
