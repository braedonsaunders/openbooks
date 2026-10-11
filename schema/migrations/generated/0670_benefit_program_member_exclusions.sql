-- Employer-wide programs can exclude named employees: an excluded membership
-- removes that employment from eligibility over its dates. Existing
-- memberships remain ordinary inclusions.
ALTER TABLE public.hrm_benefit_program_members ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.hrm_benefit_program_members.excluded IS 'True removes the employment from an employer-wide program over the membership dates.';
SELECT public.openbooks_refresh_query_catalog();
