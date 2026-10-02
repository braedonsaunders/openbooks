-- Preserve coverage debt while handing a native recovery bank to a future
-- contribution rule. Effective ownership cannot overlap.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX public.hrm_benefit_recovery_bank_owner_unique;
ALTER TABLE public.hrm_benefit_contribution_rules ADD CONSTRAINT hrm_benefit_recovery_bank_owner_range_excl
 EXCLUDE USING gist (org_id WITH =, arrears_plan_id WITH =,
  daterange(effective_from,COALESCE(effective_to,DATE '9999-12-31'),'[]') WITH &&)
 WHERE (arrears_plan_id IS NOT NULL);
ALTER TABLE public.hrm_benefit_recovery_sources DROP CONSTRAINT hrm_benefit_recovery_sources_org_id_plan_id_premium_rule_id_key;
ALTER TABLE public.hrm_benefit_recovery_sources ADD CONSTRAINT hrm_benefit_recovery_source_rule_unique UNIQUE(org_id,rule_id,premium_rule_id);
CREATE OR REPLACE FUNCTION public.benefit_recovery_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP IN ('UPDATE','DELETE') AND EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.rule_id=OLD.rule_id AND a.status IN ('committed','voided')) THEN RAISE EXCEPTION 'Recovery source configuration has committed payroll evidence; add an effective-dated replacement recovery rule.'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=NEW.org_id AND a.rule_id=NEW.rule_id AND a.status IN ('committed','voided')) THEN RAISE EXCEPTION 'Recovery source configuration has committed payroll evidence; add an effective-dated replacement recovery rule.'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hrm_benefit_contribution_rules r WHERE r.org_id=NEW.org_id AND r.plan_id=NEW.plan_id AND r.id=NEW.rule_id AND r.kind='employee_deduction' AND r.unpaid_period_treatment='carry' AND r.arrears_plan_id IS NOT NULL)
  OR NOT EXISTS(SELECT 1 FROM public.hrm_benefit_contribution_rules r WHERE r.org_id=NEW.org_id AND r.plan_id=NEW.plan_id AND r.id=NEW.premium_rule_id AND r.kind IN ('employer_contribution','taxable_non_cash') AND r.basis IN ('per_period','per_month','per_year')) THEN
  RAISE EXCEPTION 'Link a native employee recovery deduction to flat-period employer premium rules on the same plan.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.hrm_benefit_recovery_sources s
  JOIN public.hrm_benefit_contribution_rules prior_rule ON prior_rule.org_id=s.org_id AND prior_rule.id=s.rule_id
  JOIN public.hrm_benefit_contribution_rules new_rule ON new_rule.org_id=NEW.org_id AND new_rule.id=NEW.rule_id
  WHERE s.org_id=NEW.org_id AND s.premium_rule_id=NEW.premium_rule_id AND s.id<>NEW.id AND
   daterange(prior_rule.effective_from,COALESCE(prior_rule.effective_to,DATE '9999-12-31'),'[]') && daterange(new_rule.effective_from,COALESCE(new_rule.effective_to,DATE '9999-12-31'),'[]')) THEN
  RAISE EXCEPTION 'An insured premium already has a recovery owner during these dates; close the prior recovery rule before linking its successor.';
 END IF;
 RETURN NEW;
END $func$;
CREATE FUNCTION public.benefit_recovery_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF EXISTS(SELECT 1 FROM public.hrm_benefit_recovery_sources s WHERE s.org_id=NEW.org_id AND s.rule_id=NEW.id)
  AND (NEW.kind<>'employee_deduction' OR NEW.unpaid_period_treatment<>'carry' OR NEW.arrears_plan_id IS NULL) THEN
  RAISE EXCEPTION 'This rule owns insured premium recovery; preserve its native carry deduction or replace the effective-dated rule.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.hrm_benefit_recovery_sources s WHERE s.org_id=NEW.org_id AND s.premium_rule_id=NEW.id)
  AND (NEW.kind NOT IN ('employer_contribution','taxable_non_cash') OR NEW.basis NOT IN ('per_period','per_month','per_year')) THEN
  RAISE EXCEPTION 'This insured premium is linked to recovery; preserve its flat employer premium treatment or replace the effective-dated rule.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.hrm_benefit_recovery_sources a JOIN public.hrm_benefit_recovery_sources b
  ON b.org_id=a.org_id AND b.premium_rule_id=a.premium_rule_id AND b.rule_id<>a.rule_id
  JOIN public.hrm_benefit_contribution_rules prior_rule ON prior_rule.org_id=b.org_id AND prior_rule.id=b.rule_id
  WHERE a.org_id=NEW.org_id AND a.rule_id=NEW.id AND
   daterange(prior_rule.effective_from,COALESCE(prior_rule.effective_to,DATE '9999-12-31'),'[]') && daterange(NEW.effective_from,COALESCE(NEW.effective_to,DATE '9999-12-31'),'[]')) THEN
  RAISE EXCEPTION 'Insured premium recovery ownership dates overlap; close the prior rule before the successor begins.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_recovery_rule_trigger BEFORE UPDATE ON public.hrm_benefit_contribution_rules FOR EACH ROW EXECUTE FUNCTION public.benefit_recovery_rule_guard();
CREATE OR REPLACE FUNCTION public.benefit_recurring_history_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE run_status text; historical_through date;
BEGIN
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='hrm_benefit_enrollment_terms' THEN
  IF EXISTS (SELECT 1 FROM public.hrm_benefit_enrollments e
  WHERE e.org_id=OLD.org_id AND e.id=OLD.enrollment_id AND (e.status<>'elected' OR e.submission_snapshot IS NOT NULL)) THEN
   RAISE EXCEPTION 'Submitted contribution elections are immutable; change the enrollment through its record action.' USING ERRCODE='23514';
  END IF;
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
   RAISE EXCEPTION 'Committed benefit allocations are immutable; use a reversing or correcting payroll run.' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'hrm_benefit_contribution_tiers' THEN
  IF EXISTS (SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.status IN ('committed','voided')
   AND a.source_snapshot #>> '{basis,tier,id}' = OLD.id::text) THEN
   RAISE EXCEPTION 'This contribution tier has committed payroll evidence; add an effective-dated replacement tier for future coverage.' USING ERRCODE='23514';
  END IF;
 ELSE
  IF EXISTS (SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id = OLD.org_id AND a.status IN ('committed','voided')
    AND CASE TG_TABLE_NAME WHEN 'hrm_benefit_enrollment_terms' THEN a.term_id = OLD.id ELSE a.rule_id = OLD.id END) THEN
   RAISE EXCEPTION 'This contribution configuration has committed payroll evidence; preserve it and add effective-dated replacement terms or a new rule.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $func$;
SELECT public.openbooks_refresh_query_catalog();
