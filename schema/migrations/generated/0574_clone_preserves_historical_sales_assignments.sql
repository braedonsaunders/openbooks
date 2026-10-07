-- Preserve retained sales responsibility when cloning historical tenant records.
-- Only a privileged native INSERT into a registered sandbox may retain the
-- original row's rebased employee reference. New assignments still require an
-- active designated representative, including changes made inside sandboxes.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.sales_employee_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE
 field_name text; employee uuid; before_value jsonb; after_value jsonb;
 source_org uuid; clone_seed uuid; source_value jsonb; identity_field text;
BEGIN
 after_value:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN before_value:=to_jsonb(OLD); ELSE before_value:='{}'::jsonb; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  SELECT target.sandbox_of,target.sandbox_seed INTO source_org,clone_seed
   FROM public.orgs target
   JOIN public.sandboxes control ON control.org_id=target.id
     AND control.production_org_id=target.sandbox_of
   JOIN public.orgs source ON source.id=target.sandbox_of
   WHERE target.id=NEW.org_id AND target.env_kind='sandbox';
  IF source_org IS NOT NULL AND clone_seed IS NOT NULL THEN
   -- Customer role identities use party_id; the other guarded records use id.
   identity_field:=CASE WHEN TG_TABLE_NAME='customer_roles' THEN 'party_id' ELSE 'id' END;
   EXECUTE format(
    'SELECT to_jsonb(original) FROM %I.%I original WHERE original.org_id=$1
     AND public.ob_rebase(original.%I,$2)=$3 FOR SHARE',
    TG_TABLE_SCHEMA,TG_TABLE_NAME,identity_field)
    INTO source_value USING source_org,clone_seed,(after_value->>identity_field)::uuid;
  END IF;
 END IF;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  employee:=NULLIF(after_value->>field_name,'')::uuid;
  IF employee IS NOT NULL AND (TG_OP='INSERT' OR before_value->field_name IS DISTINCT FROM after_value->field_name) THEN
   IF source_value->>field_name IS NOT NULL
      AND public.ob_rebase((source_value->>field_name)::uuid,clone_seed)=employee THEN
    CONTINUE;
   END IF;
   PERFORM 1 FROM public.employee_roles e JOIN public.parties p ON p.org_id=e.org_id AND p.id=e.party_id
    WHERE e.org_id=NEW.org_id AND e.party_id=employee AND e.is_active AND e.is_sales_rep AND p.is_active
    AND (e.sales_rep_since IS NULL OR e.sales_rep_since<=COALESCE((after_value->>'period_start')::date,(after_value->>'valid_from')::date,(after_value->>'effective_from')::date,CURRENT_DATE)) FOR SHARE OF e,p;
   IF NOT FOUND THEN RAISE EXCEPTION 'Select an active employee designated as a sales representative in Sales → Representatives.' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
