-- OpenBooks forward migration 0362_payroll_work_location_allocations.
-- Capture work jurisdiction at the approved time-entry and employment-period
-- allocation sources consumed by statutory payroll.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.time_entries
  ADD COLUMN work_region text,
  ADD COLUMN work_subregion text,
  ADD COLUMN work_region_source text,
  ADD COLUMN work_region_reason text;

ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_work_region_source CHECK (
    (work_region IS NULL AND work_region_source IS NULL AND work_subregion IS NULL)
    OR (work_region IS NOT NULL AND work_region_source IS NOT NULL AND work_region_source IN
      ('project_site', 'payroll_profile', 'hr_override', 'imported_record'))
  ),
  ADD CONSTRAINT time_entries_work_region_override_reason CHECK (
    work_region_source <> 'hr_override'
    OR nullif(btrim(work_region_reason), '') IS NOT NULL
  );

CREATE INDEX time_entries_payroll_work_region
  ON public.time_entries (org_id, employee_party_id, worked_on, work_region)
  WHERE status = 'approved';

CREATE FUNCTION public.time_entries_default_work_region()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_site text;
  v_profile_region text;
BEGIN
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

CREATE TRIGGER time_entries_default_work_region
  BEFORE INSERT OR UPDATE OF work_region, work_subregion, work_region_source, work_region_reason
  ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.time_entries_default_work_region();

CREATE TABLE public.payroll_work_location_allocations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  employment_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  region text NOT NULL,
  subregion text,
  service_days integer,
  work_share numeric(12,10),
  source text NOT NULL,
  evidence_document_id uuid,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_work_location_allocations_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_work_location_allocations_org_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_work_location_allocations_employment_fkey
    FOREIGN KEY (org_id, employment_id)
    REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_work_location_allocations_evidence_fkey
    FOREIGN KEY (org_id, evidence_document_id)
    REFERENCES public.documents(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_work_location_allocations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT payroll_work_location_allocations_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT payroll_work_location_allocations_period CHECK (period_start <= period_end),
  CONSTRAINT payroll_work_location_allocations_days_in_period CHECK (
    service_days IS NULL OR service_days <= period_end - period_start + 1
  ),
  CONSTRAINT payroll_work_location_allocations_measure CHECK (
    (service_days IS NOT NULL AND service_days >= 0 AND work_share IS NULL)
    OR (service_days IS NULL AND work_share IS NOT NULL AND work_share BETWEEN 0 AND 1)
  ),
  CONSTRAINT payroll_work_location_allocations_source CHECK
    (source IN ('hr_records', 'certificate', 'adequate_records')),
  CONSTRAINT payroll_work_location_allocations_reason CHECK (length(btrim(change_reason)) > 0),
  CONSTRAINT payroll_work_location_allocations_org_id_unique UNIQUE (org_id, id)
);

ALTER TABLE public.payroll_work_location_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_work_location_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_work_location_allocations
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

CREATE UNIQUE INDEX payroll_work_location_allocations_period_region
  ON public.payroll_work_location_allocations
    (org_id, employment_id, period_start, period_end, region, coalesce(subregion, ''));
CREATE INDEX payroll_work_location_allocations_employment_period
  ON public.payroll_work_location_allocations (org_id, employment_id, period_start, period_end);

CREATE FUNCTION public.payroll_work_location_allocation_lock_committed()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org uuid := coalesce(NEW.org_id, OLD.org_id);
  v_employment uuid := coalesce(NEW.employment_id, OLD.employment_id);
  v_start date := coalesce(NEW.period_start, OLD.period_start);
  v_end date := coalesce(NEW.period_end, OLD.period_end);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pay_stubs s
    JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
    WHERE s.org_id = v_org AND s.employment_id = v_employment
      AND r.period_start = v_start AND r.period_end = v_end
      AND r.run_status = 'committed' AND d.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'Payroll work allocation is locked because a payroll run for this employment period is committed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER payroll_work_location_allocation_lock_committed
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_work_location_allocations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_work_location_allocation_lock_committed();

CREATE FUNCTION public.payroll_work_location_allocation_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_row public.payroll_work_location_allocations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
  VALUES (
    v_row.org_id,
    'payroll_work_location_allocations',
    v_row.id,
    lower(TG_OP),
    jsonb_build_object(
      'before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
      'after', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
      'reason', v_row.change_reason
    ),
    coalesce(v_row.updated_by, v_row.created_by)
  );
  RETURN NULL;
END
$function$;

CREATE TRIGGER payroll_work_location_allocation_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.payroll_work_location_allocations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_work_location_allocation_audit();

COMMENT ON TABLE public.payroll_work_location_allocations IS
  'HR-entered work jurisdiction evidence for employments without approved timed work. Locked after the matching payroll period commits.';
COMMENT ON COLUMN public.payroll_work_location_allocations.evidence_document_id IS
  'Optional uploaded or filed evidence document supporting this location allocation.';
COMMENT ON COLUMN public.time_entries.work_region IS
  'Jurisdiction of service. New entries default from project site jurisdiction, then employee payroll profile; HR corrections require a reason and are audited. Approved service dates feed payroll day counts.';

SELECT public.openbooks_refresh_query_catalog();
