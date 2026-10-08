-- Preserve recorded unknown work jurisdictions in registered native sandbox
-- copies. New work retains project/profile defaults, and jurisdiction changes
-- retain the HR reason, audit and committed-payroll protections.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.time_entries_default_work_region()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_site text;
  v_profile_region text;
BEGIN
  -- Copying recorded work is not a new jurisdiction declaration. The
  -- privileged native clone scope and registered source relationship only
  -- suppress today's defaults; every reference and payroll guard still runs.
  IF TG_OP = 'INSERT' AND NEW.work_region IS NULL
     AND public.openbooks_clone_authority()
     AND EXISTS (
       SELECT 1 FROM public.orgs target
       JOIN public.sandboxes control ON control.org_id = target.id
        AND control.production_org_id = target.sandbox_of
       JOIN public.orgs source ON source.id = target.sandbox_of
       WHERE target.id = NEW.org_id AND target.env_kind = 'sandbox'
         AND target.sandbox_seed IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.work_region IS NULL THEN
    IF NEW.project_id IS NOT NULL THEN
      SELECT p.site_jurisdiction INTO v_site
        FROM public.projects p
       WHERE p.org_id = NEW.org_id AND p.id = NEW.project_id;
    END IF;
    IF v_site IS NOT NULL THEN
      NEW.work_region := CASE WHEN v_site LIKE '%-%'
        THEN split_part(v_site, '-', 2) ELSE v_site END;
      NEW.work_region_source := 'project_site';
    ELSE
      SELECT ep.province INTO v_profile_region
        FROM public.employee_payroll_profiles ep
       WHERE ep.org_id = NEW.org_id AND ep.employee_party_id = NEW.employee_party_id
       ORDER BY ep.updated_at DESC, ep.id
       LIMIT 1;
      IF v_profile_region IS NOT NULL THEN
        NEW.work_region := v_profile_region;
        NEW.work_region_source := 'payroll_profile';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND
     (NEW.work_region, NEW.work_subregion) IS DISTINCT FROM
     (OLD.work_region, OLD.work_subregion) THEN
    IF EXISTS (
      SELECT 1 FROM public.pay_stubs s
      JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      WHERE s.org_id = NEW.org_id AND s.employee_party_id = NEW.employee_party_id
        AND NEW.worked_on BETWEEN r.period_start AND r.period_end
        AND r.run_status = 'committed' AND d.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'Payroll work jurisdiction is locked because a payroll run covering this service date is committed'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.work_region_source IS DISTINCT FROM 'hr_override'
       OR nullif(btrim(NEW.work_region_reason), '') IS NULL THEN
      RAISE EXCEPTION 'Changing a time entry work jurisdiction requires an HR override reason'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
    VALUES (NEW.org_id, 'time_entries', NEW.id, 'work_jurisdiction_override',
      jsonb_build_object('before', jsonb_build_object('region', OLD.work_region, 'subregion', OLD.work_subregion),
                         'after', jsonb_build_object('region', NEW.work_region, 'subregion', NEW.work_subregion),
                         'reason', NEW.work_region_reason), NEW.updated_by);
  END IF;
  RETURN NEW;
END
$function$;
