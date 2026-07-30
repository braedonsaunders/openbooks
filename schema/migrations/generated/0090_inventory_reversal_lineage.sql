BEGIN;

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS reverses_movement_id uuid,
  ADD COLUMN IF NOT EXISTS reversal_reason text;

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS inventory_movements_reverses_movement_id_fkey,
  ADD CONSTRAINT inventory_movements_reverses_movement_id_fkey
    FOREIGN KEY (reverses_movement_id)
    REFERENCES inventory_movements(id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS inv_moves_one_reversal
  ON inventory_movements (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;

ALTER TABLE inventory_movements
  DROP CONSTRAINT IF EXISTS inv_moves_reversal_evidence,
  ADD CONSTRAINT inv_moves_reversal_evidence
  CHECK (
    (reverses_movement_id IS NULL AND reversal_reason IS NULL)
    OR
    (
      reverses_movement_id IS NOT NULL
      AND reverses_movement_id <> id
      AND reversal_reason IS NOT NULL
      AND length(btrim(reversal_reason)) BETWEEN 5 AND 500
      AND created_by IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE inventory_movements
  VALIDATE CONSTRAINT inv_moves_reversal_evidence;

COMMIT;
