-- Consolidate connector field configuration under the versioned entity mapping model.
-- Retain conflicting, unsupported and unreadable rules as explicit operator refusals.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DO $connection_mappings$
DECLARE
  conn record;
  model jsonb;
  options jsonb;
  saved jsonb;
  unresolved jsonb;
  candidate record;
  pair record;
  normalized text[];
  identity text;
  valid boolean;
  reason text;
  next_config jsonb;
  identifiers constant text[] := ARRAY['projectForemanField','projectPurchaseOrderField','lineMarkupField',
    'lineBillableField','itemCategoryField','customerShortCodeField','employeeBenefitsField','timeTypeRecord',
    'timeTypeMultiplierField','timeEntryTypeField','timeEntryFieldTicketNumberField','crmProbabilityField'];
BEGIN
  FOR conn IN SELECT id,org_id,source,config FROM public.connections WHERE config ? 'mappingJson' ORDER BY org_id,id FOR UPDATE
  LOOP
    model := COALESCE(NULLIF(conn.config->'entityMappings','null'::jsonb),'{"version":1,"entities":{}}'::jsonb);
    IF jsonb_typeof(model) IS DISTINCT FROM 'object' OR model->'version' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(model->'entities') IS DISTINCT FROM 'object'
      OR (model ? 'sourceOptions' AND jsonb_typeof(model->'sourceOptions') IS DISTINCT FROM 'object')
      OR (model ? 'unavailableRules' AND jsonb_typeof(model->'unavailableRules') IS DISTINCT FROM 'array') THEN
      model := jsonb_build_object('version',1,'entities','{}'::jsonb,'unavailableRules',
        jsonb_build_array(jsonb_build_object('key','entityMappings','value',model,'reason','Review or remove this unreadable saved entity mapping.')));
    END IF;
    options := COALESCE(model->'sourceOptions','{}'::jsonb);
    unresolved := COALESCE(model->'unavailableRules','[]'::jsonb);
    saved := conn.config->'mappingJson';
    IF jsonb_typeof(saved)='string' THEN
      BEGIN
        saved := CASE WHEN btrim(saved#>>'{}')='' THEN '{}'::jsonb ELSE (saved#>>'{}')::jsonb END;
      EXCEPTION WHEN invalid_text_representation THEN saved := NULL;
      END;
    END IF;
    IF saved IS NULL OR jsonb_typeof(saved) NOT IN ('object','null') THEN
      unresolved := unresolved || jsonb_build_array(jsonb_build_object('key','savedMapping','value',conn.config->'mappingJson',
        'reason','Review or remove this unreadable saved source mapping.'));
    ELSIF jsonb_typeof(saved)='object' THEN
      FOR candidate IN SELECT key,value FROM jsonb_each(saved) ORDER BY key
      LOOP
        reason := NULL;
        IF options ? candidate.key AND options->candidate.key IS DISTINCT FROM candidate.value THEN
          reason := 'This saved rule conflicts with its structured source option. Resolve the conflicting rule explicitly.';
        ELSIF conn.source<>'netsuite' THEN
          reason := 'This connector does not support the saved source option.';
        ELSIF candidate.key=ANY(identifiers) THEN
          IF candidate.value NOT IN ('null'::jsonb,'""'::jsonb) AND
            (jsonb_typeof(candidate.value)<>'string' OR btrim(candidate.value#>>'{}') !~ '^[a-zA-Z][a-zA-Z0-9_]{0,119}$') THEN
            reason := 'Choose a source field or record identifier for this rule.';
          ELSIF candidate.key='timeTypeMultiplierField' AND candidate.value NOT IN ('null'::jsonb,'""'::jsonb) AND
            COALESCE(NULLIF(options->>'timeTypeRecord',''),NULLIF(saved->>'timeTypeRecord','')) IS NULL THEN
            reason := 'Choose the source time-type record before its multiplier field.';
          END IF;
        ELSIF candidate.key IN ('projectStatuses','projectBillingTypes','taxCodeFallbacks') THEN
          IF candidate.value NOT IN ('null'::jsonb,'""'::jsonb) THEN
            valid := jsonb_typeof(candidate.value)='object';
            normalized := ARRAY[]::text[];
            IF valid THEN
              valid := candidate.value<>'{}'::jsonb;
              FOR pair IN SELECT key,value FROM jsonb_each(candidate.value)
              LOOP
                identity := CASE WHEN candidate.key='projectStatuses' THEN lower(btrim(pair.key)) ELSE upper(btrim(pair.key)) END;
                IF identity='' OR identity=ANY(normalized) OR jsonb_typeof(pair.value)<>'string' THEN valid:=false; END IF;
                normalized := array_append(normalized,identity);
                IF candidate.key='projectStatuses' AND pair.value#>>'{}' NOT IN ('active','awarded','substantially_complete','closed','cancelled') THEN valid:=false; END IF;
                IF candidate.key='projectBillingTypes' AND pair.value#>>'{}' NOT IN ('time_and_materials','fixed_price','cost_plus','not_to_exceed') THEN valid:=false; END IF;
                IF candidate.key='taxCodeFallbacks' AND (pair.key NOT IN ('sales','purchase') OR btrim(pair.value#>>'{}') !~ '^-?[0-9]+(\.[0-9]+)?$') THEN valid:=false; END IF;
              END LOOP;
            END IF;
            IF NOT valid THEN reason := 'Review the saved source values and choose supported mapping targets.'; END IF;
          END IF;
        ELSE reason := 'This source option is unsupported; retain its recorded value until explicitly removed.';
        END IF;
        IF reason IS NULL THEN options := options || jsonb_build_object(candidate.key,candidate.value);
        ELSE unresolved := unresolved || jsonb_build_array(jsonb_build_object('key',candidate.key,'value',candidate.value,'reason',reason));
        END IF;
      END LOOP;
    END IF;
    IF jsonb_array_length(unresolved)>500 THEN
      RAISE EXCEPTION 'Connection % has more than 500 unresolved saved rules. Review its mapping configuration before upgrading.',conn.id;
    END IF;
    model := model || jsonb_build_object('sourceOptions',options);
    IF jsonb_array_length(unresolved)>0 OR model ? 'unavailableRules' THEN model := model || jsonb_build_object('unavailableRules',unresolved); END IF;
    next_config := (conn.config-'mappingJson') || jsonb_build_object('entityMappings',model);
    UPDATE public.connections SET config=next_config,updated_at=clock_timestamp(),updated_by=NULL WHERE org_id=conn.org_id AND id=conn.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Connection mapping adoption matched no connection'; END IF;
    INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
    VALUES(conn.org_id,'connections',conn.id,'update',NULL,jsonb_build_object('reason','Connector mappings use one structured configuration.',
      'before',jsonb_build_object('mappingSha256',encode(digest((conn.config->'mappingJson')::text,'sha256'),'hex'),
        'entityMappingsSha256',encode(digest((conn.config->'entityMappings')::text,'sha256'),'hex')),
      'after',jsonb_build_object('entityMappingsSha256',encode(digest(model::text,'sha256'),'hex'),
        'sourceOptionKeys',(SELECT jsonb_agg(key ORDER BY key) FROM jsonb_object_keys(options) AS keys(key)),
        'unresolvedRules',jsonb_array_length(unresolved))));
  END LOOP;
END
$connection_mappings$;
