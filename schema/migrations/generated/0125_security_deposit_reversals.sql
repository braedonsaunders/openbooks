ALTER TABLE security_deposit_transactions
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS security_deposits_reversal_once
  ON security_deposit_transactions(org_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'security_deposits_reversal_fk'
      AND conrelid = 'security_deposit_transactions'::regclass
  ) THEN
    ALTER TABLE security_deposit_transactions
      ADD CONSTRAINT security_deposits_reversal_fk
      FOREIGN KEY (reversal_of_id)
      REFERENCES security_deposit_transactions(id);
  END IF;
END $$;
