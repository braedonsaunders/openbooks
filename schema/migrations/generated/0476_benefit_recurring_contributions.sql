-- Price recurring benefit elections in native payroll, preserving existing
-- enrollment amounts and consumed monthly inputs as historical evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_plans ALTER COLUMN employee_cost_basis DROP NOT NULL;
ALTER TABLE public.hrm_benefit_plans ALTER COLUMN employer_cost_basis DROP NOT NULL;
ALTER TABLE public.hrm_benefit_plans ALTER COLUMN proration_basis DROP NOT NULL;
ALTER TABLE public.hrm_benefit_plans ADD COLUMN waiting_period_months integer NOT NULL DEFAULT 0 CHECK (waiting_period_months >= 0);
ALTER TABLE public.hrm_benefit_plans ADD CONSTRAINT hrm_benefit_plans_waiting_unit CHECK (waiting_period_days = 0 OR waiting_period_months = 0);

ALTER TABLE public.hrm_benefit_plans ADD COLUMN approval_mode text NOT NULL DEFAULT 'none' CHECK (approval_mode IN ('none','flows'));
UPDATE public.hrm_benefit_plans SET approval_mode=CASE WHEN requires_approval THEN 'flows' ELSE 'none' END;
ALTER TABLE public.hrm_benefit_enrollments
 ADD COLUMN flow_run_id uuid,
 ADD COLUMN submitted_by uuid,
 ADD CONSTRAINT benefit_enrollment_submitter_tenant_fkey FOREIGN KEY(org_id,submitted_by) REFERENCES public.users(org_id,id),
 ADD COLUMN submitted_at timestamptz,
 ADD COLUMN submission_snapshot jsonb CHECK (submission_snapshot IS NULL OR jsonb_typeof(submission_snapshot)='object'),
 ADD COLUMN decision_snapshot jsonb CHECK (decision_snapshot IS NULL OR jsonb_typeof(decision_snapshot)='object'),
 ADD COLUMN replaces_enrollment_id uuid,
 ADD CONSTRAINT benefit_enrollment_flow_tenant_fkey FOREIGN KEY (org_id,flow_run_id) REFERENCES public.flow_runs(org_id,id),
 ADD CONSTRAINT benefit_enrollment_replacement_tenant_fkey FOREIGN KEY (org_id,replaces_enrollment_id) REFERENCES public.hrm_benefit_enrollments(org_id,id);
ALTER TABLE public.hrm_benefit_enrollments DROP CONSTRAINT hrm_benefit_enrollments_active_plan_range_excl;
ALTER TABLE public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_active_plan_range_excl
 EXCLUDE USING gist (org_id WITH =, employment_id WITH =, plan_id WITH =, daterange(effective_from,COALESCE(effective_to,DATE '9999-12-31'),'[]') WITH &&) WHERE (status='active');
ALTER TABLE public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_proposal_range_excl
 EXCLUDE USING gist (org_id WITH =, employment_id WITH =, plan_id WITH =, daterange(effective_from,COALESCE(effective_to,DATE '9999-12-31'),'[]') WITH &&) WHERE (status IN ('elected','pending_approval'));

CREATE TABLE public.hrm_benefit_contribution_classes (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL,
 plan_id uuid NOT NULL, class_key text NOT NULL CHECK (length(trim(class_key)) > 0), name text NOT NULL CHECK (length(trim(name)) > 0),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), UNIQUE (org_id,plan_id,class_key),
 FOREIGN KEY (org_id,plan_id) REFERENCES public.hrm_benefit_plans(org_id,id)
);
CREATE TABLE public.hrm_benefit_contribution_tiers (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL, plan_id uuid NOT NULL, class_key text NOT NULL,
 minimum_service_years integer NOT NULL CHECK (minimum_service_years >= 0),
 employer_max_percent numeric(19,10) NOT NULL CHECK (employer_max_percent >= 0 AND employer_max_percent <= 100),
 employee_match_ratio numeric(19,10) NOT NULL CHECK (employee_match_ratio >= 0),
 effective_from date NOT NULL, effective_to date CHECK (effective_to >= effective_from),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), FOREIGN KEY (org_id,plan_id,class_key) REFERENCES public.hrm_benefit_contribution_classes(org_id,plan_id,class_key),
 EXCLUDE USING gist (org_id WITH =, plan_id WITH =, class_key WITH =, minimum_service_years WITH =,
 daterange(effective_from,effective_to,'[]') WITH &&)
);
ALTER TABLE public.entitlement_plans ADD CONSTRAINT entitlement_plans_benefit_tenant_unique UNIQUE(org_id,id);

CREATE TABLE public.hrm_benefit_contribution_rules (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL, plan_id uuid NOT NULL,
 rule_key text NOT NULL CHECK (length(trim(rule_key)) > 0), name text NOT NULL CHECK (length(trim(name)) > 0),
 kind text NOT NULL CHECK (kind IN ('employee_deduction','employer_contribution','taxable_non_cash')),
 pay_component_id uuid NOT NULL, basis text NOT NULL CHECK (basis IN ('per_hour','per_period','per_month','per_year','percent_of_eligible_pay')),
 rate numeric(28,10) NOT NULL CHECK (rate >= 0),
 rate_formula text NOT NULL CHECK (rate_formula IN ('elected_rate','hourly_wage_percent','matching_election')),
 hours_basis text CHECK (hours_basis IN ('all_paid','regular_paid','scheduled_paid')),
 pay_basis text CHECK (pay_basis IN ('all_cash_earnings','regular_cash_earnings')),
 months_per_year integer CHECK (months_per_year > 0 AND months_per_year <= 12),
 periods_per_year integer CHECK (periods_per_year > 0 AND periods_per_year <= 366),
 proration text NOT NULL CHECK (proration IN ('none','calendar_days')),
 run_applicability text NOT NULL DEFAULT 'regular_only' CHECK (run_applicability IN ('regular_only','all_pay_runs')),
 unpaid_period_treatment text NOT NULL DEFAULT 'charge' CHECK (unpaid_period_treatment IN ('charge','carry')),
 arrears_plan_id uuid, arrears_recovery_periods integer CHECK (arrears_recovery_periods > 0 AND arrears_recovery_periods <= 52),
 match_rule_id uuid, requires_match_eligibility boolean NOT NULL DEFAULT false, enforce_policy_cap boolean NOT NULL DEFAULT false,
 position integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
 effective_from date NOT NULL, effective_to date CHECK (effective_to >= effective_from),
 source_decimal text, provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), UNIQUE (org_id,plan_id,rule_key), UNIQUE (org_id,plan_id,id),
 FOREIGN KEY (org_id,plan_id) REFERENCES public.hrm_benefit_plans(org_id,id),
 FOREIGN KEY (org_id,pay_component_id) REFERENCES public.pay_components(org_id,id),
 FOREIGN KEY (org_id,arrears_plan_id) REFERENCES public.entitlement_plans(org_id,id),
 FOREIGN KEY (org_id,plan_id,match_rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,plan_id,id),
 CHECK (basis <> 'per_hour' OR hours_basis IS NOT NULL),
 CHECK (basis <> 'percent_of_eligible_pay' OR pay_basis IS NOT NULL),
 CHECK (basis <> 'per_month' OR months_per_year IS NOT NULL),
 CHECK ((rate_formula = 'matching_election') = (match_rule_id IS NOT NULL)),
 CHECK (rate_formula = 'elected_rate' OR basis = 'per_hour')
 ,CHECK ((arrears_plan_id IS NULL AND arrears_recovery_periods IS NULL) OR
 (arrears_plan_id IS NOT NULL AND arrears_recovery_periods IS NOT NULL AND kind = 'employee_deduction' AND unpaid_period_treatment = 'carry'))
);
CREATE TABLE public.hrm_benefit_recovery_sources (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY,org_id uuid NOT NULL,plan_id uuid NOT NULL,rule_id uuid NOT NULL,premium_rule_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid,
 UNIQUE(org_id,id),UNIQUE(org_id,plan_id,premium_rule_id),CHECK(rule_id<>premium_rule_id),
 FOREIGN KEY(org_id,plan_id,rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,plan_id,id),
 FOREIGN KEY(org_id,plan_id,premium_rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,plan_id,id)
);
ALTER TABLE public.hrm_benefit_enrollments ADD COLUMN class_key text;
ALTER TABLE public.hrm_benefit_enrollments ADD COLUMN match_eligible boolean;
ALTER TABLE public.hrm_benefit_enrollments ADD CONSTRAINT hrm_benefit_enrollments_class_tenant_fkey
 FOREIGN KEY (org_id,plan_id,class_key) REFERENCES public.hrm_benefit_contribution_classes(org_id,plan_id,class_key);
CREATE UNIQUE INDEX hrm_benefit_recovery_bank_owner_unique ON public.hrm_benefit_contribution_rules(org_id,arrears_plan_id) WHERE arrears_plan_id IS NOT NULL;

CREATE TABLE public.hrm_benefit_enrollment_terms (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL, enrollment_id uuid NOT NULL, rule_id uuid NOT NULL,
 election_mode text NOT NULL CHECK (election_mode IN ('fixed','follows_policy')),
 elected_rate numeric(28,10) CHECK (elected_rate >= 0),
 declared_periods_per_year integer CHECK (declared_periods_per_year > 0 AND declared_periods_per_year <= 366),
 effective_from date NOT NULL, effective_to date CHECK (effective_to >= effective_from),
 override_reason text, override_approved_by uuid, override_approved_at timestamptz,
 source_decimal text, provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), FOREIGN KEY (org_id,enrollment_id) REFERENCES public.hrm_benefit_enrollments(org_id,id),
 FOREIGN KEY (org_id,rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,id),
 CHECK ((election_mode = 'fixed' AND elected_rate IS NOT NULL) OR (election_mode = 'follows_policy' AND elected_rate IS NULL)),
 CHECK ((override_reason IS NULL AND override_approved_by IS NULL AND override_approved_at IS NULL) OR
 (length(trim(override_reason)) > 0 AND override_approved_by IS NOT NULL AND override_approved_at IS NOT NULL)),
 EXCLUDE USING gist (org_id WITH =, enrollment_id WITH =, rule_id WITH =, daterange(effective_from,effective_to,'[]') WITH &&)
);
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_org_id_id_unique UNIQUE (org_id,id);
CREATE TABLE public.pay_run_benefit_allocations (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL, pay_run_document_id uuid NOT NULL,
 employment_id uuid NOT NULL, employee_party_id uuid NOT NULL, enrollment_id uuid NOT NULL, rule_id uuid NOT NULL, term_id uuid NOT NULL,
 period_from date NOT NULL, period_to date NOT NULL CHECK (period_to >= period_from),
 amount numeric(19,4) NOT NULL CHECK (amount >= 0), currency char(3) NOT NULL,
 pay_stub_line_id uuid,
 source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
 status text NOT NULL DEFAULT 'calculated' CHECK (status IN ('calculated','committed','voided')),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id,id), UNIQUE (org_id,pay_run_document_id,term_id),
 FOREIGN KEY (org_id,pay_run_document_id) REFERENCES public.documents(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY (org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 FOREIGN KEY (org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY (org_id,enrollment_id) REFERENCES public.hrm_benefit_enrollments(org_id,id),
 FOREIGN KEY (org_id,rule_id) REFERENCES public.hrm_benefit_contribution_rules(org_id,id),
 FOREIGN KEY (org_id,term_id) REFERENCES public.hrm_benefit_enrollment_terms(org_id,id)
 ,CONSTRAINT pay_run_benefit_allocations_line_tenant_fkey FOREIGN KEY (org_id,pay_stub_line_id)
 REFERENCES public.pay_stub_lines(org_id,id) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE FUNCTION public.benefit_recovery_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.rule_id=OLD.rule_id AND a.status IN ('committed','voided')) THEN RAISE EXCEPTION 'Recovery source configuration has committed payroll evidence; add an effective-dated replacement recovery rule.'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=NEW.org_id AND a.rule_id=NEW.rule_id AND a.status IN ('committed','voided')) THEN RAISE EXCEPTION 'Recovery source configuration has committed payroll evidence; add an effective-dated replacement recovery rule.'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hrm_benefit_contribution_rules r WHERE r.org_id=NEW.org_id AND r.plan_id=NEW.plan_id AND r.id=NEW.rule_id AND r.kind='employee_deduction' AND r.unpaid_period_treatment='carry' AND r.arrears_plan_id IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM public.hrm_benefit_contribution_rules r WHERE r.org_id=NEW.org_id AND r.plan_id=NEW.plan_id AND r.id=NEW.premium_rule_id AND r.kind IN ('employer_contribution','taxable_non_cash') AND r.basis IN ('per_period','per_month','per_year')) THEN
  RAISE EXCEPTION 'Link a native employee recovery deduction to flat-period employer premium rules on the same plan.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_recovery_source_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_recovery_sources FOR EACH ROW EXECUTE FUNCTION public.benefit_recovery_source_guard();

ALTER TABLE public.pay_runs ADD COLUMN benefit_source_snapshot jsonb;

-- The old two sides become ordinary rules. Stored election amounts retain
-- their original basis and fixed rate; migration never re-elects a worker.
INSERT INTO public.hrm_benefit_contribution_rules
 (org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,pay_basis,months_per_year,proration,effective_from,effective_to,created_by,updated_by,provenance)
SELECT p.org_id,p.id,s.side,p.name || ' ' || s.side,s.kind,s.component,
 CASE s.basis WHEN 'percent_of_pay' THEN 'percent_of_eligible_pay' ELSE s.basis END,
 coalesce(s.rate,0),'elected_rate',CASE WHEN s.basis = 'percent_of_pay' THEN 'all_cash_earnings' END,
 CASE WHEN s.basis = 'per_month' THEN 12 END,
 CASE p.proration_basis WHEN 'daily' THEN 'calendar_days' ELSE 'none' END,
 p.effective_from,p.effective_to,p.created_by,p.updated_by,jsonb_build_object('migration','benefit_two_side_conversion','originalBasis',s.basis)
FROM public.hrm_benefit_plans p CROSS JOIN LATERAL
 (VALUES ('employee', 'employee_deduction',p.employee_pay_component_id,p.employee_cost_basis,p.employee_cost),
 ('employer','employer_contribution',p.employer_pay_component_id,p.employer_cost_basis,p.employer_cost)) s(side,kind,component,basis,rate)
WHERE s.component IS NOT NULL;
INSERT INTO public.hrm_benefit_enrollment_terms
 (org_id,enrollment_id,rule_id,election_mode,elected_rate,declared_periods_per_year,effective_from,effective_to,created_by,updated_by,source_decimal,provenance)
SELECT e.org_id,e.id,r.id,'fixed',s.amount,ps.periods_per_year,e.effective_from,e.effective_to,e.created_by,e.updated_by,s.amount::text,
 jsonb_build_object('migration','benefit_election_conversion','originalCoverageLevel',e.coverage_level_key)
FROM public.hrm_benefit_enrollments e
JOIN public.hrm_benefit_contribution_rules r ON r.org_id = e.org_id AND r.plan_id = e.plan_id
CROSS JOIN LATERAL (VALUES (CASE r.rule_key WHEN 'employee' THEN e.employee_amount_per_period ELSE e.employer_amount_per_period END)) s(amount)
LEFT JOIN public.employee_payroll_profiles pp ON pp.org_id = e.org_id AND pp.employment_id = e.employment_id
LEFT JOIN public.pay_schedules ps ON ps.org_id = pp.org_id AND ps.id = pp.pay_schedule_id
WHERE s.amount IS NOT NULL;
UPDATE public.hrm_benefit_payroll_inputs SET status = 'voided',voided_at = now(),
 void_reason = 'Recurring contributions now resolve from enrollment terms in native payroll; this unconsumed monthly queue is retained as history.',updated_at = now()
WHERE status = 'pending' AND consumed_by_run_document_id IS NULL;

CREATE FUNCTION public.benefit_recurring_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE e record; r record;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:benefit-recurring:' || NEW.org_id::text,0));
 SELECT * INTO e FROM public.hrm_benefit_enrollments WHERE org_id = NEW.org_id AND id = NEW.enrollment_id;
 SELECT * INTO r FROM public.hrm_benefit_contribution_rules WHERE org_id = NEW.org_id AND id = NEW.rule_id;
 IF e.status <> 'elected' OR e.submission_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Submitted contribution elections are immutable; change the enrollment through its record action.'; END IF;
 IF e.plan_id IS DISTINCT FROM r.plan_id THEN
  RAISE EXCEPTION 'Contribution terms must belong to a rule on the enrollment plan; select a rule from that plan.';
 END IF;
 IF NEW.effective_from < e.effective_from OR (e.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > e.effective_to)) THEN
  RAISE EXCEPTION 'Contribution terms must fit inside enrollment coverage; choose dates within that enrollment.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_recurring_subject_trigger BEFORE INSERT OR UPDATE ON public.hrm_benefit_enrollment_terms
 FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_subject_guard();

CREATE FUNCTION public.benefit_recurring_history_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE run_status text; historical_through date;
BEGIN
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='hrm_benefit_enrollment_terms' AND EXISTS (SELECT 1 FROM public.hrm_benefit_enrollments e
  WHERE e.org_id=OLD.org_id AND e.id=OLD.enrollment_id AND (e.status<>'elected' OR e.submission_snapshot IS NOT NULL)) THEN
  RAISE EXCEPTION 'Submitted contribution elections are immutable; change the enrollment through its record action.';
 END IF;
 IF TG_TABLE_NAME <> 'pay_run_benefit_allocations' AND TG_OP = 'UPDATE' THEN
  SELECT max(a.period_to) INTO historical_through FROM public.pay_run_benefit_allocations a
  WHERE a.org_id=OLD.org_id AND a.status IN ('committed','voided') AND
   CASE TG_TABLE_NAME WHEN 'hrm_benefit_enrollment_terms' THEN a.term_id=OLD.id
    WHEN 'hrm_benefit_contribution_tiers' THEN a.source_snapshot #>> '{basis,tier,id}'=OLD.id::text
    ELSE a.rule_id=OLD.id END;
  IF NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to<=OLD.effective_to)
   AND (historical_through IS NULL OR NEW.effective_to>=historical_through)
   AND (to_jsonb(NEW)-'effective_to'-'updated_at'-'updated_by')=(to_jsonb(OLD)-'effective_to'-'updated_at'-'updated_by') THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME = 'pay_run_benefit_allocations' THEN
  SELECT r.run_status INTO run_status FROM public.pay_runs r WHERE r.org_id = OLD.org_id AND r.document_id = OLD.pay_run_document_id;
  IF OLD.status IN ('committed','voided') OR run_status IN ('committed','voided') THEN
   IF TG_OP = 'UPDATE' AND NEW.status = 'voided' AND OLD.status = 'committed' AND
      (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by') = (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by') THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Committed benefit allocations are immutable; use a reversing or correcting payroll run.';
  END IF;
 ELSIF TG_TABLE_NAME = 'hrm_benefit_contribution_tiers' THEN
  IF EXISTS (SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.status IN ('committed','voided')
   AND a.source_snapshot #>> '{basis,tier,id}' = OLD.id::text) THEN
   RAISE EXCEPTION 'This contribution tier has committed payroll evidence; add an effective-dated replacement tier for future coverage.';
  END IF;
 ELSE
  IF EXISTS (SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id = OLD.org_id AND a.status IN ('committed','voided')
    AND CASE TG_TABLE_NAME WHEN 'hrm_benefit_enrollment_terms' THEN a.term_id = OLD.id ELSE a.rule_id = OLD.id END) THEN
   RAISE EXCEPTION 'This contribution configuration has committed payroll evidence; preserve it and add effective-dated replacement terms or a new rule.';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_rule_history_trigger BEFORE UPDATE OR DELETE ON public.hrm_benefit_contribution_rules FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_history_guard();
CREATE TRIGGER benefit_term_history_trigger BEFORE UPDATE OR DELETE ON public.hrm_benefit_enrollment_terms FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_history_guard();
CREATE TRIGGER benefit_tier_history_trigger BEFORE UPDATE OR DELETE ON public.hrm_benefit_contribution_tiers FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_history_guard();
CREATE TRIGGER benefit_allocation_history_trigger BEFORE UPDATE OR DELETE ON public.pay_run_benefit_allocations FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_history_guard();

CREATE FUNCTION public.benefit_enrollment_submission_source(input_org uuid,input_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $func$
select jsonb_build_object(
    'planId',p.id,'planCode',p.code,'planName',p.name,'planKind',p.kind,'approvalMode',p.approval_mode,
    'classKey',e.class_key,'matchEligible',e.match_eligible,'employmentId',e.employment_id,'legalEntityId',w.employer_subsidiary_id,
    'departmentId',(select department_id from employment_assignment_versions v where v.org_id=e.org_id and v.employment_id=e.employment_id
      and v.recorded_until is null and v.is_primary and v.effective_from<=e.effective_from and (v.effective_to is null or v.effective_to>e.effective_from) order by v.effective_from desc,v.id desc limit 1),
    'effectiveFrom',e.effective_from::text,'effectiveTo',e.effective_to::text,'replacesEnrollmentId',e.replaces_enrollment_id,'createdBy',e.created_by,
    'contributions',(select jsonb_agg(jsonb_build_object('ruleId',r.id,'name',r.name,'kind',r.kind,'basis',r.basis,'electionMode',t.election_mode,
      'electedRate',t.elected_rate::text,'policyRate',r.rate::text,'rateFormula',r.rate_formula,'effectiveFrom',t.effective_from::text,'effectiveTo',t.effective_to::text,
      'declaredPeriodsPerYear',t.declared_periods_per_year) order by r.position,t.id) from hrm_benefit_enrollment_terms t
      join hrm_benefit_contribution_rules r on r.org_id=t.org_id and r.id=t.rule_id where t.org_id=e.org_id and t.enrollment_id=e.id))
    from hrm_benefit_enrollments e join hrm_benefit_plans p on p.org_id=e.org_id and p.id=e.plan_id
    join worker_employments w on w.org_id=e.org_id and w.id=e.employment_id where e.org_id=input_org and e.id=input_id and e.status='elected';
$func$;

CREATE FUNCTION public.benefit_enrollment_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE run_row public.flow_runs%ROWTYPE; mode text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status NOT IN ('elected','waived') OR NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot IS NOT NULL OR NEW.decision_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Create a benefit election, then submit it through the plan approval setting; active coverage cannot be supplied on creation.';
  END IF;
  IF NEW.replaces_enrollment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hrm_benefit_enrollments e WHERE e.org_id=NEW.org_id AND e.id=NEW.replaces_enrollment_id AND e.employment_id=NEW.employment_id AND e.plan_id=NEW.plan_id AND e.status='active' AND e.effective_from<NEW.effective_from) THEN RAISE EXCEPTION 'A successor must replace active coverage on the same employment and plan from a later date.'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='elected' AND NEW.status IN ('pending_approval','active','cancelled') OR
  OLD.status='pending_approval' AND NEW.status IN ('active','cancelled') OR
  OLD.status='active' AND NEW.status='ended' OR OLD.status='waived' AND NEW.status='cancelled') THEN
  RAISE EXCEPTION 'This benefit lifecycle transition is not permitted; use the enrollment record actions or create a successor election.';
 END IF;
 IF (OLD.submission_snapshot IS NOT NULL OR OLD.status IN ('active','ended')) AND
  ROW(NEW.org_id,NEW.employment_id,NEW.plan_id,NEW.currency,NEW.effective_from) IS DISTINCT FROM
  ROW(OLD.org_id,OLD.employment_id,OLD.plan_id,OLD.currency,OLD.effective_from) THEN
  RAISE EXCEPTION 'Submitted coverage identity and start date are immutable; create a successor enrollment.';
 END IF;
 IF OLD.status='ended' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
  RAISE EXCEPTION 'Ended coverage dates are immutable; use a correcting successor election.';
 END IF;
 IF OLD.submission_snapshot IS NULL AND NEW.submission_snapshot IS NOT NULL THEN
  IF OLD.status<>'elected' OR NEW.submission_snapshot IS DISTINCT FROM public.benefit_enrollment_submission_source(OLD.org_id,OLD.id)
   OR NEW.submitted_by IS NULL OR NEW.submitted_by IS DISTINCT FROM NEW.updated_by OR NEW.submitted_at IS NULL THEN
   RAISE EXCEPTION 'Benefit submission must pin the current plan approval setting and exact contribution elections; submit through its record action.';
  END IF;
 END IF;
 IF OLD.submission_snapshot IS NOT NULL AND (NEW.submission_snapshot IS DISTINCT FROM OLD.submission_snapshot OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
  OR NEW.class_key IS DISTINCT FROM OLD.class_key OR NEW.match_eligible IS DISTINCT FROM OLD.match_eligible OR NEW.replaces_enrollment_id IS DISTINCT FROM OLD.replaces_enrollment_id) THEN
  RAISE EXCEPTION 'Submitted benefit evidence is immutable; change the enrollment through its record action.';
 END IF;
 IF OLD.status IN ('active','ended') AND (NEW.class_key IS DISTINCT FROM OLD.class_key OR NEW.match_eligible IS DISTINCT FROM OLD.match_eligible) THEN
  RAISE EXCEPTION 'Active contribution classification is immutable; change the enrollment through its record action.';
 END IF;
 IF OLD.decision_snapshot IS NOT NULL AND NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot THEN RAISE EXCEPTION 'Benefit approval decisions are immutable; create a successor enrollment.'; END IF;
 IF OLD.flow_run_id IS NOT NULL AND NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id THEN RAISE EXCEPTION 'Benefit workflow linkage is immutable; create a successor enrollment.'; END IF;
 IF NEW.status='active' AND OLD.status<>'active' THEN
  IF NEW.submission_snapshot IS NULL OR NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved'
   OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL OR NOT EXISTS (SELECT 1 FROM public.hrm_benefit_enrollment_terms t WHERE t.org_id=NEW.org_id AND t.enrollment_id=NEW.id) THEN
   RAISE EXCEPTION 'Coverage requires explicit contribution elections and submission evidence; submit the enrollment through its record action.';
  END IF;
 END IF;
 IF NEW.flow_run_id IS NOT NULL THEN
  SELECT * INTO run_row FROM public.flow_runs WHERE org_id=NEW.org_id AND id=NEW.flow_run_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND trigger='on_submit';
  IF NOT FOUND OR run_row.created_by IS DISTINCT FROM NEW.submitted_by OR NEW.submission_snapshot->>'approvalMode' IS DISTINCT FROM 'flows'
   OR run_row.context->>'planId' IS DISTINCT FROM NEW.plan_id::text OR run_row.context->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR run_row.context->'contributions' IS DISTINCT FROM NEW.submission_snapshot->'contributions' THEN
   RAISE EXCEPTION 'Benefit workflow evidence must match the enrollment, organization, submitter and elections; submit through its record action.';
  END IF;
 END IF;
 IF NEW.status='pending_approval' AND OLD.status<>'pending_approval' AND NEW.flow_run_id IS NULL THEN RAISE EXCEPTION 'Submit the enrollment to a configured native Flow before pending approval.'; END IF;
 IF NEW.status='active' AND OLD.status<>'active' THEN
  mode:=NEW.decision_snapshot->>'mode';
  IF mode='not_required' THEN
   IF NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot->>'approvalMode' IS DISTINCT FROM 'none'
    OR NEW.decision_snapshot->>'approvalMode' IS DISTINCT FROM 'none' OR NEW.decision_snapshot->>'planId' IS DISTINCT FROM NEW.plan_id::text THEN
    RAISE EXCEPTION 'No-approval coverage requires the pinned plan setting; submit through its record action.';
   END IF;
  ELSE
   IF NEW.flow_run_id IS NULL OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
    OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND status IN ('pending','escalated','rejected'))
    OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND status IN ('failed','running','waiting')) THEN
    RAISE EXCEPTION 'Benefit approval stages remain incomplete; complete the assigned decisions in Approvals.';
   END IF;
   IF mode='automatic' THEN
    IF run_row.status<>'completed' OR run_row.context->'submissionPolicy'->>'ungatedOutcome' IS DISTINCT FROM 'apply'
     OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id) THEN RAISE EXCEPTION 'Direct coverage needs explicit completed ungated Flow evidence.'; END IF;
   ELSIF mode='human' THEN
    IF NOT EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND status='approved' AND decided_by=NEW.updated_by AND decided_at IS NOT NULL) THEN RAISE EXCEPTION 'No native approval decision authorizes this enrollment; decide its assigned gate in Approvals.'; END IF;
   ELSE RAISE EXCEPTION 'Benefit decisions require explicit no-approval, direct Flow processing or native human approval.';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_enrollment_workflow_trigger BEFORE INSERT OR UPDATE ON public.hrm_benefit_enrollments FOR EACH ROW EXECUTE FUNCTION public.benefit_enrollment_workflow_guard();

CREATE FUNCTION public.benefit_recurring_run_transition() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
 IF OLD.run_status IN ('committed','voided') AND NEW.benefit_source_snapshot IS DISTINCT FROM OLD.benefit_source_snapshot THEN
  RAISE EXCEPTION 'Committed recurring benefit source evidence is immutable; use a correcting payroll run.';
 END IF;
 IF NEW.run_status = 'committed' AND OLD.run_status <> 'committed' THEN
  IF NEW.benefit_source_snapshot IS NULL THEN RAISE EXCEPTION 'Recurring benefit source evidence is missing; recalculate the pay run before committing.'; END IF;
  IF EXISTS (SELECT 1 FROM public.pay_run_benefit_allocations a LEFT JOIN public.pay_stub_lines l ON l.org_id=a.org_id AND l.id=a.pay_stub_line_id
    LEFT JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
    WHERE a.org_id=NEW.org_id AND a.pay_run_document_id=NEW.document_id AND a.amount>0
    AND (l.id IS NULL OR l.amount IS DISTINCT FROM a.amount OR s.pay_run_document_id IS DISTINCT FROM a.pay_run_document_id
    OR s.employment_id IS DISTINCT FROM a.employment_id OR l.component_id::text IS DISTINCT FROM (a.source_snapshot #>> '{rule,payComponentId}'))) THEN
   RAISE EXCEPTION 'A benefit allocation is missing its exact native payroll line; recalculate the pay run before committing.';
  END IF;
  UPDATE public.pay_run_benefit_allocations SET status = 'committed',updated_at = now(),updated_by = NEW.updated_by
   WHERE org_id = NEW.org_id AND pay_run_document_id = NEW.document_id AND status = 'calculated';
 ELSIF NEW.run_status = 'voided' AND OLD.run_status = 'committed' THEN
  UPDATE public.pay_run_benefit_allocations SET status = 'voided',updated_at = now(),updated_by = NEW.updated_by
   WHERE org_id = NEW.org_id AND pay_run_document_id = NEW.document_id AND status = 'committed';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_recurring_run_transition_trigger BEFORE UPDATE ON public.pay_runs
 FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_run_transition();

CREATE FUNCTION public.benefit_recurring_audit() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE row_value jsonb;
BEGIN
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP = 'DELETE' THEN row_value := to_jsonb(OLD); ELSE row_value := to_jsonb(NEW); END IF;
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 VALUES ((row_value->>'org_id')::uuid,TG_TABLE_NAME,(row_value->>'id')::uuid,lower(TG_OP),
 jsonb_build_object('before',CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,'after',CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END),
 coalesce((row_value->>'updated_by')::uuid,(row_value->>'created_by')::uuid));
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $func$;
CREATE FUNCTION public.benefit_recurring_configuration_lock() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE tenant uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN tenant := OLD.org_id; ELSE tenant := NEW.org_id; END IF;
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(tenant) THEN RETURN OLD; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:benefit-recurring:' || tenant::text,0));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $func$;
CREATE FUNCTION public.benefit_legacy_pricing_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
 IF ROW(NEW.employee_cost_basis,NEW.employee_cost,NEW.employer_cost_basis,NEW.employer_cost,NEW.employee_pay_component_id,NEW.employer_pay_component_id,NEW.proration_basis,NEW.requires_approval)
 IS DISTINCT FROM ROW(OLD.employee_cost_basis,OLD.employee_cost,OLD.employer_cost_basis,OLD.employer_cost,OLD.employee_pay_component_id,OLD.employer_pay_component_id,OLD.proration_basis,OLD.requires_approval) THEN
  RAISE EXCEPTION 'Two-side benefit pricing is retained as historical evidence; configure native contribution rules for future elections.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_legacy_pricing_trigger BEFORE UPDATE ON public.hrm_benefit_plans FOR EACH ROW EXECUTE FUNCTION public.benefit_legacy_pricing_guard();
CREATE FUNCTION public.benefit_monthly_queue_retired() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
 RAISE EXCEPTION 'Monthly benefit input generation has been replaced by native pay-run calculation; record enrollment contribution terms and calculate the pay run.';
END $func$;
CREATE TRIGGER benefit_monthly_queue_retired_trigger BEFORE INSERT ON public.hrm_benefit_payroll_inputs FOR EACH ROW EXECUTE FUNCTION public.benefit_monthly_queue_retired();
DO $func$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['hrm_benefit_contribution_classes','hrm_benefit_contribution_tiers','hrm_benefit_contribution_rules','hrm_benefit_recovery_sources','hrm_benefit_enrollment_terms','pay_run_benefit_allocations'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text = current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting(''app.current_org'',true))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
  EXECUTE format('CREATE TRIGGER benefit_recurring_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_audit()',tbl);
  IF tbl <> 'pay_run_benefit_allocations' THEN
   EXECUTE format('CREATE TRIGGER benefit_recurring_configuration_lock_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_configuration_lock()',tbl);
  END IF;
 END LOOP;
END $func$;
CREATE TRIGGER benefit_enrollment_configuration_lock_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_enrollments FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_configuration_lock();
CREATE TRIGGER benefit_plan_configuration_lock_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_plans FOR EACH ROW EXECUTE FUNCTION public.benefit_recurring_configuration_lock();
SELECT public.openbooks_refresh_query_catalog();
