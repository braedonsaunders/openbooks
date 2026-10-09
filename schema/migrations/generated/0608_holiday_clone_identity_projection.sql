-- Qualify declared holiday identity array projections while preserving every nonidentity value.
CREATE OR REPLACE FUNCTION public.holiday_clone_json(value jsonb, kind text, seed uuid) RETURNS jsonb
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
   SELECT coalesce(jsonb_agg(to_jsonb(public.ob_rebase(a.value::uuid,seed)::text) ORDER BY a.ordinal),'[]'::jsonb)
    INTO entries FROM jsonb_array_elements_text(result->'requiredSubsidiaryIds') WITH ORDINALITY AS a(value,ordinal);
   result:=jsonb_set(result,'{requiredSubsidiaryIds}',entries);
  END IF;
 WHEN 'before_state' THEN
  paths:='[["employment","id"],["employment","worker_party_id"],["employment","employer_subsidiary_id"],["profile","id"],["profile","employment_id"],["profile","pay_schedule_id"]]'::jsonb;
  IF jsonb_typeof(result->'datedEmployment')='array' THEN
   SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(a.value->'id')='string'
    THEN jsonb_set(a.value,'{id}',to_jsonb(public.ob_rebase((a.value->>'id')::uuid,seed)::text)) ELSE a.value END ORDER BY a.ordinal),'[]'::jsonb)
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

SELECT public.openbooks_refresh_query_catalog();
