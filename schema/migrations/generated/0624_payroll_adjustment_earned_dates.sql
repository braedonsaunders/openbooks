-- Retain explicit source earning dates on editable payroll inputs without
-- reinterpreting existing undated inputs or immutable posted pay-stub lines.
ALTER TABLE public.pay_run_adjustments
  ADD COLUMN earned_from date,
  ADD COLUMN earned_to date,
  ADD CONSTRAINT pay_run_adjustments_earned_dates CHECK (
    (earned_from IS NULL AND earned_to IS NULL)
    OR (adjustment_type = 'line' AND earned_from IS NOT NULL
      AND earned_to IS NOT NULL AND earned_from <= earned_to)
  );
