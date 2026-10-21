-- Bind portal return submission evidence to its live, customer-scoped session.
-- Preserve existing routing policy, graph snapshots and immutable receipt history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.flow_portal_return_source_valid(target_org uuid,target_document uuid,request jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM l.id FROM public.documents d
 JOIN public.customer_portal_links l ON l.org_id=d.org_id AND l.party_id=d.party_id
   AND l.id::text=request->>'linkId'
 WHERE d.org_id=target_org AND d.id=target_document AND d.kind='rma'
   AND d.custom->'portalRequest' IS NOT DISTINCT FROM request
   AND request->>'partyId'=d.party_id::text
   AND l.purpose='session' AND l.consumed_at IS NULL AND l.expires_at>now()
 FOR SHARE OF l;
 RETURN FOUND;
END $$;

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
 IF (NEW.actor_id IS NULL AND NOT (
     NEW.context->>'event_source' IS NOT DISTINCT FROM 'schedule'
     OR (NEW.context->>'event_source' IS NOT DISTINCT FROM 'portal'
       AND NEW.subject_kind='rma' AND public.flow_portal_return_source_valid(NEW.org_id,NEW.subject_id,NEW.context->'portalRequest'))
     OR (NEW.context->>'event_source' IS NOT DISTINCT FROM 'sync'
       AND NEW.subject_kind IN ('cash_sale','cash_refund')
       AND EXISTS(SELECT 1 FROM public.documents d JOIN public.sales_channels c
         ON c.org_id=d.org_id AND c.id=d.source_channel_id AND c.kind=d.external_source
         WHERE d.org_id=NEW.org_id AND d.id=NEW.subject_id AND d.kind=NEW.subject_kind
           AND nullif(btrim(d.external_ref),'') IS NOT NULL AND c.status='active'))
   ))
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
