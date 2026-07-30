BEGIN;

ALTER TABLE psp_settlement_batches
  ADD COLUMN IF NOT EXISTS reversal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by uuid;

ALTER TABLE psp_settlement_batches
  DROP CONSTRAINT IF EXISTS psp_settlement_batches_reversal_entry_id_fkey,
  ADD CONSTRAINT psp_settlement_batches_reversal_entry_id_fkey
    FOREIGN KEY (reversal_entry_id)
    REFERENCES journal_entries(id)
    ON DELETE RESTRICT
    DEFERRABLE;

ALTER TABLE psp_settlement_batches
  DROP CONSTRAINT IF EXISTS psp_settlement_batches_reversed_by_fkey,
  ADD CONSTRAINT psp_settlement_batches_reversed_by_fkey
    FOREIGN KEY (reversed_by)
    REFERENCES users(id)
    ON DELETE RESTRICT
    DEFERRABLE;

CREATE UNIQUE INDEX IF NOT EXISTS psp_settlement_batches_one_reversal
  ON psp_settlement_batches (reversal_entry_id)
  WHERE reversal_entry_id IS NOT NULL;

ALTER TABLE psp_settlement_batches
  DROP CONSTRAINT IF EXISTS psp_settlement_batches_lifecycle_evidence,
  ADD CONSTRAINT psp_settlement_batches_lifecycle_evidence
  CHECK (
    (
      status = 'draft'
      AND journal_entry_id IS NULL
      AND posted_at IS NULL
      AND reversal_entry_id IS NULL
      AND reversal_reason IS NULL
      AND reversed_at IS NULL
      AND reversed_by IS NULL
    )
    OR
    (
      status = 'posted'
      AND journal_entry_id IS NOT NULL
      AND posted_at IS NOT NULL
      AND reversal_entry_id IS NULL
      AND reversal_reason IS NULL
      AND reversed_at IS NULL
      AND reversed_by IS NULL
    )
    OR
    (
      status = 'void'
      AND journal_entry_id IS NOT NULL
      AND posted_at IS NOT NULL
      AND reversal_entry_id IS NOT NULL
      AND reversal_entry_id <> journal_entry_id
      AND reversal_reason IS NOT NULL
      AND length(btrim(reversal_reason)) BETWEEN 5 AND 500
      AND reversed_at IS NOT NULL
      AND reversed_by IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE psp_settlement_batches
  VALIDATE CONSTRAINT psp_settlement_batches_lifecycle_evidence;

COMMIT;
