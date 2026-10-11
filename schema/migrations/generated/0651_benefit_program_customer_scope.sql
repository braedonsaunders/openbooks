-- Project-scoped benefit programs may select projects by customer, so a
-- program follows every project of a client without a hand-kept project
-- list. Department rows on a project-scoped program narrow the base to work
-- performed in those departments. Programs also declare how approved time
-- without the scoped dimension is treated: refused (the existing behaviour)
-- or excluded from the base.
ALTER TABLE public.hrm_benefit_program_scopes ADD COLUMN IF NOT EXISTS customer_id uuid;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_program_scopes_customer_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_customer_tenant_fkey
    FOREIGN KEY (org_id, customer_id) REFERENCES public.parties (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED; END IF; END $$;

ALTER TABLE public.hrm_benefit_program_scopes DROP CONSTRAINT IF EXISTS hrm_benefit_program_scopes_one_entity;
ALTER TABLE public.hrm_benefit_program_scopes ADD CONSTRAINT hrm_benefit_program_scopes_one_entity CHECK (
  (department_id IS NOT NULL)::int + (project_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int = 1);

CREATE INDEX IF NOT EXISTS hrm_benefit_program_scopes_customer
  ON public.hrm_benefit_program_scopes (org_id, customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE public.hrm_benefit_programs ADD COLUMN IF NOT EXISTS unassigned_time text DEFAULT 'refuse' NOT NULL;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_benefit_programs_unassigned_time') THEN
  ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_unassigned_time
    CHECK (unassigned_time IN ('refuse','exclude')); END IF; END $$;

COMMENT ON COLUMN public.hrm_benefit_program_scopes.customer_id IS
  'Customer whose projects a project-scoped program measures.';
COMMENT ON COLUMN public.hrm_benefit_programs.unassigned_time IS
  'Approved time without the scoped project or department: refuse the measure, or exclude it from the base.';
