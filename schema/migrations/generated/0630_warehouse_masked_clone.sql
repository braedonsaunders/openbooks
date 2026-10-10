-- Masked warehouse copies retain dated movements and stock links, removing arbitrary payload fields and authored prose.
CREATE FUNCTION public.warehouse_execution_mask_json(payload jsonb,seed uuid,kind text)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE rebased jsonb; element jsonb; result jsonb;
BEGIN
 IF payload IS NULL THEN RETURN NULL; END IF;
 rebased:=public.warehouse_execution_clone_json(payload,seed);
 IF kind='request' THEN
  RETURN jsonb_build_object('toBinId',(rebased->>'toBinId')::uuid::text,
   'date',(rebased->>'date')::date::text,'reason','REDACTED');
 ELSIF kind='movements' THEN
  result:='[]'::jsonb;
  FOR element IN SELECT value FROM jsonb_array_elements(rebased) LOOP
   IF element->'value' IS NULL OR jsonb_typeof(element->'value') NOT IN ('string','number') OR
      (element->>'value')!~'^[+-]?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Warehouse movement value requires exact numeric evidence before masking';
   END IF;
   result:=result||jsonb_build_array(jsonb_build_object(
    'shipmentLineId',(element->>'shipmentLineId')::uuid::text,
    'fromMovementId',(element->>'fromMovementId')::uuid::text,
    'toMovementId',(element->>'toMovementId')::uuid::text,
    'entryId',(element->>'entryId')::uuid::text,'value',element->'value'));
  END LOOP;
  RETURN result;
 END IF;
 RAISE EXCEPTION 'Unsupported warehouse evidence masking shape';
END $$;

CREATE OR REPLACE FUNCTION public.warehouse_execution_clone_row_matches(relation text,candidate jsonb)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE target public.orgs%ROWTYPE; source jsonb; expected jsonb; field record; key_column text;
BEGIN
 IF relation NOT IN('pick_execution_lines','handling_units','handling_unit_contents','handling_unit_moves')
   OR NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
 SELECT * INTO target FROM public.orgs org WHERE org.id=(candidate->>'org_id')::uuid AND org.env_kind='sandbox'
   AND org.sandbox_seed IS NOT NULL AND EXISTS(SELECT 1 FROM public.sandboxes control
     WHERE control.org_id=org.id AND control.production_org_id=org.sandbox_of);
 IF NOT FOUND THEN RETURN false; END IF;
 key_column=CASE relation WHEN 'pick_execution_lines' THEN 'line_id' WHEN 'handling_unit_contents' THEN 'shipment_line_id' ELSE 'id' END;
 EXECUTE format('SELECT to_jsonb(source) FROM public.%I source WHERE source.org_id=$1 AND public.ob_rebase(source.%I,$2)=($3->>%L)::uuid',relation,key_column,key_column)
   INTO source USING target.sandbox_of,target.sandbox_seed,candidate;
 IF source IS NULL THEN RETURN false; END IF;
 expected=source;
 FOR field IN SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('public.'||relation)
    AND atttypid='uuid'::regtype AND attnum>0 AND NOT attisdropped LOOP
  expected=jsonb_set(expected,ARRAY[field.attname],CASE WHEN field.attname='org_id' THEN to_jsonb(target.id::text)
    WHEN field.attname='confirmation_task_id' THEN 'null'::jsonb
    ELSE coalesce(to_jsonb(public.ob_rebase((source->>field.attname)::uuid,target.sandbox_seed)::text),'null'::jsonb) END);
 END LOOP;
 IF relation='handling_unit_moves' THEN
  expected=jsonb_set(expected,'{request}',public.warehouse_execution_clone_json(source->'request',target.sandbox_seed));
  expected=jsonb_set(expected,'{movements}',public.warehouse_execution_clone_json(source->'movements',target.sandbox_seed));
 END IF;
 IF EXISTS(SELECT 1 FROM public.sandboxes control WHERE control.org_id=target.id AND control.masked) THEN
  IF relation='handling_units' THEN
   expected=jsonb_set(expected,'{code}',to_jsonb(md5(source->>'code')));
  ELSIF relation='pick_execution_lines' THEN
   expected=jsonb_set(expected,'{reason}',CASE WHEN source->>'reason' IS NULL THEN 'null'::jsonb ELSE to_jsonb('REDACTED'::text) END);
  ELSIF relation='handling_unit_moves' THEN
   expected=jsonb_set(expected,'{command_key}',to_jsonb(md5(source->>'command_key')));
   expected=jsonb_set(expected,'{reason}',to_jsonb('REDACTED'::text));
   expected=jsonb_set(expected,'{request}',public.warehouse_execution_mask_json(source->'request',target.sandbox_seed,'request'));
   expected=jsonb_set(expected,'{movements}',public.warehouse_execution_mask_json(source->'movements',target.sandbox_seed,'movements'));
  END IF;
 END IF;
 RETURN expected=candidate;
END $$;
