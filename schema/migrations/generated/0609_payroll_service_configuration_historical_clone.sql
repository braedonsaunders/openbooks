-- Preserve exact historical service terms when copying a registered sandbox.
CREATE FUNCTION public.payroll_service_historical_clone_matches(relation regclass,candidate jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $function$
DECLARE target record; original jsonb; expected jsonb; column_row record; removed jsonb;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN ('public.payroll_vacation_terms'::regclass,
  'public.payroll_service_credits'::regclass,'public.entitlement_service_tiers'::regclass) THEN RETURN false; END IF;
 SELECT o.id,o.sandbox_of,o.sandbox_seed,s.masked INTO target FROM public.orgs o
 JOIN public.sandboxes s ON s.org_id=o.id AND s.production_org_id=o.sandbox_of
 WHERE o.id=(candidate->>'org_id')::uuid AND o.env_kind='sandbox' AND o.sandbox_seed IS NOT NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND public.ob_rebase(source.id,$2)=$3',relation)
 INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid;
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
END $function$;

CREATE OR REPLACE FUNCTION public.payroll_service_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE last_period_end date; target_org uuid; configurations jsonb;
BEGIN
 IF TG_OP='INSERT' AND public.payroll_service_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 target_org := CASE WHEN TG_OP = 'INSERT' THEN NEW.org_id ELSE OLD.org_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:payroll-service:' || target_org::text,0));
 IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 configurations := CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
  WHEN TG_OP = 'DELETE' THEN jsonb_build_array(to_jsonb(OLD)) ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END;
 SELECT max(r.period_end) INTO last_period_end FROM public.pay_runs r JOIN public.pay_stubs s
  ON s.org_id = r.org_id AND s.pay_run_document_id = r.document_id
 LEFT JOIN public.worker_employments e ON e.org_id=s.org_id AND e.id=s.employment_id
 WHERE r.org_id = target_org AND r.run_status IN ('committed','voided') AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(configurations) cfg
  WHERE (cfg->>'employment_id' IS NULL OR s.employment_id=(cfg->>'employment_id')::uuid)
    AND (cfg->>'employer_subsidiary_id' IS NULL OR e.employer_subsidiary_id IS NULL OR e.employer_subsidiary_id=(cfg->>'employer_subsidiary_id')::uuid)
    AND r.period_end >= (cfg->>'effective_from')::date
    AND (cfg->>'effective_to' IS NULL OR r.period_end <= (cfg->>'effective_to')::date)
 );
 IF last_period_end IS NOT NULL THEN
  IF TG_OP IN ('INSERT','DELETE') THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This service configuration affects committed payroll evidence. Preserve its terms and add a replacement effective after the last committed period end.';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['effective_to','updated_at','updated_by']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['effective_to','updated_at','updated_by']) OR NEW.effective_to IS NULL OR NEW.effective_to < last_period_end THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This service configuration has committed payroll evidence. Preserve its terms, close its window on or after the last committed period end, and add an effective-dated replacement.';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $func$;

SELECT public.openbooks_refresh_query_catalog();
