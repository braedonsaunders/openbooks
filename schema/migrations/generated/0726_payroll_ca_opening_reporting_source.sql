-- Seal original Canadian RP/province reporting allocations without adopting historical data.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.payroll_ca_opening_reporting_annual(p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT coalesce(jsonb_object_agg(a.attname,p_snapshot->>a.attname),'{}'::jsonb)
 FROM pg_catalog.pg_attribute a
 WHERE a.attrelid='public.payroll_opening_balances'::regclass AND a.attnum>0 AND NOT a.attisdropped
   AND a.atttypid='numeric'::regtype AND a.attname<>'vacation_balance';
$$;

CREATE TABLE public.payroll_ca_opening_reporting_authorities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 opening_balance_id uuid NOT NULL, levy_authority_id uuid NOT NULL, employer_authority_id uuid NOT NULL,
 levy_allocation_sha256 text NOT NULL, employee_party_id uuid NOT NULL, tax_year integer NOT NULL, subsidiary_id uuid NOT NULL,
 original_country text NOT NULL, original_currency text NOT NULL REFERENCES public.currencies(code),
 coverage_start date NOT NULL, coverage_end date NOT NULL,
 source_file_id uuid NOT NULL REFERENCES public.files(id), source_version_id uuid NOT NULL REFERENCES public.file_versions(id),
 source_sha256 text NOT NULL, source_reference text NOT NULL,
 opening_sha256 text NOT NULL, opening_snapshot jsonb NOT NULL, opening_children_sha256 text NOT NULL, opening_children_snapshot jsonb NOT NULL,
 annual_amounts jsonb NOT NULL, allocation_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
 allocation_sha256 text NOT NULL DEFAULT repeat('0',64), request_id uuid NOT NULL, request_sha256 text NOT NULL,
 change_reason text NOT NULL, sealed boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_levy_unique UNIQUE(org_id,levy_authority_id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_request_unique UNIQUE(org_id,request_id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_levy_fk FOREIGN KEY(org_id,levy_authority_id)
   REFERENCES public.payroll_opening_levy_source_authorities(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_employer_fk FOREIGN KEY(org_id,employer_authority_id)
   REFERENCES public.payroll_opening_employer_authorities(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_opening_fk FOREIGN KEY(org_id,opening_balance_id)
   REFERENCES public.payroll_opening_employer_authorities(org_id,opening_balance_id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_employee_fk FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_subsidiary_fk FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_source_version_fk FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
 CONSTRAINT payroll_ca_opening_reporting_authorities_country CHECK(original_country='CA' AND original_currency='CAD'
   AND coverage_start=make_date(tax_year,1,1) AND coverage_end>=coverage_start AND coverage_end<=make_date(tax_year,12,31)),
 CONSTRAINT payroll_ca_opening_reporting_authorities_evidence CHECK(
   source_sha256 ~ '^[a-f0-9]{64}$' AND opening_sha256 ~ '^[a-f0-9]{64}$' AND opening_children_sha256 ~ '^[a-f0-9]{64}$'
   AND levy_allocation_sha256 ~ '^[a-f0-9]{64}$' AND allocation_sha256 ~ '^[a-f0-9]{64}$' AND request_sha256 ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(opening_snapshot)='object' AND jsonb_typeof(opening_children_snapshot)='object'
   AND jsonb_typeof(annual_amounts)='object' AND jsonb_typeof(allocation_snapshot)='array'
   AND length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000)
);
CREATE INDEX payroll_ca_opening_reporting_authorities_scope ON public.payroll_ca_opening_reporting_authorities(org_id,subsidiary_id,tax_year,employee_party_id);

CREATE TABLE public.payroll_ca_opening_reporting_allocations (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), authority_id uuid NOT NULL,
 filing_account_id uuid NOT NULL, province text NOT NULL, source_ordinal integer NOT NULL, first_covered_pay_date date NOT NULL,
 annual_amounts jsonb NOT NULL, reportable_bases jsonb NOT NULL, children jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
 CONSTRAINT payroll_ca_opening_reporting_allocations_authority_fk FOREIGN KEY(org_id,authority_id)
   REFERENCES public.payroll_ca_opening_reporting_authorities(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_allocations_account_fk FOREIGN KEY(org_id,filing_account_id) REFERENCES public.payroll_filing_accounts(org_id,id),
 CONSTRAINT payroll_ca_opening_reporting_allocations_scope_unique UNIQUE(org_id,authority_id,filing_account_id,province),
 CONSTRAINT payroll_ca_opening_reporting_allocations_order_unique UNIQUE(org_id,authority_id,source_ordinal),
 CONSTRAINT payroll_ca_opening_reporting_allocations_facts CHECK(source_ordinal>0
   AND province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','ZZ')
   AND jsonb_typeof(annual_amounts)='object' AND jsonb_typeof(reportable_bases)='object' AND jsonb_typeof(children)='object')
);

CREATE FUNCTION public.payroll_ca_opening_reporting_allocations_snapshot(p_org uuid,p_authority uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('sourceOrdinal',a.source_ordinal,'firstCoveredPayDate',a.first_covered_pay_date::text,
   'filingAccountId',a.filing_account_id,'province',a.province,'annualAmounts',a.annual_amounts,'reportableBases',a.reportable_bases,'children',a.children)
   ORDER BY a.source_ordinal),'[]'::jsonb)
 FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=p_org AND a.authority_id=p_authority;
$$;

CREATE FUNCTION public.payroll_ca_opening_reporting_child_identity(p_family text,p_row jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
 SELECT CASE p_family WHEN 'components' THEN jsonb_build_array(p_row->>'component_id')
   WHEN 'programBases' THEN jsonb_build_array(p_row->>'program_key')
   WHEN 'accountBases' THEN jsonb_build_array(p_row->>'program_key',p_row->>'filing_account_id',p_row->>'region')
   WHEN 'suiStates' THEN jsonb_build_array(p_row->>'state') END;
$$;

CREATE FUNCTION public.payroll_ca_opening_reporting_authority_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
 levy public.payroll_opening_levy_source_authorities%ROWTYPE;
 employer public.payroll_opening_employer_authorities%ROWTYPE;
 retained jsonb; actual jsonb; family text; amount_key text; original_row jsonb; identity jsonb; original_value text;
 source_version uuid; allocated_total numeric; slice_count integer;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original Canadian opening reporting evidence is immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-opening-source:'||NEW.org_id::text||':'||NEW.tax_year::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id::text||':'||NEW.employee_party_id::text||':'||NEW.tax_year::text,0));
 IF TG_OP='UPDATE' AND (OLD.sealed OR NOT NEW.sealed
   OR (to_jsonb(NEW)-ARRAY['sealed','allocation_snapshot','allocation_sha256'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['sealed','allocation_snapshot','allocation_sha256'])) THEN
   RAISE EXCEPTION 'Original Canadian opening reporting authority can only be sealed once' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.sealed THEN RAISE EXCEPTION 'Seal original reporting after writing its complete slices' USING ERRCODE='23514'; END IF;
 SELECT * INTO levy FROM public.payroll_opening_levy_source_authorities h
  WHERE h.org_id=NEW.org_id AND h.id=NEW.levy_authority_id AND h.sealed
    AND NOT EXISTS (SELECT 1 FROM public.payroll_opening_levy_source_authorities successor
      WHERE successor.org_id=h.org_id AND successor.supersedes_authority_id=h.id) FOR SHARE;
 SELECT * INTO employer FROM public.payroll_opening_employer_authorities e
  WHERE e.org_id=NEW.org_id AND e.id=NEW.employer_authority_id FOR SHARE;
 SELECT to_jsonb(b) INTO retained FROM public.payroll_opening_balances b
  WHERE b.org_id=NEW.org_id AND b.id=NEW.opening_balance_id FOR SHARE;
 IF levy.id IS NULL OR employer.id IS NULL OR retained IS NULL
   OR (levy.opening_balance_id,levy.employer_authority_id,levy.employee_party_id,levy.tax_year,levy.subsidiary_id,levy.original_country,levy.original_currency,levy.coverage_start,levy.coverage_end)
      IS DISTINCT FROM (NEW.opening_balance_id,NEW.employer_authority_id,NEW.employee_party_id,NEW.tax_year,NEW.subsidiary_id,NEW.original_country,NEW.original_currency,NEW.coverage_start,NEW.coverage_end)
   OR NOT levy.coverage_complete OR levy.allocation_sha256<>NEW.levy_allocation_sha256
   OR levy.allocation_sha256<>encode(public.digest(levy.allocation_snapshot::text,'sha256'),'hex')
   OR levy.allocation_snapshot IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'programKey',a.program_key,'region',a.region,'subRegion',a.sub_region,'filingAccountId',a.filing_account_id,
      'federalAccountId',a.federal_account_id,'amount',a.amount::text)
      ORDER BY a.program_key,a.region,a.sub_region,a.filing_account_id NULLS FIRST,a.federal_account_id NULLS FIRST),'[]'::jsonb)
      FROM public.payroll_opening_levy_source_allocations a WHERE a.org_id=levy.org_id AND a.authority_id=levy.id)
   OR employer.opening_balance_id<>NEW.opening_balance_id OR employer.employee_party_id<>NEW.employee_party_id
   OR employer.tax_year<>NEW.tax_year OR employer.subsidiary_id<>NEW.subsidiary_id
   OR NEW.opening_snapshot IS DISTINCT FROM retained OR employer.opening_snapshot IS DISTINCT FROM retained
   OR NEW.opening_sha256<>encode(public.digest(retained::text,'sha256'),'hex')
   OR employer.opening_sha256<>NEW.opening_sha256 OR levy.opening_sha256<>NEW.opening_sha256
   OR NEW.annual_amounts IS DISTINCT FROM public.payroll_ca_opening_reporting_annual(retained)
   OR NEW.opening_children_snapshot IS DISTINCT FROM public.payroll_opening_source_children(NEW.org_id,NEW.opening_balance_id,NEW.employee_party_id,NEW.tax_year)
   OR levy.opening_children_snapshot IS DISTINCT FROM NEW.opening_children_snapshot
   OR NEW.opening_children_sha256<>encode(public.digest(NEW.opening_children_snapshot::text,'sha256'),'hex')
   OR levy.opening_children_sha256<>NEW.opening_children_sha256 THEN
   RAISE EXCEPTION 'Resolve the exact current Canadian levy certificate, original payer and unchanged annual and child history' USING ERRCODE='23514';
 END IF;
 IF (NEW.annual_amounts->>'fica_withheld_ytd')::numeric IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'Original Canadian reporting cannot contain foreign statutory annual amounts' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
     WHERE f.org_id=levy.org_id AND f.id=levy.source_file_id AND v.id=levy.source_version_id AND v.content_hash=levy.source_sha256)
   OR NOT EXISTS (SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
     WHERE f.org_id=employer.org_id AND f.id=employer.source_file_id AND v.id=employer.source_version_id AND v.content_hash=employer.source_sha256) THEN
   RAISE EXCEPTION 'Retained original levy and payer evidence is unavailable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
   SELECT v.id INTO source_version FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
    WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND f.current_version_id=NEW.source_version_id AND NOT f.is_inactive
      AND v.id=NEW.source_version_id AND v.content_hash=NEW.source_sha256 AND v.created_by=NEW.created_by FOR SHARE OF f,v;
   IF source_version IS NULL THEN RAISE EXCEPTION 'Select the current original Cabinet file version uploaded by this operator' USING ERRCODE='23514'; END IF;
   IF EXISTS (SELECT 1 FROM public.payroll_filing_submissions WHERE org_id=NEW.org_id AND tax_year=NEW.tax_year)
     OR EXISTS (SELECT 1 FROM public.pay_runs r JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
       WHERE r.org_id=NEW.org_id AND r.tax_year=NEW.tax_year AND r.run_status='committed' AND d.status<>'voided'
       AND (d.subsidiary_id=NEW.subsidiary_id OR EXISTS (SELECT 1 FROM public.pay_stubs s
         WHERE s.org_id=r.org_id AND s.pay_run_document_id=r.document_id AND s.employee_party_id=NEW.employee_party_id))) THEN
     RAISE EXCEPTION 'Issued filings or committed payroll preserve this original source; original reporting adoption is unavailable' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 actual := public.payroll_ca_opening_reporting_allocations_snapshot(NEW.org_id,NEW.id);
 IF actual IS DISTINCT FROM NEW.allocation_snapshot OR jsonb_array_length(actual)=0
   OR NEW.allocation_sha256<>encode(public.digest(actual::text,'sha256'),'hex') THEN
   RAISE EXCEPTION 'Seal every exact Canadian reporting slice with its native allocation digest' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM (SELECT first_covered_pay_date,
    lag(first_covered_pay_date) OVER (ORDER BY source_ordinal) AS previous_date
    FROM public.payroll_ca_opening_reporting_allocations WHERE org_id=NEW.org_id AND authority_id=NEW.id) ordered
    WHERE first_covered_pay_date<previous_date) THEN
   RAISE EXCEPTION 'Source ordinal must preserve original first covered pay date chronology' USING ERRCODE='23514';
 END IF;
 FOR original_row IN SELECT jsonb_build_object('key',key,'value',value) FROM jsonb_each(NEW.annual_amounts) LOOP
   SELECT sum((a.annual_amounts->>(original_row->>'key'))::numeric) INTO allocated_total
    FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id;
   IF allocated_total IS DISTINCT FROM (original_row->>'value')::numeric THEN
    RAISE EXCEPTION 'Reporting annual slices must equal every exact original annual amount' USING ERRCODE='23514';
   END IF;
 END LOOP;

 IF NEW.tax_year<>2026 THEN RAISE EXCEPTION 'Original reporting year has no declared Canadian annual maxima' USING ERRCODE='23514'; END IF;
 IF (SELECT sum((a.reportable_bases->>'ei')::numeric) FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id)
      IS DISTINCT FROM least((NEW.annual_amounts->>'insurable_ytd')::numeric,68900::numeric)
   OR (SELECT sum((a.reportable_bases->>'cpp')::numeric) FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id)
      IS DISTINCT FROM least((NEW.annual_amounts->>'pensionable_ytd')::numeric,85000::numeric)
   OR (SELECT sum((a.reportable_bases->>'qpip')::numeric) FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id)
      IS DISTINCT FROM least(coalesce((SELECT sum((r->>'insurable_ytd')::numeric) FROM jsonb_array_elements(NEW.opening_children_snapshot->'programBases') r WHERE r->>'program_key'='qpip'),0),103000::numeric) THEN
   RAISE EXCEPTION 'Original reported bases must reconcile exactly to annual maxima and unchanged original earnings' USING ERRCODE='23514';
 END IF;
 SELECT count(*) INTO slice_count FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id;
 FOREACH family IN ARRAY ARRAY['components','programBases','accountBases','suiStates'] LOOP
   amount_key := CASE WHEN family='components' THEN 'ytd_amount' ELSE 'insurable_ytd' END;
   FOR original_row IN SELECT value FROM jsonb_array_elements(NEW.opening_children_snapshot->family) LOOP
    identity := public.payroll_ca_opening_reporting_child_identity(family,original_row);
    original_value := original_row->>amount_key;
    SELECT sum((child.value->>amount_key)::numeric) INTO allocated_total
     FROM public.payroll_ca_opening_reporting_allocations a CROSS JOIN LATERAL jsonb_array_elements(a.children->family) child(value)
     WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id
       AND public.payroll_ca_opening_reporting_child_identity(family,child.value)=identity;
    IF allocated_total IS DISTINCT FROM original_value::numeric OR
      (SELECT count(*) FROM public.payroll_ca_opening_reporting_allocations a CROSS JOIN LATERAL jsonb_array_elements(a.children->family) child(value)
       WHERE a.org_id=NEW.org_id AND a.authority_id=NEW.id
        AND public.payroll_ca_opening_reporting_child_identity(family,child.value)=identity)<>slice_count THEN
     RAISE EXCEPTION 'Reporting child slices must preserve each exact original identity and amount, including zeros' USING ERRCODE='23514';
    END IF;
   END LOOP;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_ca_opening_reporting_authority_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_ca_opening_reporting_authorities FOR EACH ROW EXECUTE FUNCTION public.payroll_ca_opening_reporting_authority_guard();

CREATE FUNCTION public.payroll_ca_opening_reporting_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE authority public.payroll_ca_opening_reporting_authorities%ROWTYPE; family text; child jsonb; amount_key text;
 child_identity jsonb; keys text[]; row_count integer;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Original Canadian reporting slices are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO authority FROM public.payroll_ca_opening_reporting_authorities h WHERE h.org_id=NEW.org_id AND h.id=NEW.authority_id FOR UPDATE;
 IF authority.id IS NULL OR authority.sealed OR NEW.created_by<>authority.created_by
   OR NEW.first_covered_pay_date NOT BETWEEN authority.coverage_start AND authority.coverage_end THEN
   RAISE EXCEPTION 'Write source-attested slices within the original coverage before sealing the certificate' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.payroll_filing_accounts f WHERE f.org_id=NEW.org_id AND f.id=NEW.filing_account_id
   AND f.country='CA' AND f.program_type='ca_rp' AND f.subsidiary_id=authority.subsidiary_id FOR SHARE) THEN
   RAISE EXCEPTION 'Original RP must belong to the exact Canadian legal employer' USING ERRCODE='23514';
 END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.annual_amounts) key)
    IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(authority.annual_amounts) key)
   OR EXISTS (SELECT 1 FROM jsonb_each(NEW.annual_amounts) a WHERE jsonb_typeof(a.value)<>'string'
      OR (a.value#>>'{}') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$')
   OR (NEW.province<>'QC' AND EXISTS (SELECT 1 FROM jsonb_each_text(NEW.annual_amounts) a
     WHERE a.key IN ('qpip_ytd','qpip_employer_ytd','qc_tax_ytd','qc_csb_ytd','ca_avg_qpip','ca_avg_bonus_qpip') AND a.value::numeric<>0)) THEN
   RAISE EXCEPTION 'Declare all original annual fields as exact nonnegative decimals in their original jurisdiction' USING ERRCODE='23514';
 END IF;

 IF jsonb_typeof(NEW.reportable_bases) IS DISTINCT FROM 'object'
   OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.reportable_bases) key) IS DISTINCT FROM ARRAY['cpp','ei','qpip']::text[]
   OR EXISTS (SELECT 1 FROM jsonb_each(NEW.reportable_bases) r WHERE jsonb_typeof(r.value)<>'string' OR (r.value#>>'{}') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$')
   OR (NEW.reportable_bases->>'ei')::numeric>(NEW.annual_amounts->>'insurable_ytd')::numeric
   OR (NEW.reportable_bases->>'cpp')::numeric>(NEW.annual_amounts->>'pensionable_ytd')::numeric
   OR (NEW.reportable_bases->>'qpip')::numeric>coalesce((SELECT sum((r->>'insurable_ytd')::numeric) FROM jsonb_array_elements(NEW.children->'programBases') r WHERE r->>'program_key'='qpip'),0)
   OR NEW.province<>'QC' AND (NEW.reportable_bases->>'qpip')::numeric<>0 THEN
   RAISE EXCEPTION 'Declare exact source-attested reported bases within their allocated original earnings' USING ERRCODE='23514';
 END IF;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.children) key)
    IS DISTINCT FROM ARRAY['accountBases','components','programBases','suiStates']::text[] THEN
   RAISE EXCEPTION 'Declare all four original opening child families' USING ERRCODE='23514';
 END IF;
 FOREACH family IN ARRAY ARRAY['components','programBases','accountBases','suiStates'] LOOP
   IF jsonb_typeof(NEW.children->family) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Declare original child arrays including explicit empty arrays' USING ERRCODE='23514'; END IF;
   amount_key := CASE WHEN family='components' THEN 'ytd_amount' ELSE 'insurable_ytd' END;
   keys := CASE family WHEN 'components' THEN ARRAY['component_id','ytd_amount']
      WHEN 'programBases' THEN ARRAY['insurable_ytd','program_key']
      WHEN 'accountBases' THEN ARRAY['filing_account_id','insurable_ytd','program_key','region'] ELSE ARRAY['insurable_ytd','state'] END;
   IF jsonb_array_length(NEW.children->family)<>jsonb_array_length(authority.opening_children_snapshot->family) THEN
    RAISE EXCEPTION 'Every slice requires all original child identities including zeros' USING ERRCODE='23514';
   END IF;
   FOR child IN SELECT value FROM jsonb_array_elements(NEW.children->family) LOOP
    IF jsonb_typeof(child)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(child) key) IS DISTINCT FROM keys
      OR jsonb_typeof(child->amount_key) IS DISTINCT FROM 'string' OR child->>amount_key !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' THEN
     RAISE EXCEPTION 'Original child slices require exact native identities and nonnegative decimal amounts' USING ERRCODE='23514';
    END IF;
    child_identity := public.payroll_ca_opening_reporting_child_identity(family,child);
    SELECT count(*) INTO row_count FROM jsonb_array_elements(NEW.children->family) r WHERE public.payroll_ca_opening_reporting_child_identity(family,r.value)=child_identity;
    IF row_count<>1 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(authority.opening_children_snapshot->family) r
       WHERE public.payroll_ca_opening_reporting_child_identity(family,r.value)=child_identity) THEN
     RAISE EXCEPTION 'Reporting slices cannot omit, repeat or invent original child identities' USING ERRCODE='23514';
    END IF;
    IF family='components' AND NOT EXISTS (SELECT 1 FROM public.pay_components c
      WHERE c.org_id=NEW.org_id AND c.id=(child->>'component_id')::uuid AND (c.country IS NULL OR c.country='CA')) THEN
     RAISE EXCEPTION 'Original reporting component must be a native Canadian or common component' USING ERRCODE='23514';
    END IF;
    IF family IN ('programBases','accountBases') AND (child->>'program_key'<>'qpip'
       OR NEW.province<>'QC' AND (child->>amount_key)::numeric<>0) THEN
     RAISE EXCEPTION 'Original program base must resolve to the Canadian program and original jurisdiction' USING ERRCODE='23514';
    END IF;
    IF family='accountBases' AND ((child->'region'<>'null'::jsonb AND (jsonb_typeof(child->'region')<>'string'
       OR child->>'region' NOT IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','ZZ')))
      OR NOT EXISTS (SELECT 1 FROM public.payroll_filing_accounts f
      WHERE f.org_id=NEW.org_id AND f.id=(child->>'filing_account_id')::uuid AND f.country='CA' AND f.program_type='ca_rp'
       AND f.subsidiary_id=authority.subsidiary_id)
      OR (child->>amount_key)::numeric<>0 AND ((child->>'filing_account_id')::uuid<>NEW.filing_account_id
        OR child->>'region' IS NOT NULL AND child->>'region'<>NEW.province)) THEN
     RAISE EXCEPTION 'Original account bases cannot be moved between RP accounts or provinces' USING ERRCODE='23514';
    END IF;
    IF family='suiStates' AND (child->>amount_key)::numeric<>0 THEN RAISE EXCEPTION 'Canadian original reporting cannot contain US state unemployment wages' USING ERRCODE='23514'; END IF;
   END LOOP;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_ca_opening_reporting_allocation_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_ca_opening_reporting_allocations FOR EACH ROW EXECUTE FUNCTION public.payroll_ca_opening_reporting_allocation_guard();

CREATE FUNCTION public.payroll_ca_opening_reporting_sealed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.payroll_ca_opening_reporting_authorities h WHERE h.org_id=NEW.org_id AND h.id=NEW.id
   AND (NOT h.sealed OR NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.org_id=h.org_id
     AND a.table_name='payroll_ca_opening_reporting_authorities' AND a.row_id=h.id AND a.action='insert'
     AND a.actor_id=h.created_by AND a.changes->'after'=to_jsonb(h)
     AND a.changes->>'reason'=h.change_reason))) THEN
  RAISE EXCEPTION 'Original Canadian reporting authority must be sealed and audited in its creating transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER payroll_ca_opening_reporting_sealed_guard AFTER INSERT OR UPDATE
 ON public.payroll_ca_opening_reporting_authorities DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.payroll_ca_opening_reporting_sealed_guard();

CREATE FUNCTION public.payroll_ca_opening_reporting_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' OR (NEW.org_id,NEW.id,NEW.country,NEW.program_type,NEW.subsidiary_id,NEW.account_number)
    IS DISTINCT FROM (OLD.org_id,OLD.id,OLD.country,OLD.program_type,OLD.subsidiary_id,OLD.account_number) THEN
  IF EXISTS (SELECT 1 FROM public.payroll_ca_opening_reporting_allocations a WHERE a.org_id=OLD.org_id AND a.filing_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM public.payroll_ca_opening_reporting_authorities h
      CROSS JOIN LATERAL jsonb_array_elements(h.opening_children_snapshot->'accountBases') child(value)
      WHERE h.org_id=OLD.org_id AND child.value->>'filing_account_id'=OLD.id::text) THEN
   RAISE EXCEPTION 'Original Canadian reporting preserves its RP account and legal employer; create a distinct account for new identity' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER payroll_ca_opening_reporting_account_guard BEFORE UPDATE OR DELETE ON public.payroll_filing_accounts
 FOR EACH ROW EXECUTE FUNCTION public.payroll_ca_opening_reporting_account_guard();

ALTER TABLE public.payroll_ca_opening_reporting_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ca_opening_reporting_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_ca_opening_reporting_authorities
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_ca_opening_reporting_authorities IS 'openbooks:org_isolation:v1';
ALTER TABLE public.payroll_ca_opening_reporting_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_ca_opening_reporting_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_ca_opening_reporting_allocations
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_ca_opening_reporting_allocations IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_ca_opening_reporting_authorities
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_ca_opening_reporting_allocations
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
COMMENT ON TABLE public.payroll_ca_opening_reporting_authorities IS 'Immutable original Canadian reporting evidence bound to one exact current levy certificate, legal payer and all original opening amounts.';
COMMENT ON TABLE public.payroll_ca_opening_reporting_allocations IS 'Source-attested RP/province slices ordered by original source ordinal and first covered pay date; includes every annual and child amount, including zeros.';
SELECT public.openbooks_refresh_query_catalog();
