-- Preserve exact approved holiday rights and settlement history in registered sandbox copies.
CREATE FUNCTION public.holiday_clone_json(value jsonb, kind text, seed uuid) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $function$
DECLARE result jsonb:=value; paths jsonb; item jsonb; path text[]; entries jsonb;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 CASE kind
 WHEN 'evidence' THEN paths:='[["instruction","employeePartyId"],["source","fileId"],["source","versionId"]]'::jsonb;
 WHEN 'payload' THEN
  paths:='[["employmentId"]]'::jsonb;
  IF result ? 'evidence' THEN result:=jsonb_set(result,'{evidence}',public.holiday_clone_json(result->'evidence','evidence',seed)); END IF;
  IF jsonb_typeof(result->'requiredSubsidiaryIds')='array' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(public.ob_rebase(value::text::uuid,seed)::text) ORDER BY ordinal),'[]'::jsonb)
    INTO entries FROM jsonb_array_elements_text(result->'requiredSubsidiaryIds') WITH ORDINALITY AS a(value,ordinal);
   result:=jsonb_set(result,'{requiredSubsidiaryIds}',entries);
  END IF;
 WHEN 'before_state' THEN
  paths:='[["employment","id"],["employment","worker_party_id"],["employment","employer_subsidiary_id"],["profile","id"],["profile","employment_id"],["profile","pay_schedule_id"]]'::jsonb;
  IF jsonb_typeof(result->'datedEmployment')='array' THEN
   SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(value->'id')='string'
    THEN jsonb_set(value,'{id}',to_jsonb(public.ob_rebase((value->>'id')::uuid,seed)::text)) ELSE value END ORDER BY ordinal),'[]'::jsonb)
    INTO entries FROM jsonb_array_elements(result->'datedEmployment') WITH ORDINALITY AS a(value,ordinal);
   result:=jsonb_set(result,'{datedEmployment}',entries);
  END IF;
 WHEN 'result' THEN paths:='[["obligationId"]]'::jsonb;
 WHEN 'source_snapshot' THEN
  paths:='[["wage","source","id"],["wage","fx","id"]]'::jsonb;
  IF result ? 'obligation' THEN result:=jsonb_set(result,'{obligation}',public.holiday_clone_json(result->'obligation','evidence',seed)); END IF;
 ELSE RAISE EXCEPTION 'Unknown holiday evidence projection.';
 END CASE;
 FOR item IN SELECT jsonb_array_elements(paths) LOOP
  SELECT array_agg(v ORDER BY ord) INTO path FROM jsonb_array_elements_text(item) WITH ORDINALITY a(v,ord);
  IF jsonb_typeof(result #> path)='string' THEN
   result:=jsonb_set(result,path,to_jsonb(public.ob_rebase((result #>> path)::uuid,seed)::text));
  END IF;
 END LOOP;
 RETURN result;
END $function$;

-- Authority comes from the native clone transaction and registered target;
-- every financial value, date, lifecycle state and source identity must match.
CREATE FUNCTION public.holiday_historical_clone_matches(relation regclass, candidate jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $function$
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
   WHERE source.org_id=target.sandbox_of AND public.ob_rebase(source.obligation_id,target.sandbox_seed)=(candidate->>'obligation_id')::uuid
    AND source.holiday_date=(candidate->>'holiday_date')::date;
 ELSE
  EXECUTE format('SELECT to_jsonb(source) FROM %s source WHERE source.org_id=$1 AND public.ob_rebase(source.id,$2)=$3',relation)
   INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid;
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
END $function$;

CREATE OR REPLACE FUNCTION public.payroll_holiday_obligation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE proposal public.financial_changes%ROWTYPE; obligation public.payroll_holiday_obligations%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND public.holiday_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN
  IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Approved holiday entitlement evidence is immutable; preserve it and use a governed correction.';
 END IF;
 IF TG_TABLE_NAME='payroll_holiday_occurrences' THEN
  SELECT * INTO STRICT obligation FROM public.payroll_holiday_obligations WHERE org_id=NEW.org_id AND id=NEW.obligation_id FOR SHARE;
  IF NOT coalesce(obligation.evidence->'instruction'->'holidayDates' ? NEW.holiday_date::text,false) THEN
   RAISE EXCEPTION 'A holiday occurrence must be named in its approved entitlement.';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id FOR SHARE;
 IF proposal.domain<>'payroll' OR proposal.operation<>'adjudicated_holiday_hours'
   OR proposal.status<>'approved' OR proposal.approved_by IS NULL OR proposal.approved_by=proposal.submitted_by
   OR proposal.subject_id IS DISTINCT FROM NEW.employee_party_id
   OR proposal.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
   OR proposal.effective_on IS DISTINCT FROM NEW.payment_date
   OR proposal.payload->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR proposal.payload->'evidence' IS DISTINCT FROM NEW.evidence
   OR proposal.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text) THEN
  RAISE EXCEPTION 'Unpaid holiday pay requires an independently approved proposal for this employee, employment, employer, payment date and exact source evidence.';
 END IF;
 IF NEW.evidence->'instruction'->>'employeePartyId' IS DISTINCT FROM NEW.employee_party_id::text
   OR NEW.evidence->'instruction'->>'paymentDate' IS DISTINCT FROM NEW.payment_date::text
   OR NEW.evidence->'source'->>'fileId' IS DISTINCT FROM NEW.source_file_id::text
   OR NEW.evidence->'source'->>'versionId' IS DISTINCT FROM NEW.source_version_id::text
   OR jsonb_typeof(NEW.evidence->'instruction'->'holidayDates') IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
       AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id)
   OR NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
       WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id
         AND lower(v.content_hash)=NEW.evidence->'source'->>'contentHash'
         AND lower(v.content_hash)=NEW.evidence->'instruction'->>'sourceDigest'
         AND v.version_number::text=NEW.evidence->'source'->>'versionNumber') THEN
  RAISE EXCEPTION 'The holiday entitlement must retain its exact tenant-owned employee and File Cabinet source version.';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.payroll_holiday_allocation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE run_row public.pay_runs%ROWTYPE; obligation public.payroll_holiday_obligations%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND public.holiday_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO STRICT run_row FROM public.pay_runs WHERE org_id=NEW.org_id AND document_id=NEW.pay_run_document_id FOR SHARE;
  SELECT * INTO STRICT obligation FROM public.payroll_holiday_obligations WHERE org_id=NEW.org_id AND id=NEW.obligation_id FOR SHARE;
  IF NEW.status<>'calculated' OR run_row.run_status NOT IN('draft','calculated') OR run_row.run_type<>'regular'
    OR run_row.pay_date IS DISTINCT FROM obligation.payment_date
    OR NEW.hours::text::numeric IS DISTINCT FROM (obligation.evidence->'instruction'->>'hours')::numeric
    OR NEW.source_snapshot->'obligation' IS DISTINCT FROM obligation.evidence
    OR NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.org_id=NEW.org_id AND d.id=NEW.pay_run_document_id
        AND d.subsidiary_id=obligation.subsidiary_id AND d.currency=NEW.currency)
    OR NOT EXISTS(SELECT 1 FROM public.financial_changes f WHERE f.org_id=obligation.org_id AND f.id=obligation.change_id AND f.status='applied')
    OR NOT EXISTS(SELECT 1 FROM public.pay_components c WHERE c.org_id=NEW.org_id AND c.id=NEW.component_id AND c.system_key='stat_holiday' AND c.kind='earning') THEN
   RAISE EXCEPTION 'Holiday settlement must claim an applied unpaid entitlement on its instructed regular pay date with exact source hours and the native holiday component.';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT run_row FROM public.pay_runs WHERE org_id=OLD.org_id AND document_id=OLD.pay_run_document_id FOR SHARE;
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND
    ((OLD.status='calculated' AND NEW.status='committed' AND run_row.run_status='calculated') OR
     (OLD.status='committed' AND NEW.status='voided' AND run_row.run_status='committed')) AND
    (to_jsonb(NEW)-ARRAY['status','updated_at','updated_by'])=(to_jsonb(OLD)-ARRAY['status','updated_at','updated_by']) THEN RETURN NEW; END IF;
 IF OLD.status<>'calculated' OR run_row.run_status NOT IN('draft','calculated') THEN
  RAISE EXCEPTION 'Committed holiday settlement evidence is immutable; void its native payroll before releasing the claim.';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.status<>'calculated' OR (to_jsonb(NEW)-ARRAY['pay_stub_line_id','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['pay_stub_line_id','updated_at','updated_by']) THEN
  RAISE EXCEPTION 'Calculated holiday pricing is frozen; recalculate the editable payroll instead of rewriting its claim.';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.payroll_holiday_occurrence_completeness() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE obligation public.payroll_holiday_obligations%ROWTYPE; actual jsonb; target_id uuid; source_dates jsonb;
BEGIN
 IF TG_TABLE_NAME='payroll_holiday_obligations' THEN target_id:=NEW.id; ELSE target_id:=NEW.obligation_id; END IF;
 SELECT * INTO obligation FROM public.payroll_holiday_obligations
  WHERE org_id=NEW.org_id AND id=target_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT jsonb_agg(holiday_date::text ORDER BY holiday_date) INTO actual FROM public.payroll_holiday_occurrences
  WHERE org_id=obligation.org_id AND obligation_id=obligation.id;
 IF public.holiday_historical_clone_matches('public.payroll_holiday_obligations'::regclass,to_jsonb(obligation)) THEN
  SELECT jsonb_agg(source.holiday_date::text ORDER BY source.holiday_date) INTO source_dates
   FROM public.orgs target JOIN public.payroll_holiday_occurrences source ON source.org_id=target.sandbox_of
    AND public.ob_rebase(source.obligation_id,target.sandbox_seed)=obligation.id WHERE target.id=obligation.org_id;
  IF actual IS DISTINCT FROM source_dates THEN RAISE EXCEPTION 'A sandbox must retain every original approved holiday occurrence exactly once.'; END IF;
  RETURN NULL;
 END IF;
 IF actual IS DISTINCT FROM obligation.evidence->'instruction'->'holidayDates' THEN
  RAISE EXCEPTION 'Record every approved holiday occurrence exactly once before completing the entitlement.';
 END IF;
 RETURN NULL;
END $function$;

SELECT public.openbooks_refresh_query_catalog();
