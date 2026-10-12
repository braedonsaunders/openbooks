-- Explicit employment-spell and source identity for Record of Employment declarations.
SET statement_timeout = 0;
SET search_path = public, pg_catalog;

ALTER TABLE public.payroll_roe_separation_events
  ADD COLUMN employment_id uuid,
  ADD COLUMN subsidiary_id uuid,
  ADD COLUMN first_day_worked date,
  ADD COLUMN source_reference text,
  ADD CONSTRAINT payroll_roe_separation_events_employment_fkey
    FOREIGN KEY (org_id, employment_id) REFERENCES public.worker_employments(org_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_roe_separation_events_employer_fkey
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT payroll_roe_separation_events_employer_pair
    CHECK ((employment_id IS NULL) = (subsidiary_id IS NULL)),
  ADD CONSTRAINT payroll_roe_separation_events_first_worked
    CHECK (first_day_worked IS NULL OR first_day_worked <= last_insurable_earnings_on),
  ADD CONSTRAINT payroll_roe_separation_events_source_reference
    CHECK (source_reference IS NULL OR length(btrim(source_reference)) BETWEEN 1 AND 2000);

COMMENT ON COLUMN public.payroll_roe_separation_events.first_day_worked IS
  'Employer-declared first day worked in this employment spell; not inferred from hire date or the first stored pay stub.';
COMMENT ON COLUMN public.payroll_roe_separation_events.source_reference IS
  'Original employer separation evidence supporting the declared dates, retained with the change audit.';

CREATE FUNCTION public.payroll_roe_separation_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE recorded boolean;
BEGIN
  IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.payroll_filing_submission_slips sl
      JOIN public.payroll_filing_submissions f ON f.org_id=sl.org_id AND f.id=sl.submission_id
      WHERE sl.org_id=OLD.org_id AND sl.row_id=OLD.employee_party_id::text
        AND f.country='CA' AND f.filing_key='roe'
    ) INTO recorded;
    IF OLD.status='issued' OR recorded THEN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Issued Record of Employment separation facts must be retained; use the Service Canada correction workflow'
          USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_issued';
      END IF;
      IF ROW(NEW.org_id,NEW.employee_party_id,NEW.employment_id,NEW.subsidiary_id,NEW.first_day_worked,
          NEW.interruption_on,NEW.last_insurable_earnings_on,NEW.salary_continuance_end_on,NEW.source_reference,NEW.change_reason)
        IS DISTINCT FROM ROW(OLD.org_id,OLD.employee_party_id,OLD.employment_id,OLD.subsidiary_id,OLD.first_day_worked,
          OLD.interruption_on,OLD.last_insurable_earnings_on,OLD.salary_continuance_end_on,OLD.source_reference,OLD.change_reason)
        OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'issued') THEN
        RAISE EXCEPTION 'Issued Record of Employment separation facts are immutable; use the Service Canada correction workflow'
          USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_issued';
      END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.employment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.worker_employments e
    WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
      AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id
  ) THEN
    RAISE EXCEPTION 'Record of Employment facts must identify the selected employee, native employment and legal employer'
      USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_separation_facts_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_separation_events
FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_separation_facts_guard();
