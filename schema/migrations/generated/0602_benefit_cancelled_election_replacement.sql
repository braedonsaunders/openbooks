-- Retain cancelled election history without preventing normally approved replacement coverage.
ALTER TABLE ONLY public.hrm_benefit_enrollments
  DROP CONSTRAINT hrm_benefit_enrollments_employment_plan_from_unique;
CREATE UNIQUE INDEX hrm_benefit_enrollments_employment_plan_from_unique
  ON public.hrm_benefit_enrollments (org_id, employment_id, plan_id, effective_from)
  WHERE status <> 'cancelled';
