-- Give every native employer offering one program identity without copying its rules.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.hrm_benefit_catalog (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 insured_plan_id uuid, employer_program_id uuid, entitlement_plan_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE(org_id,id),
 CONSTRAINT benefit_catalog_one_native CHECK(num_nonnulls(insured_plan_id,employer_program_id,entitlement_plan_id)=1),
 CONSTRAINT benefit_catalog_native_identity CHECK(id=coalesce(insured_plan_id,employer_program_id,entitlement_plan_id)),
 FOREIGN KEY(org_id,insured_plan_id) REFERENCES public.hrm_benefit_plans(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,employer_program_id) REFERENCES public.hrm_benefit_programs(org_id,id) ON DELETE CASCADE,
 FOREIGN KEY(org_id,entitlement_plan_id) REFERENCES public.entitlement_plans(org_id,id) ON DELETE CASCADE
);
ALTER TABLE public.hrm_benefit_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_catalog
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_catalog IS 'openbooks:org_isolation:v1';

INSERT INTO public.hrm_benefit_catalog(id,org_id,insured_plan_id,created_at,created_by,updated_at,updated_by)
 SELECT id,org_id,id,created_at,created_by,updated_at,updated_by FROM public.hrm_benefit_plans;
INSERT INTO public.hrm_benefit_catalog(id,org_id,employer_program_id,created_at,created_by,updated_at,updated_by)
 SELECT id,org_id,id,created_at,created_by,updated_at,updated_by FROM public.hrm_benefit_programs;
INSERT INTO public.hrm_benefit_catalog(id,org_id,entitlement_plan_id,created_at,created_by,updated_at,updated_by)
 SELECT id,org_id,id,created_at,created_by,updated_at,updated_by FROM public.entitlement_plans;

CREATE FUNCTION public.benefit_catalog_attach() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 INSERT INTO public.hrm_benefit_catalog(id,org_id,insured_plan_id,employer_program_id,entitlement_plan_id,created_at,created_by,updated_at,updated_by)
 VALUES(NEW.id,NEW.org_id,
  CASE WHEN TG_TABLE_NAME='hrm_benefit_plans' THEN NEW.id END,
  CASE WHEN TG_TABLE_NAME='hrm_benefit_programs' THEN NEW.id END,
  CASE WHEN TG_TABLE_NAME='entitlement_plans' THEN NEW.id END,
  NEW.created_at,NEW.created_by,NEW.updated_at,NEW.updated_by);
 RETURN NEW;
END $func$;
CREATE TRIGGER benefit_catalog_attach_trigger AFTER INSERT ON public.hrm_benefit_plans FOR EACH ROW EXECUTE FUNCTION public.benefit_catalog_attach();
CREATE TRIGGER benefit_catalog_attach_trigger AFTER INSERT ON public.hrm_benefit_programs FOR EACH ROW EXECUTE FUNCTION public.benefit_catalog_attach();
CREATE TRIGGER benefit_catalog_attach_trigger AFTER INSERT ON public.entitlement_plans FOR EACH ROW EXECUTE FUNCTION public.benefit_catalog_attach();

CREATE FUNCTION public.benefit_catalog_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'Program identity is immutable; change its native program record instead.' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM public.hrm_benefit_plans WHERE org_id=OLD.org_id AND id=OLD.insured_plan_id)
  OR EXISTS(SELECT 1 FROM public.hrm_benefit_programs WHERE org_id=OLD.org_id AND id=OLD.employer_program_id)
  OR EXISTS(SELECT 1 FROM public.entitlement_plans WHERE org_id=OLD.org_id AND id=OLD.entitlement_plan_id) THEN
  RAISE EXCEPTION 'A program identity cannot be removed while its native offering exists; retire or delete the native program through its record action.' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $func$;
CREATE TRIGGER benefit_catalog_identity_guard_trigger BEFORE UPDATE OR DELETE ON public.hrm_benefit_catalog FOR EACH ROW EXECUTE FUNCTION public.benefit_catalog_identity_guard();

ALTER TABLE public.payroll_vacation_terms ADD COLUMN plan_id uuid;
-- The migration transaction's table lock excludes concurrent writers. Only
-- ownership metadata is backfilled; consumed financial terms stay unchanged,
-- and the upgrade records its own evidence without attributing it to a past editor.
ALTER TABLE public.payroll_vacation_terms DISABLE TRIGGER payroll_vacation_terms_history;
ALTER TABLE public.payroll_vacation_terms DISABLE TRIGGER payroll_vacation_terms_audit;
UPDATE public.payroll_vacation_terms t SET plan_id=p.id FROM public.entitlement_plans p
 WHERE p.org_id=t.org_id AND p.system_key='vacation';
ALTER TABLE public.payroll_vacation_terms ENABLE TRIGGER payroll_vacation_terms_history;
ALTER TABLE public.payroll_vacation_terms ENABLE TRIGGER payroll_vacation_terms_audit;
ALTER TABLE public.payroll_vacation_terms ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE public.payroll_vacation_terms ADD CONSTRAINT vacation_terms_plan_tenant_fkey
 FOREIGN KEY(org_id,plan_id) REFERENCES public.entitlement_plans(org_id,id);
CREATE INDEX vacation_terms_plan_employment ON public.payroll_vacation_terms(org_id,plan_id,employment_id);
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 SELECT org_id,'payroll_vacation_terms',id,'update',jsonb_build_object(
  'event','vacation_program_associated','before',jsonb_build_object('planId',null),
  'after',jsonb_build_object('planId',plan_id),'reason','Associate existing employee terms with the native vacation plan already governing payroll.'),null
 FROM public.payroll_vacation_terms;
CREATE FUNCTION public.vacation_terms_program_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.entitlement_plans p WHERE p.org_id=NEW.org_id AND p.id=NEW.plan_id AND p.system_key='vacation') THEN
  RAISE EXCEPTION 'Select this organization''s vacation program for employee vacation terms.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
  RAISE EXCEPTION 'Employee vacation program ownership is immutable; create effective-dated successor terms.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER vacation_terms_program_guard_trigger BEFORE INSERT OR UPDATE ON public.payroll_vacation_terms FOR EACH ROW EXECUTE FUNCTION public.vacation_terms_program_guard();
CREATE FUNCTION public.entitlement_program_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF ROW(NEW.unit,NEW.direction) IS DISTINCT FROM ROW(OLD.unit,OLD.direction)
  AND EXISTS(SELECT 1 FROM public.entitlement_ledger WHERE org_id=OLD.org_id AND plan_id=OLD.id) THEN
  RAISE EXCEPTION 'A program with ledger history cannot change its balance unit or direction; create a separate program.' USING ERRCODE='23514';
 END IF;
 IF NEW.system_key IS DISTINCT FROM OLD.system_key AND (
  EXISTS(SELECT 1 FROM public.payroll_vacation_terms WHERE org_id=OLD.org_id AND plan_id=OLD.id)
  OR EXISTS(SELECT 1 FROM public.entitlement_ledger WHERE org_id=OLD.org_id AND plan_id=OLD.id)) THEN
  RAISE EXCEPTION 'A program with employee terms or ledger history cannot change its engine binding; create a separate program.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $func$;
CREATE TRIGGER entitlement_program_binding_guard_trigger BEFORE UPDATE OF system_key,unit,direction ON public.entitlement_plans FOR EACH ROW EXECUTE FUNCTION public.entitlement_program_binding_guard();
SELECT public.openbooks_refresh_query_catalog();
