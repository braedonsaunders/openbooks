-- Preserve the original federal employer of state registrations at the
-- payroll source date. Qualification is explicit and never inferred from
-- current account activation or employee profile state.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE TABLE public.payroll_us_filing_account_employer_lineage (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY,
 org_id uuid NOT NULL,
 filing_account_id uuid NOT NULL,
 federal_account_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 effective_from date NOT NULL,
 effective_to date,
 source_reference text NOT NULL,
 change_reason text NOT NULL,
 created_at timestamptz DEFAULT now() NOT NULL,
 created_by uuid NOT NULL,
 updated_at timestamptz DEFAULT now() NOT NULL,
 updated_by uuid NOT NULL,
 CONSTRAINT payroll_us_filing_account_employer_lineage_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT payroll_us_filing_account_employer_lineage_state_fkey FOREIGN KEY(org_id,filing_account_id)
  REFERENCES public.payroll_filing_accounts(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT payroll_us_filing_account_employer_lineage_federal_fkey FOREIGN KEY(org_id,federal_account_id)
  REFERENCES public.payroll_filing_accounts(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT payroll_us_filing_account_employer_lineage_employer_fkey FOREIGN KEY(org_id,subsidiary_id)
  REFERENCES public.subsidiaries(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT payroll_us_filing_account_employer_lineage_dates CHECK(effective_to IS NULL OR effective_from<=effective_to),
 CONSTRAINT payroll_us_filing_account_employer_lineage_source CHECK(
  length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000),
 CONSTRAINT payroll_us_filing_account_employer_lineage_range EXCLUDE USING gist
  (org_id WITH =,filing_account_id WITH =,
   (daterange(effective_from,coalesce(effective_to,'infinity'::date),'[]')) WITH &&)
);
ALTER TABLE public.payroll_us_filing_account_employer_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_us_filing_account_employer_lineage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_us_filing_account_employer_lineage
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_us_filing_account_employer_lineage FOR EACH ROW
 EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE FUNCTION public.payroll_us_filing_account_lineage_clone_matches(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target record;
  original jsonb;
  expected jsonb;
  column_row record;
BEGIN
  IF NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
  SELECT org.sandbox_of, org.sandbox_seed, sandbox.masked
    INTO target
    FROM public.orgs org
    JOIN public.sandboxes sandbox
      ON sandbox.org_id = org.id AND sandbox.production_org_id = org.sandbox_of
    JOIN public.orgs production ON production.id = org.sandbox_of AND production.id <> org.id
   WHERE org.id = (candidate->>'org_id')::uuid
     AND org.env_kind = 'sandbox'
     AND org.sandbox_seed IS NOT NULL
     AND sandbox.status IN ('provisioning', 'refreshing');
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT to_jsonb(source)
    INTO original
    FROM public.payroll_us_filing_account_employer_lineage source
   WHERE source.org_id = target.sandbox_of
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.payroll_us_filing_account_employer_lineage'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
  LOOP
    IF column_row.attname = 'org_id' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb((candidate->>'org_id')::uuid));
    ELSIF column_row.atttypid = 'uuid'::regtype
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb(public.ob_rebase(
        (original->>column_row.attname)::uuid, target.sandbox_seed
      )));
    END IF;
    IF target.masked AND column_row.attname IN ('source_reference', 'change_reason')
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb('REDACTED'::text));
    END IF;
  END LOOP;
  RETURN candidate = expected;
END
$function$;

CREATE FUNCTION public.payroll_us_filing_account_lineage_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE parent_id uuid; state_account record; federal_account record; last_used date;
BEGIN
 IF TG_OP='INSERT' AND public.payroll_us_filing_account_lineage_clone_matches(to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND (public.openbooks_sandbox_wipe_allowed(OLD.org_id)
  OR tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))) THEN RETURN OLD; END IF;
 -- Readers share-lock these same account parents before reading dated ownership.
 FOR parent_id IN SELECT DISTINCT candidate.id FROM (VALUES
  (CASE WHEN TG_OP<>'INSERT' THEN OLD.filing_account_id END),
  (CASE WHEN TG_OP<>'INSERT' THEN OLD.federal_account_id END),
  (CASE WHEN TG_OP<>'DELETE' THEN NEW.filing_account_id END),
  (CASE WHEN TG_OP<>'DELETE' THEN NEW.federal_account_id END)) candidate(id)
  WHERE candidate.id IS NOT NULL ORDER BY candidate.id
 LOOP
  PERFORM id FROM public.payroll_filing_accounts WHERE id=parent_id FOR UPDATE;
 END LOOP;
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Retain employer EIN history; close a dated affiliation with an evidence reference and reason.'
   USING ERRCODE='23514',CONSTRAINT='payroll_us_filing_account_lineage_retained';
 END IF;
 SELECT * INTO state_account FROM public.payroll_filing_accounts
  WHERE org_id=NEW.org_id AND id=NEW.filing_account_id;
 SELECT * INTO federal_account FROM public.payroll_filing_accounts
  WHERE org_id=NEW.org_id AND id=NEW.federal_account_id;
 IF state_account.id IS NULL OR federal_account.id IS NULL
  OR state_account.country<>'US' OR federal_account.country<>'US'
  OR state_account.program_type<>'us_state_sui' OR federal_account.program_type<>'us_ein'
  OR state_account.subsidiary_id IS NOT NULL AND state_account.subsidiary_id<>NEW.subsidiary_id
  OR federal_account.subsidiary_id IS NOT NULL AND federal_account.subsidiary_id<>NEW.subsidiary_id
  OR NOT EXISTS(SELECT 1 FROM public.subsidiaries WHERE org_id=NEW.org_id AND id=NEW.subsidiary_id AND country='US' AND NOT is_elimination) THEN
  RAISE EXCEPTION 'Choose this organization''s original US state account, federal EIN and native legal employer.'
   USING ERRCODE='23514',CONSTRAINT='payroll_us_filing_account_lineage_ownership';
 END IF;
 IF TG_OP='UPDATE' THEN
  -- Registration evidence is append-only even before use; a version may only
  -- close its inclusive date range, while audit retains the closing reason.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id
   OR NEW.filing_account_id IS DISTINCT FROM OLD.filing_account_id
   OR NEW.federal_account_id IS DISTINCT FROM OLD.federal_account_id
   OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id
   OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
   OR NEW.source_reference IS DISTINCT FROM OLD.source_reference
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
   OR OLD.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to>OLD.effective_to) THEN
   RAISE EXCEPTION 'Preserve the original employer registration evidence; close the current range and add a new dated affiliation.'
    USING ERRCODE='23514',CONSTRAINT='payroll_us_filing_account_lineage_retained';
  END IF;
  SELECT max(r.pay_date) INTO last_used FROM public.pay_runs r
   JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
   JOIN public.pay_stubs s ON s.org_id=r.org_id AND s.pay_run_document_id=r.document_id
   WHERE r.org_id=OLD.org_id AND r.run_status='committed' AND d.subsidiary_id=OLD.subsidiary_id
    AND s.country='US' AND r.pay_date>=OLD.effective_from
    AND (OLD.effective_to IS NULL OR r.pay_date<=OLD.effective_to)
    AND (s.filing_account_id=OLD.filing_account_id
      OR s.filing_account_id=OLD.federal_account_id AND s.province=state_account.state_code);
  IF last_used IS NOT NULL AND NEW.effective_to IS NOT NULL AND NEW.effective_to<last_used THEN
   RAISE EXCEPTION 'Employer EIN history cannot end before payroll that used it; retain the original affiliation through its last committed pay date.'
    USING ERRCODE='23514',CONSTRAINT='payroll_us_filing_account_lineage_used';
  END IF;
 END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER payroll_us_filing_account_lineage_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_us_filing_account_employer_lineage FOR EACH ROW
 EXECUTE FUNCTION public.payroll_us_filing_account_lineage_guard();

CREATE FUNCTION public.payroll_us_filing_account_lineage_account_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.country IS DISTINCT FROM OLD.country
  OR NEW.program_type IS DISTINCT FROM OLD.program_type OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id
  OR NEW.state_code IS DISTINCT FROM OLD.state_code OR NEW.account_number IS DISTINCT FROM OLD.account_number THEN
  IF EXISTS(SELECT 1 FROM public.payroll_us_filing_account_employer_lineage
   WHERE org_id=OLD.org_id AND (filing_account_id=OLD.id OR federal_account_id=OLD.id))
   OR OLD.country='US' AND EXISTS(SELECT 1 FROM public.pay_stubs s
    JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
    WHERE s.org_id=OLD.org_id AND s.filing_account_id=OLD.id AND r.run_status='committed') THEN
   RAISE EXCEPTION 'A filing account with retained employer EIN history or committed payroll cannot change its organization, program, legal employer, state or account number. Preserve its registration and add a new native filing account.'
    USING ERRCODE='23514',CONSTRAINT='payroll_us_filing_account_lineage_account_identity';
  END IF;
 END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER payroll_us_filing_account_lineage_account_guard BEFORE UPDATE
 ON public.payroll_filing_accounts FOR EACH ROW
 EXECUTE FUNCTION public.payroll_us_filing_account_lineage_account_guard();
COMMENT ON TABLE public.payroll_us_filing_account_employer_lineage IS
 'Source-qualified inclusive state-account affiliation to its original federal EIN and native legal employer. Activation cannot replace this history.';
