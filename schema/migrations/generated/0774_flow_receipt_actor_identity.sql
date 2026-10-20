-- Validate switched-tenant Flow submitters through the native locked home identity.
-- Retain all existing submission receipts and recorded decisions unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.flow_submission_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Flow submission evidence is immutable.';
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Flow submission evidence is immutable.'; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.actor_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.users u WHERE u.org_id=NEW.org_id AND u.id=NEW.actor_id AND u.is_active) THEN
   IF coalesce(NEW.context->>'submissionActorHomeOrgId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'The Flow submission requires its established active acting identity.' USING ERRCODE='23514';
   END IF;
   PERFORM public.lock_actor_home_identity(NEW.org_id,NEW.actor_id,(NEW.context->>'submissionActorHomeOrgId')::uuid);
  END IF;
 END IF;
 IF (NEW.actor_id IS NULL AND NEW.context->>'event_source' IS DISTINCT FROM 'schedule')
   OR NOT public.flow_submission_policy_valid(NEW.org_id,NEW.subject_kind,NEW.subject_id,NEW.actor_id,NEW.policy)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.policy->'runIds') claimed(id)
     WHERE NOT EXISTS(SELECT 1 FROM public.flow_runs r,
       LATERAL jsonb_array_elements(NEW.graphs) snapshot
       WHERE r.org_id=NEW.org_id AND r.id::text=claimed.id
        AND r.context #>> '{submissionPolicy,flowId}'=r.flow_id::text
        AND snapshot->>'id'=r.flow_id::text
        AND snapshot->'graph'=r.context #> '{submissionPolicy,graph}'))
   OR NEW.graphs IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'graph',f.graph) ORDER BY f.id),'[]'::jsonb)
     FROM public.flows f WHERE f.org_id=NEW.org_id AND f.subject_kind=NEW.subject_kind AND f.enabled) THEN
  RAISE EXCEPTION 'The Flow submission requires complete routing evidence and the current graph snapshots.';
 END IF;
 RETURN NEW;
END $$;
