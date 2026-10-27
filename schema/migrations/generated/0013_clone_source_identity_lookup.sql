-- Find the source row of each cloned row through its primary key instead of rehashing every source row.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Clone admissions prove each copied row equals its rebased source row. A
-- rebased identifier is a one-way digest of the source identifier, so the
-- admissions found the source by rehashing every source row of the table for
-- each copied row, which is quadratic in the table's size. The clone now
-- records, in a transaction-local temporary table, the source identifier of
-- every row it copies; openbooks_clone_source_id reads that record and falls
-- back to the rehashing search when no record exists. Each admission keeps
-- its exact rebased-identifier equality, so a missing or wrong record can
-- only refuse a row, never admit one.

CREATE OR REPLACE FUNCTION public.openbooks_clone_source_id(relation regclass, source_org uuid, seed uuid, target_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE found uuid;
BEGIN
  IF relation IS NULL OR source_org IS NULL OR seed IS NULL OR target_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF to_regclass('pg_temp.openbooks_clone_source_map') IS NOT NULL THEN
    EXECUTE 'SELECT source_id FROM pg_temp.openbooks_clone_source_map WHERE relation = $1 AND target_id = $2'
      INTO found USING relation, target_id;
    IF found IS NOT NULL THEN
      RETURN found;
    END IF;
  END IF;
  EXECUTE format('SELECT id FROM %s WHERE org_id = $1 AND public.ob_rebase(id, $2) = $3 LIMIT 1', relation)
    INTO found USING source_org, seed, target_id;
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION public.field_ticket_source_certifications_clone_matches(candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
    FROM public.field_ticket_source_certifications source
   WHERE source.org_id = target.sandbox_of
     AND source.id = public.openbooks_clone_source_id('public.field_ticket_source_certifications'::regclass, target.sandbox_of, target.sandbox_seed, (candidate->>'id')::uuid)
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.field_ticket_source_certifications'::regclass
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
  END LOOP;
  expected := jsonb_set(expected, '{source_row_snapshot}', public.field_ticket_source_certification_clone_evidence(
    original->'source_row_snapshot', target.sandbox_seed, 'source_row_snapshot',
    (candidate->>'org_id')::uuid, target.masked));
  expected := jsonb_set(expected, '{reference_map}', public.field_ticket_source_certification_clone_evidence(
    original->'reference_map', target.sandbox_seed, 'reference_map',
    (candidate->>'org_id')::uuid, target.masked));
  expected := jsonb_set(expected, '{native_point_in_time}', public.field_ticket_source_certification_clone_evidence(
    original->'native_point_in_time', target.sandbox_seed, 'native_point_in_time',
    (candidate->>'org_id')::uuid, target.masked));
  IF target.masked THEN
    expected := jsonb_set(expected, '{attestation}', to_jsonb('REDACTED'::text));
    expected := jsonb_set(expected, '{reason}', to_jsonb('REDACTED'::text));
  END IF;
  RETURN candidate = expected;
END
$$;

CREATE OR REPLACE FUNCTION public.fx_revaluation_rate_evidence_clone_matches(candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
    FROM public.fx_revaluation_rate_evidence source
   WHERE source.org_id = target.sandbox_of
     AND source.id = public.openbooks_clone_source_id('public.fx_revaluation_rate_evidence'::regclass, target.sandbox_of, target.sandbox_seed, (candidate->>'id')::uuid)
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.fx_revaluation_rate_evidence'::regclass
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
    IF target.masked AND column_row.attname IN ('source', 'reason')
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb('REDACTED'::text));
    END IF;
  END LOOP;
  RETURN candidate = expected;
END
$$;

CREATE OR REPLACE FUNCTION public.pay_component_statutory_treatment_clone_matches(candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  target record;
  original jsonb;
  expected jsonb;
  column_row record;
BEGIN
  IF NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
  SELECT org.sandbox_of, org.sandbox_seed
    INTO target
    FROM public.orgs org
    JOIN public.sandboxes sandbox
      ON sandbox.org_id = org.id AND sandbox.production_org_id = org.sandbox_of
   WHERE org.id = (candidate->>'org_id')::uuid
     AND org.env_kind = 'sandbox'
     AND org.sandbox_seed IS NOT NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT to_jsonb(source)
    INTO original
    FROM public.pay_component_statutory_treatments source
   WHERE source.org_id = target.sandbox_of
     AND source.id = public.openbooks_clone_source_id('public.pay_component_statutory_treatments'::regclass, target.sandbox_of, target.sandbox_seed, (candidate->>'id')::uuid)
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.pay_component_statutory_treatments'::regclass
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
  END LOOP;
  RETURN candidate = expected;
END
$$;

CREATE OR REPLACE FUNCTION public.payroll_us_filing_account_lineage_clone_matches(candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
     AND source.id = public.openbooks_clone_source_id('public.payroll_us_filing_account_employer_lineage'::regclass, target.sandbox_of, target.sandbox_seed, (candidate->>'id')::uuid)
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
$$;

CREATE OR REPLACE FUNCTION public.inventory_serial_count_clone_line_matches(candidate public.stock_count_lines) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
 SELECT EXISTS(SELECT 1 FROM public.orgs target
  JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
  JOIN public.stock_count_lines source ON source.org_id=target.sandbox_of
  WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
   AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
   AND source.id=public.openbooks_clone_source_id('public.stock_count_lines'::regclass,target.sandbox_of,target.sandbox_seed,(candidate).id)
   AND public.ob_rebase(source.id,target.sandbox_seed)=(candidate).id
   AND (public.ob_rebase(source.stock_count_id,target.sandbox_seed),public.ob_rebase(source.item_id,target.sandbox_seed),
     public.ob_rebase(source.stock_location_id,target.sandbox_seed),public.ob_rebase(source.lot_id,target.sandbox_seed),
     public.ob_rebase(source.serial_id,target.sandbox_seed),public.ob_rebase(source.adjustment_movement_id,target.sandbox_seed),
     source.expected_quantity,source.counted_quantity,source.variance_tolerance,source.first_counted_quantity,
     source.second_counted_quantity,source.second_counted_at,public.ob_rebase(source.first_counted_by,target.sandbox_seed),
     public.ob_rebase(source.second_counted_by,target.sandbox_seed)) IS NOT DISTINCT FROM
    ((candidate).stock_count_id,(candidate).item_id,(candidate).stock_location_id,(candidate).lot_id,
     (candidate).serial_id,(candidate).adjustment_movement_id,(candidate).expected_quantity,(candidate).counted_quantity,
     (candidate).variance_tolerance,(candidate).first_counted_quantity,(candidate).second_counted_quantity,
     (candidate).second_counted_at,(candidate).first_counted_by,(candidate).second_counted_by)
 );
$$;

CREATE OR REPLACE FUNCTION public.inventory_serial_count_clone_marker_matches(candidate public.serials) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
 SELECT EXISTS(SELECT 1 FROM public.orgs target
  JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
  JOIN public.serials source ON source.org_id=target.sandbox_of
  WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
   AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
   AND source.id=public.openbooks_clone_source_id('public.serials'::regclass,target.sandbox_of,target.sandbox_seed,(candidate).id)
   AND public.ob_rebase(source.id,target.sandbox_seed)=(candidate).id
   AND (public.ob_rebase(source.item_id,target.sandbox_seed),public.ob_rebase(source.lot_id,target.sandbox_seed),
     public.ob_rebase(source.current_stock_location_id,target.sandbox_seed),source.status,
     public.ob_rebase(source.current_missing_count_movement_id,target.sandbox_seed)) IS NOT DISTINCT FROM
    ((candidate).item_id,(candidate).lot_id,(candidate).current_stock_location_id,(candidate).status,
     (candidate).current_missing_count_movement_id)
 );
$$;

CREATE OR REPLACE FUNCTION public.financial_history_native_clone_matches(relation regclass, candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE target record; original jsonb; expected jsonb; field record; reference record;
 parent_matches boolean; parent_predicate text; policy_prefix text; relation_name text;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN (
  'public.fx_rate_types'::regclass,'public.account_translation_policies'::regclass,
  'public.subsidiary_accounting_preferences'::regclass,'public.segment_balancing_policies'::regclass,
  'public.gl_audit_number_policies'::regclass,'public.gl_audit_number_assignments'::regclass,
  'public.journal_lines'::regclass,'public.rebate_agreements'::regclass) THEN RETURN false; END IF;
 SELECT destination.id,destination.sandbox_of,destination.sandbox_seed,control.masked INTO target
 FROM public.orgs destination JOIN public.sandboxes control
  ON control.org_id=destination.id AND control.production_org_id=destination.sandbox_of
 JOIN public.orgs source ON source.id=destination.sandbox_of AND source.id<>destination.id
 WHERE destination.id=(candidate->>'org_id')::uuid AND destination.env_kind='sandbox'
  AND destination.sandbox_seed IS NOT NULL AND control.status IN('provisioning','refreshing');
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND source.id=public.openbooks_clone_source_id($4,$1,$2,$3) AND public.ob_rebase(source.id,$2)=$3',relation)
 INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid,relation;
 IF original IS NULL THEN RETURN false; END IF;
 SELECT relname INTO relation_name FROM pg_catalog.pg_class WHERE oid=relation;
 expected:=original;
 FOR field IN SELECT attname,atttypid FROM pg_catalog.pg_attribute
  WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF field.attname='org_id' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb(target.id));
  ELSIF field.atttypid='uuid'::regtype AND jsonb_typeof(original->field.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb(public.ob_rebase((original->>field.attname)::uuid,target.sandbox_seed)));
  END IF;
  IF target.masked AND field.attname IN('name','reason','memo') AND jsonb_typeof(original->field.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[field.attname],to_jsonb('REDACTED'::text));
  END IF;
 END LOOP;
 IF jsonb_typeof(expected->'extra_dims')='object' THEN
  expected:=jsonb_set(expected,'{extra_dims}',coalesce((SELECT jsonb_object_agg(dim.key,CASE
   WHEN jsonb_typeof(dim.value)='string' AND EXISTS(SELECT 1 FROM public.segment_values value_row
    WHERE value_row.org_id=target.sandbox_of AND value_row.id::text=dim.value #>> '{}')
   THEN to_jsonb(public.ob_rebase((dim.value #>> '{}')::uuid,target.sandbox_seed)::text) ELSE dim.value END)
   FROM jsonb_each(expected->'extra_dims') dim),'{}'::jsonb));
 END IF;
 IF relation='public.journal_lines'::regclass AND coalesce(original->'custom'->>'equitySecurityId','') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
  expected:=jsonb_set(expected,'{custom}',(CASE WHEN target.masked THEN '{}'::jsonb ELSE original->'custom' END)
   || jsonb_build_object('equitySecurityId',public.ob_rebase((original->'custom'->>'equitySecurityId')::uuid,target.sandbox_seed)::text,
      'equityRole',original->'custom'->'equityRole'));
 ELSIF relation='public.journal_lines'::regclass AND target.masked THEN
  expected:=jsonb_set(expected,'{custom}','{}'::jsonb);
 END IF;
 IF relation='public.gl_audit_number_assignments'::regclass THEN
  SELECT prefix INTO policy_prefix FROM public.gl_audit_number_policies
   WHERE org_id=target.sandbox_of AND id=(original->>'policy_id')::uuid;
  IF policy_prefix IS NULL THEN RETURN false; END IF;
  expected:=jsonb_set(expected,'{scope_key}',to_jsonb(public.financial_history_clone_scope(original->>'scope_key',target.sandbox_seed)));
  expected:=jsonb_set(expected,'{audit_number}',to_jsonb(policy_prefix||'-'||replace(expected->>'scope_key',':','-')||'-'||
   lpad(original->>'ordinal',greatest(6,length(original->>'ordinal')),'0')));
 END IF;
 IF candidate IS DISTINCT FROM expected THEN RETURN false; END IF;
 -- Validate the complete referenced parent identity, including composite tenant keys,
 -- before admitting a recorded fact under its sandbox counterpart.
 FOR reference IN SELECT con.oid,con.confrelid FROM pg_catalog.pg_constraint con
  WHERE con.conrelid=relation AND con.contype='f' LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint con
   JOIN pg_catalog.pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
   WHERE con.oid=reference.oid AND (candidate->a.attname IS NULL OR candidate->a.attname='null'::jsonb)) THEN CONTINUE; END IF;
  SELECT string_agg(format('parent.%I=($1->>%L)::%s',parent_column.attname,source_column.attname,
    pg_catalog.format_type(source_column.atttypid,source_column.atttypmod)),' AND ' ORDER BY position)
   INTO parent_predicate FROM pg_catalog.pg_constraint con
   CROSS JOIN LATERAL generate_subscripts(con.conkey,1) position
   JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid=con.conrelid AND source_column.attnum=con.conkey[position]
   JOIN pg_catalog.pg_attribute parent_column ON parent_column.attrelid=con.confrelid AND parent_column.attnum=con.confkey[position]
   WHERE con.oid=reference.oid;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=reference.confrelid AND attname='org_id' AND NOT attisdropped) THEN
   parent_predicate:=parent_predicate||' AND parent.org_id=($1->>''org_id'')::uuid';
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s parent WHERE %s)',reference.confrelid::regclass,parent_predicate)
   INTO parent_matches USING candidate;
  IF NOT parent_matches THEN RETURN false; END IF;
 END LOOP;
 -- Legacy policy actor columns predate their explicit foreign keys.
 IF relation_name IN('fx_rate_types','account_translation_policies','subsidiary_accounting_preferences','segment_balancing_policies','gl_audit_number_policies') THEN
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[candidate->>'created_by',candidate->>'updated_by']) actor(id)
   WHERE actor.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.org_id=target.id AND u.id=actor.id::uuid)) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $_$;

CREATE OR REPLACE FUNCTION public.payroll_service_historical_clone_matches(relation regclass, candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE target record; original jsonb; expected jsonb; column_row record; removed jsonb;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN ('public.payroll_vacation_terms'::regclass,
  'public.payroll_service_credits'::regclass,'public.entitlement_service_tiers'::regclass) THEN RETURN false; END IF;
 SELECT o.id,o.sandbox_of,o.sandbox_seed,s.masked INTO target FROM public.orgs o
 JOIN public.sandboxes s ON s.org_id=o.id AND s.production_org_id=o.sandbox_of
 WHERE o.id=(candidate->>'org_id')::uuid AND o.env_kind='sandbox' AND o.sandbox_seed IS NOT NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND source.id=public.openbooks_clone_source_id($4,$1,$2,$3) AND public.ob_rebase(source.id,$2)=$3',relation)
 INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid,relation;
 IF original IS NULL THEN RETURN false; END IF;
 expected:=original;
 FOR column_row IN SELECT attname,atttypid,attnotnull FROM pg_catalog.pg_attribute WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF column_row.attname='org_id' THEN expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(target.id));
  ELSIF column_row.atttypid='uuid'::regtype AND jsonb_typeof(original->column_row.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(public.ob_rebase((original->>column_row.attname)::uuid,target.sandbox_seed)));
  END IF;
  IF target.masked AND column_row.attname IN('source_snapshot','reason') AND EXISTS(
   SELECT 1 FROM public.masking_policies p WHERE p.org_id=target.sandbox_of AND p.table_name=(SELECT relname FROM pg_class WHERE oid=relation)
    AND p.column_name=column_row.attname AND p.is_active AND
      ((column_row.attname='source_snapshot' AND p.transform='null_out') OR (column_row.attname='reason' AND p.transform='redact'))) THEN
   removed:=CASE WHEN column_row.attname='reason' AND original->column_row.attname<>'null'::jsonb THEN to_jsonb('REDACTED'::text)
    WHEN column_row.attnotnull AND column_row.atttypid='jsonb'::regtype THEN '{}'::jsonb ELSE 'null'::jsonb END;
   expected:=jsonb_set(expected,ARRAY[column_row.attname],removed);
  END IF;
 END LOOP;
 RETURN candidate=expected;
END $_$;

CREATE OR REPLACE FUNCTION public.holiday_historical_clone_matches(relation regclass, candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE target record; original jsonb; expected jsonb; column_row record; projection text;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN (
  'public.payroll_holiday_obligations'::regclass,'public.payroll_holiday_occurrences'::regclass,
  'public.pay_run_holiday_allocations'::regclass) THEN RETURN false; END IF;
 SELECT o.id,o.sandbox_of,o.sandbox_seed,s.masked INTO target FROM public.orgs o
 JOIN public.sandboxes s ON s.org_id=o.id AND s.production_org_id=o.sandbox_of
 WHERE o.id=(candidate->>'org_id')::uuid AND o.env_kind='sandbox' AND o.sandbox_seed IS NOT NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 IF relation='public.payroll_holiday_occurrences'::regclass THEN
  SELECT to_jsonb(source) INTO original FROM public.payroll_holiday_occurrences source
   WHERE source.org_id=target.sandbox_of
    AND source.obligation_id=public.openbooks_clone_source_id('public.payroll_holiday_obligations'::regclass,target.sandbox_of,target.sandbox_seed,(candidate->>'obligation_id')::uuid)
    AND public.ob_rebase(source.obligation_id,target.sandbox_seed)=(candidate->>'obligation_id')::uuid
    AND source.holiday_date=(candidate->>'holiday_date')::date;
 ELSE
  EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND source.id=public.openbooks_clone_source_id($4,$1,$2,$3) AND public.ob_rebase(source.id,$2)=$3',relation)
   INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid,relation;
 END IF;
 IF original IS NULL THEN RETURN false; END IF;
 expected:=original;
 FOR column_row IN SELECT attname,atttypid,attnotnull FROM pg_catalog.pg_attribute
  WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF column_row.attname='org_id' THEN expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(target.id));
  ELSIF column_row.atttypid='uuid'::regtype AND jsonb_typeof(original->column_row.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(public.ob_rebase((original->>column_row.attname)::uuid,target.sandbox_seed)));
  ELSIF (relation='public.payroll_holiday_obligations'::regclass AND column_row.attname='evidence') OR
        (relation='public.pay_run_holiday_allocations'::regclass AND column_row.attname='source_snapshot') THEN
   projection:=column_row.attname;
   expected:=jsonb_set(expected,ARRAY[projection],public.holiday_clone_json(original->projection,projection,target.sandbox_seed));
   IF target.masked AND EXISTS(SELECT 1 FROM public.masking_policies p WHERE p.org_id=target.sandbox_of
    AND p.table_name=CASE relation WHEN 'public.payroll_holiday_obligations'::regclass THEN 'payroll_holiday_obligations' ELSE 'pay_run_holiday_allocations' END
    AND p.column_name=projection AND p.is_active AND p.transform='null_out') THEN
    expected:=jsonb_set(expected,ARRAY[projection],'{}'::jsonb);
   END IF;
  END IF;
 END LOOP;
 RETURN candidate=expected;
END $_$;
