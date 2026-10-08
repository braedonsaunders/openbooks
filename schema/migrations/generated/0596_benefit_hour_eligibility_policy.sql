-- Hourly contributions may explicitly select eligibility at the pay-period end.
-- Existing policies retain earning-date allocation and all submitted evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_contribution_rules
 ADD COLUMN hours_coverage text NOT NULL DEFAULT 'earned_dates',
 ADD CONSTRAINT hrm_benefit_contribution_hours_coverage CHECK
  (hours_coverage IN ('earned_dates','pay_period_end') AND (hours_coverage='earned_dates' OR basis='per_hour'));

CREATE FUNCTION public.benefit_hours_coverage_election_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF NEW.hours_coverage IS DISTINCT FROM OLD.hours_coverage AND EXISTS (
  SELECT 1 FROM public.hrm_benefit_enrollment_terms t
  JOIN public.hrm_benefit_enrollments e ON e.org_id=t.org_id AND e.id=t.enrollment_id
  WHERE t.org_id=OLD.org_id AND t.rule_id=OLD.id AND e.submission_snapshot IS NOT NULL
 ) THEN
  RAISE EXCEPTION 'Hour eligibility has submitted election evidence; preserve the rule and create an effective-dated replacement with new election terms.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_hours_coverage_election_trigger BEFORE UPDATE OF hours_coverage
 ON public.hrm_benefit_contribution_rules FOR EACH ROW EXECUTE FUNCTION public.benefit_hours_coverage_election_guard();

CREATE OR REPLACE FUNCTION public.benefit_enrollment_submission_source(input_org uuid,input_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $func$
select jsonb_build_object(
    'planId',p.id,'planCode',p.code,'planName',p.name,'planKind',p.kind,'approvalMode',p.approval_mode,
    'classKey',e.class_key,'matchEligible',e.match_eligible,'employmentId',e.employment_id,'legalEntityId',w.employer_subsidiary_id,
    'departmentId',(select department_id from employment_assignment_versions v where v.org_id=e.org_id and v.employment_id=e.employment_id
      and v.recorded_until is null and v.is_primary and v.effective_from<=e.effective_from and (v.effective_to is null or v.effective_to>e.effective_from) order by v.effective_from desc,v.id desc limit 1),
    'effectiveFrom',e.effective_from::text,'effectiveTo',e.effective_to::text,'replacesEnrollmentId',e.replaces_enrollment_id,'createdBy',e.created_by,
    'contributions',(select jsonb_agg(jsonb_build_object('ruleId',r.id,'name',r.name,'kind',r.kind,'basis',r.basis,'electionMode',t.election_mode,
      'electedRate',t.elected_rate::text,'policyRate',r.rate::text,'rateFormula',r.rate_formula,'hoursCoverage',r.hours_coverage,'effectiveFrom',t.effective_from::text,'effectiveTo',t.effective_to::text,
      'declaredPeriodsPerYear',t.declared_periods_per_year) order by r.position,t.id) from hrm_benefit_enrollment_terms t
      join hrm_benefit_contribution_rules r on r.org_id=t.org_id and r.id=t.rule_id where t.org_id=e.org_id and t.enrollment_id=e.id))
    from hrm_benefit_enrollments e join hrm_benefit_plans p on p.org_id=e.org_id and p.id=e.plan_id
    join worker_employments w on w.org_id=e.org_id and w.id=e.employment_id where e.org_id=input_org and e.id=input_id and e.status='elected';
$func$;
