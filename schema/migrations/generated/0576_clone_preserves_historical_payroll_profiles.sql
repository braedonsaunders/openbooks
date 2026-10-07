-- Preserve historical vacation evidence when copying existing payroll profiles.
-- New profiles still use dated Vacation terms, and retained evidence stays
-- immutable. Only a native copy of the exact source profile may carry it.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.payroll_profile_vacation_evidence_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.vacation_percent IS NOT NULL OR NEW.vacation_method IS NOT NULL THEN
   IF public.openbooks_clone_authority() AND EXISTS (
    SELECT 1 FROM public.orgs target
    JOIN public.sandboxes control ON control.org_id = target.id
      AND control.production_org_id = target.sandbox_of
    JOIN public.orgs source ON source.id = target.sandbox_of
    JOIN public.employee_payroll_profiles original ON original.org_id = source.id
      AND public.ob_rebase(original.id, target.sandbox_seed) = NEW.id
    WHERE target.id = NEW.org_id AND target.env_kind = 'sandbox'
      AND target.sandbox_seed IS NOT NULL
      AND public.ob_rebase(original.employee_party_id, target.sandbox_seed) = NEW.employee_party_id
      AND public.ob_rebase(original.employment_id, target.sandbox_seed) IS NOT DISTINCT FROM NEW.employment_id
      AND public.ob_rebase(original.pay_schedule_id, target.sandbox_seed) = NEW.pay_schedule_id
      AND original.vacation_percent IS NOT DISTINCT FROM NEW.vacation_percent
      AND original.vacation_method IS NOT DISTINCT FROM NEW.vacation_method
   ) THEN RETURN NEW; END IF;
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Configure vacation through employee Vacation terms; new payroll profiles contain tax and payroll delivery facts only.';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.vacation_percent,NEW.vacation_method) IS DISTINCT FROM (OLD.vacation_percent,OLD.vacation_method) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Vacation policy belongs to effective-dated employee Vacation terms. Edit those terms; payroll profile vacation fields preserve historical evidence.';
 END IF;
 RETURN NEW;
END $function$;
