-- Check a cloned financial row's parents in one statement instead of one per foreign key.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- The financial history clone admission proves that every referenced parent
-- of a copied row exists under the destination organization. It looked up
-- each foreign key's columns and ran a separate existence query per key, for
-- every copied row; a journal line has twelve keys. The same parent checks
-- are now assembled by one catalog query and evaluated by one statement, with
-- the same skipped null keys and composite tenant predicates.

CREATE OR REPLACE FUNCTION public.financial_history_native_clone_matches(relation regclass, candidate jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE target record; original jsonb; expected jsonb; field record;
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
 SELECT string_agg(format('EXISTS(SELECT 1 FROM %s parent WHERE %s)',checks.parent,checks.predicate),' AND ' ORDER BY checks.constraint_oid)
  INTO parent_predicate
  FROM (
   SELECT con.oid AS constraint_oid,con.confrelid::regclass AS parent,
    string_agg(format('parent.%I=($1->>%L)::%s',parent_column.attname,source_column.attname,
     pg_catalog.format_type(source_column.atttypid,source_column.atttypmod)),' AND ' ORDER BY position)
    ||CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid=con.confrelid AND attname='org_id' AND NOT attisdropped)
     THEN ' AND parent.org_id=($1->>''org_id'')::uuid' ELSE '' END AS predicate
   FROM pg_catalog.pg_constraint con
   CROSS JOIN LATERAL generate_subscripts(con.conkey,1) position
   JOIN pg_catalog.pg_attribute source_column ON source_column.attrelid=con.conrelid AND source_column.attnum=con.conkey[position]
   JOIN pg_catalog.pg_attribute parent_column ON parent_column.attrelid=con.confrelid AND parent_column.attnum=con.confkey[position]
   WHERE con.conrelid=relation AND con.contype='f'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=con.conrelid AND a.attnum=ANY(con.conkey)
      AND (candidate->a.attname IS NULL OR candidate->a.attname='null'::jsonb))
   GROUP BY con.oid,con.confrelid
  ) checks;
 IF parent_predicate IS NOT NULL THEN
  EXECUTE 'SELECT '||parent_predicate INTO parent_matches USING candidate;
  IF NOT parent_matches THEN RETURN false; END IF;
 END IF;
 -- Legacy policy actor columns predate their explicit foreign keys.
 IF relation_name IN('fx_rate_types','account_translation_policies','subsidiary_accounting_preferences','segment_balancing_policies','gl_audit_number_policies') THEN
  IF EXISTS(SELECT 1 FROM unnest(ARRAY[candidate->>'created_by',candidate->>'updated_by']) actor(id)
   WHERE actor.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.org_id=target.id AND u.id=actor.id::uuid)) THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $_$;
