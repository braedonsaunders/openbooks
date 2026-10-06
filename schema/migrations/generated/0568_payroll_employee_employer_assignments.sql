-- Preserve dated employee employer assignments without changing current payroll settings.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE UNIQUE INDEX worker_comp_groups_assignment_reference ON public.worker_comp_groups(org_id,id);
CREATE TABLE public.payroll_employee_employer_assignments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), employee_party_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL, assignment_kind text NOT NULL CHECK(assignment_kind IN ('filing_account','worker_comp')),
 tax_year integer NOT NULL CHECK(tax_year BETWEEN 2000 AND 2100),
 effective_from date NOT NULL, effective_to date NOT NULL,
 filing_account_id uuid, worker_comp_group_id uuid, expected_current_id uuid,
 source_reference text NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 2000),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by uuid NOT NULL,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,filing_account_id) REFERENCES public.payroll_filing_accounts(org_id,id),
 FOREIGN KEY(org_id,worker_comp_group_id) REFERENCES public.worker_comp_groups(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 CHECK(effective_to>=effective_from AND extract(year FROM effective_from)=tax_year AND extract(year FROM effective_to)=tax_year),
 CHECK((assignment_kind='filing_account' AND filing_account_id IS NOT NULL AND worker_comp_group_id IS NULL)
    OR (assignment_kind='worker_comp' AND worker_comp_group_id IS NOT NULL AND filing_account_id IS NULL)),
 EXCLUDE USING gist(org_id WITH =,employee_party_id WITH =,assignment_kind WITH =,
   daterange(effective_from,effective_to,'[]') WITH &&)
);

CREATE FUNCTION public.payroll_employee_employer_assignment_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE employee_employer uuid; employee_country text; current_id uuid;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() AND TG_OP<>'DELETE' THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Dated employer assignment evidence is immutable; retain the record and use a controlled payroll correction.';
 END IF;
 -- The same employee-wide and annual fences order setup and payroll posting.
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id||':'||NEW.employee_party_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id||':'||NEW.employee_party_id||':'||NEW.tax_year,0));
 SELECT p.subsidiary_id,prof.country,prof.filing_account_id INTO employee_employer,employee_country,current_id
  FROM public.employee_payroll_profiles prof JOIN public.parties p ON p.org_id=prof.org_id AND p.id=prof.employee_party_id
  WHERE prof.org_id=NEW.org_id AND prof.employee_party_id=NEW.employee_party_id FOR UPDATE OF prof FOR SHARE OF p;
 IF NOT FOUND OR employee_employer IS DISTINCT FROM NEW.subsidiary_id THEN
  RAISE EXCEPTION 'Choose the saved payroll employee and their own legal employer before recording an assignment.';
 END IF;
 IF NEW.assignment_kind='filing_account' THEN
  PERFORM a.id FROM public.payroll_filing_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.filing_account_id
    AND a.country=employee_country AND (a.subsidiary_id IS NULL OR a.subsidiary_id=employee_employer) AND a.is_active FOR SHARE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Choose an active filing account for the employee payroll country.';
  END IF;
 ELSE
  SELECT er.worker_comp_group_id INTO current_id FROM public.employee_roles er
   WHERE er.org_id=NEW.org_id AND er.party_id=NEW.employee_party_id ORDER BY er.is_active DESC,er.id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Save the employee role before recording a dated classification.'; END IF;
  PERFORM g.id FROM public.worker_comp_groups g WHERE g.org_id=NEW.org_id AND g.id=NEW.worker_comp_group_id AND g.is_active FOR SHARE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Choose a saved employee role and an active worker-compensation group.';
  END IF;
 END IF;
 IF current_id IS DISTINCT FROM NEW.expected_current_id THEN
  RAISE EXCEPTION 'The current employer assignment changed; export and preview the dated assignment again.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.pay_runs r JOIN public.pay_stubs s ON s.org_id=r.org_id AND s.pay_run_document_id=r.document_id
   JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
   WHERE r.org_id=NEW.org_id AND s.employee_party_id=NEW.employee_party_id AND r.run_status='committed' AND d.status<>'voided'
     AND r.pay_date BETWEEN NEW.effective_from AND NEW.effective_to) THEN
  RAISE EXCEPTION 'Committed payroll already used these dates; preserve its evidence and use a controlled correction run.';
 END IF;
 -- This row is also a revision fence: older repeatable-read calculations
 -- cannot lock the changed profile and proceed with an invisible new assignment.
 UPDATE public.employee_payroll_profiles SET updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond'),updated_by=NEW.created_by
  WHERE org_id=NEW.org_id AND employee_party_id=NEW.employee_party_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'The payroll profile revision was not saved; reload the employee and preview again.'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_employee_employer_assignment_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_employee_employer_assignments FOR EACH ROW EXECUTE FUNCTION public.payroll_employee_employer_assignment_guard();
ALTER TABLE public.payroll_employee_employer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_employee_employer_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_employee_employer_assignments
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.payroll_employee_employer_assignments IS 'openbooks:org_isolation:v1';
SELECT public.openbooks_refresh_query_catalog();
