-- A program's eligibility: named members, or every employee of the
-- program's employer who is in active service during the period. Role,
-- scope and measure rules still decide who is paid; existing programs keep
-- their member lists.
ALTER TABLE public.hrm_benefit_programs ADD COLUMN IF NOT EXISTS eligibility text NOT NULL DEFAULT 'members';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_eligibility') THEN
  ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_eligibility CHECK (eligibility IN ('members', 'all_employees')); END IF; END $$;
COMMENT ON COLUMN public.hrm_benefit_programs.eligibility IS 'members: named memberships; all_employees: every employee of the employer in active service during the period.';
SELECT public.openbooks_refresh_query_catalog();
