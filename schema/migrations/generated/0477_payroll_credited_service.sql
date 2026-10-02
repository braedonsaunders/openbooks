-- Preserve observed credited service independently of hire dates, and resolve
-- vacation money and annual time entitlements from effective-dated schedules.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.payroll_vacation_terms (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id), employment_id uuid NOT NULL,
 method text NOT NULL CHECK (method IN ('accrue','pay_each_period','paid_leave')),
 percent_floor numeric(7,4) CHECK (percent_floor >= 0), annual_days_floor numeric(12,4) CHECK (annual_days_floor >= 0),
 effective_from date NOT NULL, effective_to date CHECK (effective_to >= effective_from),
 reason text NOT NULL CHECK (length(trim(reason)) > 0), source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_snapshot) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES public.users(id), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES public.users(id),
 UNIQUE (org_id,id), FOREIGN KEY (org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 CHECK (method <> 'paid_leave' OR percent_floor IS NULL OR percent_floor = 0),
 CHECK (effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
 EXCLUDE USING gist (org_id WITH =, employment_id WITH =, daterange(effective_from,effective_to,'[]') WITH &&)
);
INSERT INTO public.payroll_vacation_terms(org_id,employment_id,method,percent_floor,effective_from,reason,source_snapshot,created_by,updated_by)
 SELECT org_id,employment_id,vacation_method,vacation_percent,'0001-01-01','Preserved payroll profile vacation terms',
 jsonb_build_object('source','payroll_profile','profileId',id,'percent',vacation_percent,'method',vacation_method),created_by,updated_by
 FROM public.employee_payroll_profiles WHERE employment_id IS NOT NULL;
ALTER TABLE public.employee_payroll_profiles ALTER COLUMN vacation_percent DROP DEFAULT;
ALTER TABLE public.employee_payroll_profiles ALTER COLUMN vacation_percent DROP NOT NULL;
ALTER TABLE public.employee_payroll_profiles ALTER COLUMN vacation_method DROP DEFAULT;
ALTER TABLE public.employee_payroll_profiles ALTER COLUMN vacation_method DROP NOT NULL;
ALTER TABLE public.payroll_vacation_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_vacation_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_vacation_terms
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.payroll_vacation_terms IS 'openbooks:org_isolation:v1';
CREATE INDEX payroll_vacation_terms_employment ON public.payroll_vacation_terms(org_id,employment_id,effective_from);
CREATE FUNCTION public.payroll_profile_vacation_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.vacation_percent IS NOT NULL OR NEW.vacation_method IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Configure vacation through employee Vacation terms; new payroll profiles contain tax and payroll delivery facts only.';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.vacation_percent,NEW.vacation_method) IS DISTINCT FROM (OLD.vacation_percent,OLD.vacation_method) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Vacation policy belongs to effective-dated employee Vacation terms. Edit those terms; payroll profile vacation fields preserve historical evidence.';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER payroll_profile_vacation_evidence BEFORE INSERT OR UPDATE OF vacation_percent,vacation_method ON public.employee_payroll_profiles FOR EACH ROW EXECUTE FUNCTION public.payroll_profile_vacation_evidence_guard();

CREATE TABLE public.payroll_service_credits (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 employment_id uuid NOT NULL, convention text NOT NULL CHECK (convention IN ('calendar_months','actual_365')),
 as_of_date date NOT NULL, credited_days numeric(30,16), credited_months integer,
 effective_from date NOT NULL, effective_to date CHECK (effective_to >= effective_from),
 reason text NOT NULL CHECK (length(trim(reason)) > 0), source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_snapshot) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES public.users(id),
 CHECK (as_of_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
 AND effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
 AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')),
 UNIQUE (org_id,id), FOREIGN KEY (org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 CHECK ((convention = 'calendar_months' AND credited_months IS NOT NULL AND credited_months >= 0 AND credited_days IS NULL)
 OR (convention = 'actual_365' AND credited_days IS NOT NULL AND credited_days >= 0 AND credited_months IS NULL)),
 EXCLUDE USING gist (org_id WITH =, employment_id WITH =, daterange(effective_from,effective_to,'[]') WITH &&)
);
CREATE INDEX payroll_service_credits_employment ON public.payroll_service_credits(org_id,employment_id,effective_from);
ALTER TABLE public.payroll_service_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_service_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_service_credits
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.payroll_service_credits IS 'openbooks:org_isolation:v1';

CREATE UNIQUE INDEX IF NOT EXISTS entitlement_plans_org_id_id_unique ON public.entitlement_plans(org_id,id);
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_plan_tenant_fkey FOREIGN KEY (org_id,plan_id) REFERENCES public.entitlement_plans(org_id,id);
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_component_tenant_fkey FOREIGN KEY (org_id,component_id) REFERENCES public.pay_components(org_id,id);

ALTER TABLE public.entitlement_service_tiers ADD COLUMN employer_subsidiary_id uuid;
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_employer_tenant_fkey FOREIGN KEY (org_id,employer_subsidiary_id) REFERENCES public.subsidiaries(org_id,id);
CREATE INDEX entitlement_service_tiers_employer ON public.entitlement_service_tiers(org_id,employer_subsidiary_id,plan_id,component_id,after_months);
ALTER TABLE public.entitlement_service_tiers ADD COLUMN effective_from date NOT NULL DEFAULT '0001-01-01';
ALTER TABLE public.entitlement_service_tiers ADD COLUMN effective_to date;
ALTER TABLE public.entitlement_service_tiers ADD COLUMN annual_days numeric(12,4) CHECK (annual_days >= 0);
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_effective_range CHECK (effective_to >= effective_from);
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_finite_dates CHECK (
 effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
 AND (effective_to IS NULL OR effective_to BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'));
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_days_target CHECK (annual_days IS NULL OR plan_id IS NOT NULL);
DROP INDEX public.entitlement_service_tiers_target_months;
ALTER TABLE public.entitlement_service_tiers ADD CONSTRAINT entitlement_service_tiers_no_overlap EXCLUDE USING gist
 (org_id WITH =, coalesce(employer_subsidiary_id,'00000000-0000-0000-0000-000000000000'::uuid) WITH =, coalesce(plan_id,'00000000-0000-0000-0000-000000000000'::uuid) WITH =,
 coalesce(component_id,'00000000-0000-0000-0000-000000000000'::uuid) WITH =, after_months WITH =,
 daterange(effective_from,effective_to,'[]') WITH &&) WHERE (is_active);

CREATE FUNCTION public.payroll_service_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE last_period_end date; target_org uuid; configurations jsonb;
BEGIN
 target_org := CASE WHEN TG_OP = 'INSERT' THEN NEW.org_id ELSE OLD.org_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:payroll-service:' || target_org::text,0));
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 configurations := CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
  WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END;
 SELECT max(r.period_end) INTO last_period_end FROM public.pay_runs r JOIN public.pay_stubs s
  ON s.org_id = r.org_id AND s.pay_run_document_id = r.document_id
 LEFT JOIN public.worker_employments e ON e.org_id=s.org_id AND e.id=s.employment_id
 WHERE r.org_id = target_org AND r.run_status IN ('committed','voided') AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(configurations) cfg
  WHERE (cfg->>'employment_id' IS NULL OR s.employment_id=(cfg->>'employment_id')::uuid)
    AND (cfg->>'employer_subsidiary_id' IS NULL OR e.employer_subsidiary_id IS NULL OR e.employer_subsidiary_id=(cfg->>'employer_subsidiary_id')::uuid)
    AND r.period_end >= (cfg->>'effective_from')::date
    AND (cfg->>'effective_to' IS NULL OR r.period_end <= (cfg->>'effective_to')::date)
 );
 IF last_period_end IS NOT NULL THEN
  IF TG_OP IN ('INSERT','DELETE') THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This service configuration affects committed payroll evidence. Preserve its terms and add a replacement effective after the last committed period end.';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['effective_to','updated_at','updated_by']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['effective_to','updated_at','updated_by']) OR NEW.effective_to IS NULL OR NEW.effective_to < last_period_end THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This service configuration has committed payroll evidence. Preserve its terms, close its window on or after the last committed period end, and add an effective-dated replacement.';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $func$;
CREATE TRIGGER payroll_vacation_terms_history BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_vacation_terms FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_guard();
CREATE TRIGGER payroll_service_credits_history BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_service_credits FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_guard();
CREATE TRIGGER entitlement_service_tiers_history BEFORE INSERT OR UPDATE OR DELETE ON public.entitlement_service_tiers FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_guard();
CREATE FUNCTION public.payroll_service_configuration_audit() RETURNS trigger LANGUAGE plpgsql AS $func$
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
CREATE TRIGGER payroll_vacation_terms_audit AFTER INSERT OR UPDATE OR DELETE ON public.payroll_vacation_terms FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_audit();
CREATE TRIGGER payroll_service_credits_audit AFTER INSERT OR UPDATE OR DELETE ON public.payroll_service_credits FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_audit();
CREATE TRIGGER entitlement_service_tiers_audit AFTER INSERT OR UPDATE OR DELETE ON public.entitlement_service_tiers FOR EACH ROW EXECUTE FUNCTION public.payroll_service_configuration_audit();
SELECT public.openbooks_refresh_query_catalog();
