-- Retain original statutory opening allocations by legal payer and assessment jurisdiction.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.payroll_opening_source_children(p_org uuid, p_opening uuid, p_employee uuid, p_year integer)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT jsonb_build_object(
    'components',(SELECT coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('ytd_amount',c.ytd_amount::text)
        ORDER BY c.component_id),'[]'::jsonb) FROM public.payroll_opening_balance_components c
      WHERE c.org_id=p_org AND c.opening_balance_id=p_opening),
    'programBases',(SELECT coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('insurable_ytd',p.insurable_ytd::text)
        ORDER BY p.program_key),'[]'::jsonb) FROM public.payroll_opening_program_bases p
      WHERE p.org_id=p_org AND p.employee_party_id=p_employee AND p.tax_year=p_year),
    'accountBases',(SELECT coalesce(jsonb_agg(to_jsonb(a) || jsonb_build_object('insurable_ytd',a.insurable_ytd::text)
        ORDER BY a.program_key,a.filing_account_id,a.region NULLS FIRST),'[]'::jsonb) FROM public.payroll_opening_account_bases a
      WHERE a.org_id=p_org AND a.employee_party_id=p_employee AND a.tax_year=p_year),
    'suiStates',(SELECT coalesce(jsonb_agg(to_jsonb(w) || jsonb_build_object('insurable_ytd',w.insurable_ytd::text)
        ORDER BY w.state),'[]'::jsonb) FROM public.payroll_opening_sui_wages w
      WHERE w.org_id=p_org AND w.opening_balance_id=p_opening)
  );
$$;

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
  original_country text NOT NULL,
  original_currency text NOT NULL REFERENCES public.currencies(code),
  coverage_start date NOT NULL,
  coverage_end date NOT NULL,
  coverage_complete boolean NOT NULL,
  change_reason text NOT NULL,
  opening_sha256 text NOT NULL,
  opening_children_snapshot jsonb NOT NULL,
  opening_children_sha256 text NOT NULL,
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
  CONSTRAINT payroll_opening_levy_source_authorities_facts CHECK(
    original_country ~ '^[A-Z]{2}$' AND original_currency ~ '^[A-Z]{3}$'
    AND (original_country <> 'CA' OR original_currency = 'CAD')
    AND (original_country <> 'US' OR original_currency = 'USD')
    AND coverage_complete AND coverage_end >= coverage_start
    AND coverage_end < coverage_start + interval '1 year'
    AND extract(year FROM coverage_start) IN (tax_year, tax_year - 1)
    AND (original_country NOT IN ('CA','US') OR
      (coverage_start = make_date(tax_year,1,1) AND coverage_end <= make_date(tax_year,12,31)))
  ),
  CONSTRAINT payroll_opening_levy_source_authorities_source CHECK(
    source_sha256 ~ '^[a-f0-9]{64}$' AND opening_sha256 ~ '^[a-f0-9]{64}$'
    AND allocation_sha256 ~ '^[a-f0-9]{64}$' AND opening_children_sha256 ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(opening_children_snapshot) = 'object'
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
  federal_account_id uuid,
  amount numeric(19,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  CONSTRAINT payroll_opening_levy_source_allocations_authority_fk
    FOREIGN KEY(org_id, authority_id)
    REFERENCES public.payroll_opening_levy_source_authorities(org_id, id) ON DELETE CASCADE,
  CONSTRAINT payroll_opening_levy_source_allocations_account_fk
    FOREIGN KEY(org_id, filing_account_id)
    REFERENCES public.payroll_filing_accounts(org_id, id),
  CONSTRAINT payroll_opening_levy_source_allocations_federal_account_fk
    FOREIGN KEY(org_id, federal_account_id) REFERENCES public.payroll_filing_accounts(org_id, id),
  CONSTRAINT payroll_opening_levy_source_allocations_lineage CHECK(
    (program_key IN ('ca_wcb','ca_eht','ca_cnt') AND federal_account_id IS NULL)
    OR (program_key IN ('us_futa','us_sui','us_pa_lst') AND federal_account_id IS NOT NULL
      AND (program_key <> 'us_futa' OR federal_account_id = filing_account_id))
  ),
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
  ON public.payroll_opening_levy_source_allocations(org_id, authority_id, program_key, region, sub_region, federal_account_id) NULLS NOT DISTINCT
  WHERE filing_account_id IS NULL;
CREATE UNIQUE INDEX payroll_opening_levy_source_allocations_account_unique
  ON public.payroll_opening_levy_source_allocations(org_id, authority_id, program_key, region, sub_region, filing_account_id, federal_account_id)
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
  original_file uuid;
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
      'filingAccountId', a.filing_account_id, 'federalAccountId', a.federal_account_id, 'amount', a.amount::text
    ) ORDER BY a.program_key, a.region, a.sub_region, a.filing_account_id NULLS FIRST, a.federal_account_id NULLS FIRST), '[]'::jsonb)
      INTO actual_snapshot
      FROM public.payroll_opening_levy_source_allocations a
     WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id;
    IF NEW.opening_children_snapshot IS DISTINCT FROM public.payroll_opening_source_children(NEW.org_id,NEW.opening_balance_id,NEW.employee_party_id,NEW.tax_year)
      OR NEW.opening_children_sha256 <> encode(public.digest(NEW.opening_children_snapshot::text,'sha256'),'hex')
      OR actual_snapshot IS DISTINCT FROM NEW.allocation_snapshot
      OR encode(public.digest(actual_snapshot::text, 'sha256'), 'hex') <> NEW.allocation_sha256
      OR (NEW.original_country IN ('CA','US') AND jsonb_array_length(actual_snapshot) = 0) THEN
      RAISE EXCEPTION 'Payroll opening levy allocation set must exactly match its sealed source snapshot' USING ERRCODE = '23514';
    END IF;
    SELECT to_jsonb(b) INTO retained FROM public.payroll_opening_balances b
      WHERE b.org_id = NEW.org_id AND b.id = NEW.opening_balance_id FOR SHARE;
    IF NEW.original_country = 'CA' THEN
      IF jsonb_array_length(actual_snapshot) <> 18
        OR (SELECT sum(a.amount) FROM public.payroll_opening_levy_source_allocations a
          WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'ca_wcb')
            IS DISTINCT FROM (retained->>'wcb_assessable_ytd')::numeric
        OR (SELECT sum(a.amount) FROM public.payroll_opening_levy_source_allocations a
          WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'ca_eht')
            IS DISTINCT FROM (retained->>'eht_remuneration_ytd')::numeric THEN
        RAISE EXCEPTION 'Declare all Canadian levy jurisdictions and preserve the exact original WCB and EHT aggregate amounts' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.original_country = 'US' THEN
      IF NOT EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_allocations a
          WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_futa')
        OR EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_allocations a
          WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND NOT EXISTS (
            SELECT 1 FROM public.payroll_opening_levy_source_allocations f
             WHERE f.org_id = a.org_id AND f.authority_id = a.authority_id
               AND f.program_key = 'us_futa' AND f.filing_account_id = a.federal_account_id)) THEN
        RAISE EXCEPTION 'Declare an exact FUTA opening for every original EIN named by the allocation set' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM public.payroll_opening_account_bases b
          WHERE b.org_id = NEW.org_id AND b.employee_party_id = NEW.employee_party_id
            AND b.tax_year = NEW.tax_year AND b.program_key = 'us_futa') THEN
        IF (retained->>'insurable_ytd')::numeric <> 0
          OR EXISTS (SELECT 1 FROM public.payroll_opening_account_bases b
              WHERE b.org_id = NEW.org_id AND b.employee_party_id = NEW.employee_party_id
                AND b.tax_year = NEW.tax_year AND b.program_key = 'us_futa' AND NOT EXISTS (
                  SELECT 1 FROM public.payroll_opening_levy_source_allocations a
                   WHERE a.org_id = b.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_futa'
                     AND a.filing_account_id = b.filing_account_id AND a.amount = b.insurable_ytd))
          OR EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_allocations a
              WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_futa'
                AND a.amount <> 0 AND NOT EXISTS (
                  SELECT 1 FROM public.payroll_opening_account_bases b
                   WHERE b.org_id = a.org_id AND b.employee_party_id = NEW.employee_party_id
                     AND b.tax_year = NEW.tax_year AND b.program_key = 'us_futa' AND b.filing_account_id = a.filing_account_id)) THEN
          RAISE EXCEPTION 'FUTA source allocations must preserve every exact EIN-specific opening wage base' USING ERRCODE = '23514';
        END IF;
      ELSIF (SELECT sum(a.amount) FROM public.payroll_opening_levy_source_allocations a
          WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_futa')
            IS DISTINCT FROM (retained->>'insurable_ytd')::numeric THEN
        RAISE EXCEPTION 'FUTA source allocations must equal the exact original employee-only insurable opening' USING ERRCODE = '23514';
      END IF;
      IF (retained->>'insurable_ytd')::numeric > 0 AND NOT EXISTS (
          SELECT 1 FROM public.payroll_opening_levy_source_allocations a
           WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_sui')
        OR EXISTS (SELECT 1 FROM public.payroll_opening_account_bases b
          WHERE b.org_id = NEW.org_id AND b.employee_party_id = NEW.employee_party_id AND b.tax_year = NEW.tax_year
            AND b.program_key = 'us_sui' AND (SELECT sum(a.amount) FROM public.payroll_opening_levy_source_allocations a
              WHERE a.org_id = b.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_sui'
                AND a.region = b.region AND a.filing_account_id = b.filing_account_id) IS DISTINCT FROM b.insurable_ytd)
        OR EXISTS (
          SELECT 1 FROM (
            SELECT sw.state AS region, sw.insurable_ytd AS amount
              FROM public.payroll_opening_sui_wages sw WHERE sw.org_id = NEW.org_id AND sw.opening_balance_id = NEW.opening_balance_id
            UNION ALL
            SELECT b.region,b.insurable_ytd FROM public.payroll_opening_account_bases b
              WHERE b.org_id = NEW.org_id AND b.employee_party_id = NEW.employee_party_id AND b.tax_year = NEW.tax_year
                AND b.program_key = 'us_sui'
          ) prior GROUP BY prior.region HAVING sum(prior.amount) IS DISTINCT FROM (
            SELECT sum(a.amount) FROM public.payroll_opening_levy_source_allocations a
             WHERE a.org_id = NEW.org_id AND a.authority_id = NEW.id AND a.program_key = 'us_sui' AND a.region = prior.region)
        ) THEN
        RAISE EXCEPTION 'SUI source allocations must preserve every exact original state and account aggregate, split only by source-confirmed EIN' USING ERRCODE = '23514';
      END IF;
    ELSIF jsonb_array_length(actual_snapshot) <> 0 THEN
      RAISE EXCEPTION 'The original country has no declared opening levy allocation programmes; preserve its generic opening amounts' USING ERRCODE = '23514';
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
  IF NEW.opening_children_snapshot IS DISTINCT FROM public.payroll_opening_source_children(NEW.org_id,NEW.opening_balance_id,NEW.employee_party_id,NEW.tax_year)
    OR NEW.opening_children_sha256 <> encode(public.digest(NEW.opening_children_snapshot::text,'sha256'),'hex')
    OR retained IS NULL OR source_authority.id IS NULL
    OR source_authority.employee_party_id <> NEW.employee_party_id
    OR source_authority.tax_year <> NEW.tax_year
    OR source_authority.subsidiary_id <> NEW.subsidiary_id
    OR source_authority.opening_sha256 <> NEW.opening_sha256
    OR encode(public.digest(retained::text, 'sha256'), 'hex') <> NEW.opening_sha256 THEN
    RAISE EXCEPTION 'Payroll opening levy allocations must retain the exact qualified legal employer, opening and source file version' USING ERRCODE = '23514';
  END IF;
  SELECT v.id INTO original_file FROM public.files f JOIN public.file_versions v ON v.file_id = f.id
    WHERE f.org_id = NEW.org_id AND f.id = NEW.source_file_id AND NOT f.is_inactive
      AND v.id = NEW.source_version_id AND v.content_hash = NEW.source_sha256 AND v.created_by = NEW.created_by
    FOR SHARE OF f,v;
  IF original_file IS NULL THEN
    RAISE EXCEPTION 'Select the active original Cabinet file and its exact retained version and hash' USING ERRCODE = '23514';
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
  federal_type text;
  federal_subsidiary uuid;
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
  IF authority.original_country NOT IN ('CA','US') OR (authority.original_country = 'CA' AND NEW.program_key NOT IN ('ca_wcb','ca_eht','ca_cnt'))
    OR (authority.original_country = 'US' AND NEW.program_key NOT IN ('us_futa','us_sui','us_pa_lst')) THEN
    RAISE EXCEPTION 'Opening allocation country must match its authored original source country' USING ERRCODE = '23514';
  END IF;
  IF NEW.federal_account_id IS NOT NULL THEN
    SELECT program_type, subsidiary_id INTO federal_type, federal_subsidiary
      FROM public.payroll_filing_accounts
     WHERE org_id = NEW.org_id AND id = NEW.federal_account_id AND country = 'US' FOR SHARE;
    IF federal_type IS DISTINCT FROM 'us_ein'
      OR (federal_subsidiary IS NOT NULL AND federal_subsidiary <> authority.subsidiary_id) THEN
      RAISE EXCEPTION 'Bind each US original opening allocation to its native original employer EIN' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.filing_account_id IS NOT NULL THEN
    SELECT program_type, state_code, subsidiary_id INTO account_type, account_state, account_subsidiary
      FROM public.payroll_filing_accounts
     WHERE org_id = NEW.org_id AND id = NEW.filing_account_id FOR SHARE;
    IF NEW.program_key = 'us_futa' AND account_type IS DISTINCT FROM 'us_ein'
      OR NEW.program_key = 'us_sui' AND (account_type IS DISTINCT FROM 'us_state_sui' OR account_state IS DISTINCT FROM NEW.region)
      OR NEW.program_key NOT IN ('us_futa','us_sui')
      OR (account_subsidiary IS NOT NULL AND account_subsidiary <> authority.subsidiary_id) THEN
      RAISE EXCEPTION 'US opening allocations must use the original legal employer EIN or matching state SUI account' USING ERRCODE = '23514';
    END IF;
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
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'payroll_opening_balance_components' THEN
      IF (NEW.org_id,NEW.opening_balance_id,NEW.component_id) IS DISTINCT FROM (OLD.org_id,OLD.opening_balance_id,OLD.component_id) THEN
        RAISE EXCEPTION 'Payroll opening component source identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'payroll_opening_program_bases' THEN
      IF (NEW.org_id,NEW.employee_party_id,NEW.tax_year,NEW.program_key) IS DISTINCT FROM (OLD.org_id,OLD.employee_party_id,OLD.tax_year,OLD.program_key) THEN
        RAISE EXCEPTION 'Payroll opening programme source identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'payroll_opening_sui_wages' THEN
      IF (NEW.org_id, NEW.opening_balance_id, NEW.state)
          IS DISTINCT FROM (OLD.org_id, OLD.opening_balance_id, OLD.state) THEN
        RAISE EXCEPTION 'Payroll opening SUI source identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF (NEW.org_id, NEW.employee_party_id, NEW.tax_year, NEW.program_key, NEW.filing_account_id, NEW.region)
        IS DISTINCT FROM (OLD.org_id, OLD.employee_party_id, OLD.tax_year, OLD.program_key, OLD.filing_account_id, OLD.region) THEN
      RAISE EXCEPTION 'Payroll opening filing-account source identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('payroll_opening_sui_wages','payroll_opening_balance_components') THEN
    IF TG_OP = 'DELETE' THEN
      row_org := OLD.org_id; opening_id := OLD.opening_balance_id;
    ELSE
      row_org := NEW.org_id; opening_id := NEW.opening_balance_id;
    END IF;
    SELECT b.employee_party_id, b.tax_year INTO row_employee, row_year
      FROM public.payroll_opening_balances b WHERE b.org_id = row_org AND b.id = opening_id;
  ELSE
    IF TG_OP = 'DELETE' THEN
      row_org := OLD.org_id; row_employee := OLD.employee_party_id; row_year := OLD.tax_year;
    ELSE
      row_org := NEW.org_id; row_employee := NEW.employee_party_id; row_year := NEW.tax_year;
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

CREATE TRIGGER payroll_opening_levy_source_components_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_balance_components
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_opening_source_guard();
CREATE TRIGGER payroll_opening_levy_source_program_bases_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_program_bases
  FOR EACH ROW EXECUTE FUNCTION public.payroll_opening_levy_opening_source_guard();

COMMENT ON TABLE public.payroll_opening_levy_source_authorities IS
  'Sealed, source-qualified statutory levy opening allocations tied to the original employee-year, legal payer, opening bytes and retained source file version.';
COMMENT ON TABLE public.payroll_opening_levy_source_allocations IS
  'Exact programme and original-jurisdiction levy carry-ins; every US allocation retains its source-confirmed federal EIN and SUI retains its original state account.';

SELECT public.openbooks_refresh_query_catalog();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_authorities
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_opening_levy_source_allocations
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
