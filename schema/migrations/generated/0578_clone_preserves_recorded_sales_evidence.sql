-- Preserve recorded sales credits and reversals during native sandbox copying.
-- Only privileged INSERTs into a registered sandbox may avoid recapture, and
-- only when every fact used by sales capture matches its rebased source.
-- Ordinary posting, opportunity reopening and immutable evidence stay enforced.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.sales_capture_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE is_credit boolean:=false; is_reversal boolean:=false; old_won boolean:=false; new_won boolean:=false; prior public.crm_sales_evidence; metric_name text; source_name text; source_number_value text; value numeric; event_date date; clone_target record;
BEGIN
 IF TG_TABLE_NAME='documents' THEN
  IF NEW.kind NOT IN ('customer_invoice','customer_credit') THEN RETURN NEW; END IF;
 END IF;

 -- Copying a sales source is not a new sale. Its immutable credit and reversal
 -- rows are copied separately, including records made before this trigger
 -- existed. Recapturing would duplicate a credit or invent historical evidence.
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  SELECT target.sandbox_of,target.sandbox_seed INTO clone_target
   FROM public.orgs target
   JOIN public.sandboxes control ON control.org_id=target.id
    AND control.production_org_id=target.sandbox_of
   JOIN public.orgs source ON source.id=target.sandbox_of
   WHERE target.id=NEW.org_id AND target.env_kind='sandbox'
    AND target.sandbox_seed IS NOT NULL;
  IF FOUND THEN
   IF TG_TABLE_NAME='documents' THEN
    PERFORM 1 FROM public.documents original
     WHERE original.org_id=clone_target.sandbox_of
      AND public.ob_rebase(original.id,clone_target.sandbox_seed)=NEW.id
      AND (original.kind,original.document_number,original.revision_seq,original.status,
           original.subtotal,original.currency,original.document_date,original.posting_date,
           original.updated_at,original.updated_by,
           public.ob_rebase(original.sales_rep_id,clone_target.sandbox_seed),
           public.ob_rebase(original.sales_team_id,clone_target.sandbox_seed),
           public.ob_rebase(original.subsidiary_id,clone_target.sandbox_seed),
           public.ob_rebase(original.posted_entry_id,clone_target.sandbox_seed),
           public.ob_rebase(original.reversal_entry_id,clone_target.sandbox_seed))
       IS NOT DISTINCT FROM
          (NEW.kind,NEW.document_number,NEW.revision_seq,NEW.status,
           NEW.subtotal,NEW.currency,NEW.document_date,NEW.posting_date,
           NEW.updated_at,NEW.updated_by,
           NEW.sales_rep_id,NEW.sales_team_id,NEW.subsidiary_id,
           NEW.posted_entry_id,NEW.reversal_entry_id);
   ELSE
    PERFORM 1 FROM public.crm_opportunities original
     WHERE original.org_id=clone_target.sandbox_of
      AND public.ob_rebase(original.id,clone_target.sandbox_seed)=NEW.id
      AND (original.opportunity_number,original.revision_seq,
           public.ob_rebase(original.status_id,clone_target.sandbox_seed),
           original.projected_amount,original.currency,original.closed_at,original.updated_at,original.updated_by,
           public.ob_rebase(original.sales_rep_id,clone_target.sandbox_seed),
           public.ob_rebase(original.sales_team_id,clone_target.sandbox_seed),
           public.ob_rebase(original.subsidiary_id,clone_target.sandbox_seed))
       IS NOT DISTINCT FROM
          (NEW.opportunity_number,NEW.revision_seq,NEW.status_id,
           NEW.projected_amount,NEW.currency,NEW.closed_at,NEW.updated_at,NEW.updated_by,
           NEW.sales_rep_id,NEW.sales_team_id,NEW.subsidiary_id);
   END IF;
   IF FOUND THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Sandbox sales sources must retain the original identity, revision, state, attribution, amount and dates; refresh from the recorded source instead of manufacturing historical sales evidence.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_TABLE_NAME='documents' THEN
  metric_name:='net_invoiced'; source_name:='document'; source_number_value:=NEW.document_number;
  is_credit:=NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted');
  is_reversal:=TG_OP='UPDATE' AND OLD.status='posted' AND NEW.status='voided';
  value:=CASE WHEN NEW.kind='customer_credit' THEN -NEW.subtotal ELSE NEW.subtotal END;
  event_date:=COALESCE(NEW.posting_date,NEW.document_date);
  IF is_reversal THEN
   -- Finalized voids clear request fields. The posted reversal is the
   -- authoritative effective date for both accounting and sales evidence.
   SELECT reversal.posting_date INTO event_date
     FROM public.journal_entries reversal
    WHERE reversal.org_id=NEW.org_id
      AND reversal.id=NEW.reversal_entry_id
      AND reversal.reverses_entry_id=NEW.posted_entry_id
      AND reversal.status='posted';
  END IF;
 ELSE
  metric_name:='closed_won'; source_name:='opportunity'; source_number_value:=NEW.opportunity_number;
  SELECT is_won INTO new_won FROM public.crm_opportunity_statuses WHERE org_id=NEW.org_id AND id=NEW.status_id;
  IF TG_OP='UPDATE' THEN SELECT is_won INTO old_won FROM public.crm_opportunity_statuses WHERE org_id=OLD.org_id AND id=OLD.status_id; END IF;
  is_credit:=COALESCE(new_won,false) AND NOT COALESCE(old_won,false);
  is_reversal:=COALESCE(old_won,false) AND NOT COALESCE(new_won,false);
  IF TG_OP='UPDATE' AND old_won AND new_won AND
    (OLD.sales_rep_id IS DISTINCT FROM NEW.sales_rep_id OR OLD.sales_team_id IS DISTINCT FROM NEW.sales_team_id OR OLD.projected_amount IS DISTINCT FROM NEW.projected_amount OR OLD.currency IS DISTINCT FROM NEW.currency) THEN
   RAISE EXCEPTION 'Closed-won sales evidence is immutable; reopen the opportunity with a reason before adjusting it.' USING ERRCODE='23514';
  END IF;
  value:=NEW.projected_amount; event_date:=(NEW.closed_at AT TIME ZONE COALESCE((SELECT NULLIF(settings->>'timeZone','') FROM public.orgs WHERE id=NEW.org_id),'UTC'))::date;
  IF is_reversal AND NULLIF(trim(NEW.win_loss_reason),'') IS NULL THEN RAISE EXCEPTION 'Enter the reason for reopening this opportunity.' USING ERRCODE='23514'; END IF;
 END IF;
 IF is_credit THEN
  IF event_date IS NULL THEN RAISE EXCEPTION 'Sales evidence requires an effective date.' USING ERRCODE='23514'; END IF;
  INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,created_by)
   VALUES(NEW.org_id,source_name,NEW.id,source_number_value,NEW.revision_seq,'credit',metric_name,NEW.sales_rep_id,NEW.sales_team_id,NEW.subsidiary_id,NEW.currency,value,event_date,NEW.updated_by);
 ELSIF is_reversal THEN
  SELECT e.* INTO prior FROM public.crm_sales_evidence e WHERE e.org_id=NEW.org_id AND e.source_kind=source_name AND e.source_id=NEW.id AND e.event_kind='credit' AND NOT EXISTS (SELECT 1 FROM public.crm_sales_evidence r WHERE r.org_id=e.org_id AND r.reverses_id=e.id) ORDER BY e.created_at DESC LIMIT 1;
  IF FOUND THEN
   IF source_name='opportunity' THEN event_date:=(NEW.updated_at AT TIME ZONE COALESCE((SELECT NULLIF(settings->>'timeZone','') FROM public.orgs WHERE id=NEW.org_id),'UTC'))::date; END IF;
   IF event_date IS NULL THEN RAISE EXCEPTION 'A sales reversal requires its controlled effective date.' USING ERRCODE='23514'; END IF;
   INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,reverses_id,created_by)
    VALUES(prior.org_id,prior.source_kind,prior.source_id,prior.source_number,NEW.revision_seq,'reversal',prior.metric,prior.employee_id,prior.sales_team_id,prior.subsidiary_id,prior.currency,-prior.amount,event_date,prior.id,NEW.updated_by);
  END IF;
 END IF;
 RETURN NEW;
END $function$;
