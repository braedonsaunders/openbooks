-- Append immutable replacements of unissued statutory opening source certificates.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.payroll_opening_levy_source_authorities
  ADD COLUMN supersedes_authority_id uuid,
  ADD COLUMN request_id uuid,
  ADD COLUMN request_sha256 text,
  ADD CONSTRAINT payroll_opening_levy_source_authorities_predecessor_fk
    FOREIGN KEY(org_id,supersedes_authority_id) REFERENCES public.payroll_opening_levy_source_authorities(org_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT payroll_opening_levy_source_authorities_successor_request CHECK(
    (supersedes_authority_id IS NULL AND request_id IS NULL AND request_sha256 IS NULL)
    OR (supersedes_authority_id IS NOT NULL AND supersedes_authority_id<>id
      AND request_id IS NOT NULL AND request_sha256 IS NOT NULL AND request_sha256 ~ '^[a-f0-9]{64}$')
  );
ALTER TABLE public.payroll_opening_levy_source_authorities
  DROP CONSTRAINT payroll_opening_levy_source_authorities_opening_unique;
CREATE UNIQUE INDEX payroll_opening_levy_source_authorities_original_unique
  ON public.payroll_opening_levy_source_authorities(org_id,opening_balance_id) WHERE supersedes_authority_id IS NULL;
CREATE UNIQUE INDEX payroll_opening_levy_source_authorities_successor_unique
  ON public.payroll_opening_levy_source_authorities(org_id,supersedes_authority_id) WHERE supersedes_authority_id IS NOT NULL;
CREATE UNIQUE INDEX payroll_opening_levy_source_authorities_request_unique
  ON public.payroll_opening_levy_source_authorities(org_id,request_id) WHERE request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.payroll_opening_levy_source_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  retained jsonb;
  source_authority public.payroll_opening_employer_authorities%ROWTYPE;
  actual_snapshot jsonb;
  original_file uuid;
  predecessor public.payroll_opening_levy_source_authorities%ROWTYPE;
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
    'payroll-opening-source:' || NEW.org_id::text || ':' || NEW.tax_year::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payroll-run-ytd:' || NEW.org_id::text || ':' || NEW.employee_party_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payroll-run-ytd:' || NEW.org_id::text || ':' || NEW.employee_party_id::text || ':' || NEW.tax_year::text, 0));
  -- The native GB apprenticeship levy shares an organization-wide annual base.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'payroll-levy-ytd:' || NEW.org_id::text || ':' || NEW.tax_year::text || ':GB:apprenticeship_levy',0));
  IF NEW.supersedes_authority_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM public.payroll_opening_levy_source_authorities h
     WHERE h.org_id=NEW.org_id AND h.id=NEW.supersedes_authority_id FOR UPDATE;
    IF predecessor.id IS NULL OR NOT predecessor.sealed
      OR (predecessor.opening_balance_id,predecessor.employer_authority_id,predecessor.employee_party_id,
          predecessor.tax_year,predecessor.subsidiary_id,predecessor.opening_sha256,
          predecessor.opening_children_snapshot,predecessor.opening_children_sha256)
        IS DISTINCT FROM (NEW.opening_balance_id,NEW.employer_authority_id,NEW.employee_party_id,
          NEW.tax_year,NEW.subsidiary_id,NEW.opening_sha256,NEW.opening_children_snapshot,NEW.opening_children_sha256)
      OR EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_authorities h
        WHERE h.org_id=NEW.org_id AND h.supersedes_authority_id=predecessor.id) THEN
      RAISE EXCEPTION 'Source correction must replace the current sealed certificate while preserving its legal payer and every original opening amount' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payroll_filing_submissions f WHERE f.org_id=NEW.org_id AND f.tax_year=NEW.tax_year) THEN
      RAISE EXCEPTION 'An issued payroll filing retains history for this tax year; source certificate replacement for an issued year is unavailable' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pay_runs r JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
      WHERE r.org_id=NEW.org_id AND r.tax_year=NEW.tax_year AND r.run_status='committed' AND d.status<>'voided'
        AND (d.subsidiary_id=NEW.subsidiary_id
          OR coalesce(r.calculation_source_snapshot,'{}'::jsonb) @> jsonb_build_object('openingLevySourceAuthorities',
            jsonb_build_array(jsonb_build_object('id',predecessor.id::text)))
          OR coalesce(r.calculation_source_snapshot,'{}'::jsonb) @> jsonb_build_object('openingBalanceSources',
            jsonb_build_array(jsonb_build_object('openingBalanceId',NEW.opening_balance_id::text)))
          OR EXISTS (SELECT 1 FROM public.pay_stubs s WHERE s.org_id=r.org_id AND s.pay_run_document_id=r.document_id
            AND s.employee_party_id=NEW.employee_party_id))) THEN
      RAISE EXCEPTION 'Committed payroll retains this opening source; complete its native governed void before correcting the certificate' USING ERRCODE='23514';
    END IF;
  END IF;
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

CREATE OR REPLACE FUNCTION public.payroll_opening_levy_opening_source_guard() RETURNS trigger
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
    RAISE EXCEPTION 'Source-qualified statutory opening amounts must be preserved; a replacement source certificate cannot change annual or child opening amounts' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION public.payroll_opening_levy_successor_complete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE retained public.payroll_opening_levy_source_authorities%ROWTYPE;
BEGIN
  SELECT * INTO retained FROM public.payroll_opening_levy_source_authorities h WHERE h.org_id=NEW.org_id AND h.id=NEW.id;
  IF retained.id IS NULL AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(NEW))
    OR public.openbooks_sandbox_wipe_allowed(NEW.org_id)) THEN RETURN NULL; END IF;
  IF retained.id IS NULL OR NOT retained.sealed OR NOT EXISTS (
    SELECT 1 FROM public.audit_log a JOIN public.payroll_opening_levy_source_authorities p
      ON p.org_id=retained.org_id AND p.id=retained.supersedes_authority_id
     WHERE a.org_id=retained.org_id AND a.table_name='payroll_opening_levy_source_authorities' AND a.row_id=retained.id
       AND a.actor_id=retained.created_by AND a.changes->'before'=to_jsonb(p) AND a.changes->'after'=to_jsonb(retained)
       AND a.changes->>'reason'=retained.change_reason
  ) THEN
    RAISE EXCEPTION 'Opening source replacement must retain its complete sealed certificate and immutable before/after audit in the same transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payroll_opening_levy_successor_complete_guard
  AFTER INSERT ON public.payroll_opening_levy_source_authorities DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.supersedes_authority_id IS NOT NULL)
  EXECUTE FUNCTION public.payroll_opening_levy_successor_complete_guard();

COMMENT ON COLUMN public.payroll_opening_levy_source_authorities.supersedes_authority_id IS
  'Reviewed predecessor of an append-only source correction; original certificates and financial amounts remain immutable.';
COMMENT ON COLUMN public.payroll_opening_levy_source_authorities.request_sha256 IS
  'Canonical correction request digest binding the actor, reviewed certificate, source version, allocation facts and reason.';
SELECT public.openbooks_refresh_query_catalog();
