-- Approved-hour incentives can count only chosen time classifications, so a
-- program can pay per overtime or double-time hour without counting regular
-- time. Null counts every classification, as before.
ALTER TABLE public.hrm_benefit_programs ADD COLUMN IF NOT EXISTS hour_classifications text[];
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_hour_classifications') THEN
  ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_hour_classifications CHECK (
    hour_classifications IS NULL OR (cardinality(hour_classifications) > 0
      AND hour_classifications <@ ARRAY['regular','overtime','double_time','other']::text[])); END IF; END $$;
COMMENT ON COLUMN public.hrm_benefit_programs.hour_classifications IS 'Approved-hour measures count only these time classifications; null counts all.';
