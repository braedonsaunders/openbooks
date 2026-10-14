-- Retain original statutory opening allocations by legal payer and assessment jurisdiction.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.payroll_opening_levy_source_authorities (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL,
  opening_balance_id uuid NOT NULL,
  employer_authority_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  tax_year integer NOT NULL,
  subsidiary_id uuid NOT NULL,
  source_file_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  source_sha256 text NOT NULL,
  source_reference text NOT NULL,
  change_reason text NOT NULL,
  opening_sha256 text NOT NULL,
  allocation_sha256 text NOT NULL DEFAULT repeat('0', 64),
  allocation_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  sealed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  CONSTRAINT payroll_opening_levy_source_authorities_org_id_unique UNIQUE(org_id, id),
  CONSTRAINT payroll_opening_levy_source_authorities_opening_unique UNIQUE(org_id, opening_balance_id),
  CONSTRAINT payroll_opening_levy_source_authorities_parent_fk
    FOREIGN KEY(org_id, opening_balance_id)
    REFERENCES public.payroll_opening_employer_authorities(org_id, opening_balance_id) ON DELETE CASCADE,
  CONSTRAINT payroll_opening_levy_source_authorities_employer_authority_fk
    FOREIGN KEY(org_id, employer_authority_id)
    REFERENCES public.payroll_opening_employer_authorities(org_id, id) ON DELETE CASCADE,
  CONSTRAINT payroll_opening_levy_source_authorities_employee_fk
    FOREIGN KEY(org_id, employee_party_id) REFERENCES public.parties(org_id, id),
  CONSTRAINT payroll_opening_levy_source_authorities_employer_fk
    FOREIGN KEY(org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
  CONSTRAINT payroll_opening_levy_source_authorities_file_fk
    FOREIGN KEY(source_file_id) REFERENCES public.files(id),
  CONSTRAINT payroll_opening_levy_source_authorities_version_fk
    FOREIGN KEY(source_version_id) REFERENCES public.file_versions(id),
  CONSTRAINT payroll_opening_levy_source_authorities_source CHECK(
    source_sha256 ~ '^[a-f0-9]{64}$' AND opening_sha256 ~ '^[a-f0-9]{64}$'
    AND allocation_sha256 ~ '^[a-f0-9]{64}$'
    AND length(btrim(source_reference)) BETWEEN 1 AND 2000
    AND length(btrim(change_reason)) BETWEEN 1 AND 2000
    AND jsonb_typeof(allocation_snapshot) = 'array'
  )
);

CREATE TABLE public.payroll_opening_levy_source_allocations (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL,
  authority_id uuid NOT NULL,
  program_key text NOT NULL,
  region text NOT NULL,
  sub_region text NOT NULL DEFAULT '',
  filing_account_id uuid,
  amount numeric(19,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  CONSTRAINT payroll_opening_levy_source_allocations_authority_fk
    FOREIGN KEY(org_id, authority_id)
    REFERENCES public.payroll_opening_levy_source_authorities(org_id, id) ON DELETE CASCADE,
  CONSTRAINT payroll_opening_levy_source_allocations_account_fk
    FOREIGN KEY(org_id, filing_account_id)
    REFERENCES public.payroll_filing_accounts(org_id, id),
  CONSTRAINT payroll_opening_levy_source_allocations_amount CHECK(amount >= 0),
  CONSTRAINT payroll_opening_levy_source_allocations_scope CHECK (
    (program_key = 'ca_wcb' AND region IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT')
      AND sub_region = '' AND filing_account_id IS NULL)
    OR (program_key = 'ca_eht' AND region IN ('BC','MB','NL','ON')
      AND sub_region = '' AND filing_account_id IS NULL)
    OR (program_key = 'ca_cnt' AND region = 'QC'
      AND sub_region = '' AND filing_account_id IS NULL)
    OR (program_key = 'us_futa' AND region = 'US'
      AND sub_region = '' AND filing_account_id IS NOT NULL)
    OR (program_key = 'us_sui' AND region IN ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')
      AND sub_region = '')
    OR (program_key = 'us_pa_lst' AND region = 'PA'
      AND sub_region ~ '^[0-9]{6}$' AND filing_account_id IS NULL)
  )
);
CREATE UNIQUE INDEX payroll_opening_levy_source_allocations_unscoped_unique
  ON public.payroll_opening_levy_source_allocations(org_id, authority_id, program_key, region, sub_region)
  WHERE filing_account_id IS NULL;
CREATE UNIQUE INDEX payroll_opening_levy_source_allocations_account_unique
  ON public.payroll_opening_levy_source_allocations(org_id, authority_id, program_key, region, sub_region, filing_account_id)
  WHERE filing_account_id IS NOT NULL;
CREATE INDEX payroll_opening_levy_source_allocations_scope
  ON public.payroll_opening_levy_source_allocations(org_id, program_key, region, filing_account_id, authority_id);
CREATE INDEX payroll_opening_levy_source_authorities_employer_scope
  ON public.payroll_opening_levy_source_authorities(org_id, subsidiary_id, tax_year, employee_party_id);

ALTER TABLE public.payroll_opening_levy_source_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_opening_levy_source_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_opening_levy_source_authorities
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.payroll_opening_levy_source_authorities IS 'openbooks:org_isolation:v1';

ALTER TABLE public.payroll_opening_levy_source_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_opening_levy_source_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_opening_levy_source_allocations
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.payroll_opening_levy_source_allocations IS 'openbooks:org_isolation:v1';

CREATE FUNCTION public.payroll_opening_levy_source_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  retained jsonb;
  source_authority public.payroll_opening_employer_authorities%ROWTYPE;
  actual_snapshot jsonb;
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payroll opening levy source authority preserves its original allocation' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.sealed OR NOT NEW.sealed
      OR (to_jsonb(NEW) - ARRAY['sealed','allocation_sha256','allocation_snapshot'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['sealed','allocation_sha256','allocation_snapshot']) THEN
      RAISE EXCEPTION 'Payroll opening levy source authority and allocations are immutable once sealed' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'programKey', a.program_key, 'region', a.region, 'subRegion', a.sub_region,
      'filingAccountId', a.filing_account_id, 'amount', a.amount::text
    ) ORDER BY a.program_key, a.region, a.sub_region, a.filing_account_id NULLS FIRST), '[]'::jsonb)
      INTO actual_snapshot
      FROM public.payroll_opening_levy_source_allocations a
     WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id;
    IF actual_snapshot IS DISTINCT FROM NEW.allocation_snapshot
      OR encode(public.digest(actual_snapshot::text, 'sha256'), 'hex') <> NEW.allocation_sha256
      OR jsonb_array_length(actual_snapshot) = 0 THEN
      RAISE EXCEPTION 'Payroll opening levy allocation set must exactly match its sealed source snapshot' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.sealed THEN
    RAISE EXCEPTION 'Payroll opening levy source authority must be sealed after its allocation rows are written' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payroll-run-ytd:' || NEW.org_id::text || ':' || NEW.employee_party_id::text || ':' || NEW.tax_year::text, 0));
  SELECT to_jsonb(b) INTO retained
    FROM public.payroll_opening_balances b
   WHERE b.org_id = NEW.org_id AND b.id = NEW.opening_balance_id
     AND b.employee_party_id = NEW.employee_party_id AND b.tax_year = NEW.tax_year FOR SHARE;
  SELECT * INTO source_authority
    FROM public.payroll_opening_employer_authorities a
   WHERE a.org_id = NEW.org_id AND a.id = NEW.employer_authority_id
     AND a.opening_balance_id = NEW.opening_balance_id FOR SHARE;
  IF retained IS NULL OR source_authority.id IS NULL
    OR source_authority.employee_party_id <> NEW.employee_party_id
    OR source_authority.tax_year <> NEW.tax_year
    OR source_authority.subsidiary_id <> NEW.subsidiary_id
    OR source_authority.source_file_id <> NEW.source_file_id
    OR source_authority.source_version_id <> NEW.source_version_id
    OR source_authority.source_sha256 <> NEW.source_sha256
    OR source_authority.source_reference <> NEW.source_reference
    OR source_authority.opening_sha256 <> NEW.opening_sha256
    OR encode(public.digest(retained::text, 'sha256'), 'hex') <> NEW.opening_sha256 THEN
    RAISE EXCEPTION 'Payroll opening levy allocations must retain the exact qualified legal employer, opening and source file version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_opening_levy_source_authority_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_authorities
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_source_authority_guard();

CREATE FUNCTION public.payroll_opening_levy_source_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  authority public.payroll_opening_levy_source_authorities%ROWTYPE;
  account_type text;
  account_state text;
  account_subsidiary uuid;
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Payroll opening levy allocation rows are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO authority FROM public.payroll_opening_levy_source_authorities h
   WHERE h.org_id = NEW.org_id AND h.id = NEW.authority_id FOR UPDATE;
  IF authority.id IS NULL OR authority.sealed THEN
    RAISE EXCEPTION 'Payroll opening levy allocations can only be written before their source authority is sealed' USING ERRCODE = '23514';
  END IF;
  IF NEW.filing_account_id IS NOT NULL THEN
    SELECT program_type, state_code, subsidiary_id INTO account_type, account_state, account_subsidiary
      FROM public.payroll_filing_accounts
     WHERE org_id = NEW.org_id AND id = NEW.filing_account_id FOR SHARE;
    IF NEW.program_key = 'us_futa' AND account_type <> 'us_ein'
      OR NEW.program_key = 'us_sui' AND (account_type <> 'us_state_sui' OR account_state <> NEW.region)
      OR NEW.program_key NOT IN ('us_futa','us_sui')
      OR (account_subsidiary IS NOT NULL AND account_subsidiary <> authority.subsidiary_id) THEN
      RAISE EXCEPTION 'US opening allocations must use the original legal employer EIN or matching state SUI account' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.program_key = 'us_sui' AND EXISTS (
    SELECT 1 FROM public.payroll_filing_accounts a
     WHERE a.org_id = NEW.org_id AND a.country = 'US' AND a.program_type = 'us_state_sui'
       AND a.state_code = NEW.region AND (a.subsidiary_id = authority.subsidiary_id OR a.subsidiary_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'US SUI opening must retain the native state account when one exists for the original employer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_opening_levy_source_allocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_allocations
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_source_allocation_guard();

CREATE FUNCTION public.payroll_opening_levy_opening_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  row_org uuid;
  row_employee uuid;
  row_year integer;
  opening_id uuid;
  program text;
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'payroll_opening_sui_wages' THEN
      IF (NEW.org_id, NEW.opening_balance_id, NEW.state)
          IS DISTINCT FROM (OLD.org_id, OLD.opening_balance_id, OLD.state) THEN
        RAISE EXCEPTION 'Payroll opening SUI source identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF (NEW.org_id, NEW.employee_party_id, NEW.tax_year, NEW.program_key, NEW.filing_account_id, NEW.region)
        IS DISTINCT FROM (OLD.org_id, OLD.employee_party_id, OLD.tax_year, OLD.program_key, OLD.filing_account_id, OLD.region) THEN
      RAISE EXCEPTION 'Payroll opening filing-account source identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'payroll_opening_sui_wages' THEN
    IF TG_OP = 'DELETE' THEN
      row_org := OLD.org_id; opening_id := OLD.opening_balance_id;
    ELSE
      row_org := NEW.org_id; opening_id := NEW.opening_balance_id;
    END IF;
    SELECT b.employee_party_id, b.tax_year INTO row_employee, row_year
      FROM public.payroll_opening_balances b WHERE b.org_id = row_org AND b.id = opening_id;
  ELSE
    IF TG_OP = 'DELETE' THEN
      row_org := OLD.org_id; row_employee := OLD.employee_party_id; row_year := OLD.tax_year; program := OLD.program_key;
    ELSE
      row_org := NEW.org_id; row_employee := NEW.employee_party_id; row_year := NEW.tax_year; program := NEW.program_key;
      IF TG_OP = 'UPDATE' AND OLD.program_key IN ('us_futa','us_sui') THEN program := OLD.program_key; END IF;
    END IF;
    IF program NOT IN ('us_futa','us_sui') THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payroll-run-ytd:' || row_org::text || ':' || row_employee::text || ':' || row_year::text, 0));
  IF EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_authorities h
      WHERE h.org_id = row_org AND h.employee_party_id = row_employee AND h.tax_year = row_year AND h.sealed) THEN
    RAISE EXCEPTION 'Source-qualified statutory opening amounts must be preserved; review the original allocation in Payroll → Opening balances → Levy source; sealed source amendments are not available' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER payroll_opening_levy_source_sui_wages_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_sui_wages
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_opening_source_guard();
CREATE TRIGGER payroll_opening_levy_source_account_bases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_account_bases
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_opening_source_guard();

COMMENT ON TABLE public.payroll_opening_levy_source_authorities IS
  'Sealed, source-qualified statutory levy opening allocations tied to the original employee-year, legal payer, opening bytes and retained source file version.';
COMMENT ON TABLE public.payroll_opening_levy_source_allocations IS
  'Exact programme and original-jurisdiction levy carry-ins; FUTA retains the original EIN and SUI retains its state account.';

SELECT public.openbooks_refresh_query_catalog();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_authorities
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_allocations
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
