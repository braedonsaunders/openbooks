-- Parenthesize the layer-count CASE in the historical translation basis guard.
-- PL/pgSQL ends an IF condition at the first THEN outside parentheses, so the
-- unparenthesized CASE truncated the condition and every insert failed.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.historical_translation_basis_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 DECLARE proposal public.financial_changes%ROWTYPE; physical public.journal_lines%ROWTYPE;
         entry public.journal_entries%ROWTYPE; instruction jsonb;
 BEGIN
  IF TG_OP<>'INSERT' THEN
   IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Approved historical contribution evidence is immutable; preserve it and use governed source reversals.';
  END IF;
  SELECT * INTO STRICT physical FROM public.journal_lines WHERE org_id=NEW.org_id AND id=NEW.source_line_id FOR UPDATE;
  SELECT * INTO STRICT entry FROM public.journal_entries WHERE org_id=NEW.org_id AND id=physical.entry_id FOR SHARE;
  SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id FOR SHARE;
  instruction:=NEW.evidence->'instruction';
  IF EXISTS(SELECT 1 FROM public.historical_translation_contributions WHERE org_id=NEW.org_id AND source_line_id=NEW.source_line_id
    AND measurement_currency<>NEW.measurement_currency) THEN
   RAISE EXCEPTION 'An exact physical source cannot have contradictory measurement currencies across presentation certificates.';
  END IF;
  IF proposal.domain<>'consolidation' OR proposal.operation<>'historical_translation_contribution'
    OR proposal.status<>'approved' OR proposal.approved_by IS NULL
    OR (proposal.approved_by=proposal.submitted_by AND NOT public.financial_change_self_decision_authorized(NEW.org_id,proposal.id,proposal.submitted_by))
    OR proposal.subject_id IS DISTINCT FROM NEW.source_line_id OR proposal.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
    OR proposal.effective_on IS DISTINCT FROM NEW.posting_date OR proposal.payload->'evidence' IS DISTINCT FROM NEW.evidence
    OR proposal.payload->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash
    OR proposal.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
    OR proposal.before_state IS DISTINCT FROM jsonb_build_object('sourceFingerprint',NEW.evidence->'sourceFingerprint',
      'originalLayerStates',NEW.evidence->'originalLayerStates') THEN
   RAISE EXCEPTION 'Historical contributions require the exact native approved source assessment and retained evidence.';
  END IF;
  IF entry.status NOT IN('posted','reversed') OR physical.entry_id IS DISTINCT FROM NEW.source_entry_id
    OR entry.book_id IS DISTINCT FROM NEW.book_id OR physical.account_id IS DISTINCT FROM NEW.account_id
    OR physical.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id OR physical.amount IS DISTINCT FROM NEW.source_amount
    OR entry.posting_date IS DISTINCT FROM NEW.posting_date
    OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND type='equity')
    OR NEW.evidence->'sourceFingerprint' IS DISTINCT FROM public.historical_translation_source_fingerprint(NEW.org_id,NEW.source_line_id)
    OR instruction->>'sourceLineId' IS DISTINCT FROM NEW.source_line_id::text
    OR instruction->>'measurementCurrency' IS DISTINCT FROM NEW.measurement_currency
    OR instruction->>'presentationCurrency' IS DISTINCT FROM NEW.presentation_currency
    OR instruction->>'kind' IS DISTINCT FROM NEW.kind
    OR jsonb_typeof(instruction->'layers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'retainedSources') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'translatedAmounts') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'originalLayerStates') IS DISTINCT FROM 'array'
    OR jsonb_array_length(instruction->'layers') NOT BETWEEN 1 AND 200
    OR jsonb_array_length(NEW.evidence->'retainedSources')<>jsonb_array_length(instruction->'layers')
    OR jsonb_array_length(NEW.evidence->'translatedAmounts')<>jsonb_array_length(instruction->'layers')
    OR jsonb_array_length(NEW.evidence->'originalLayerStates')<>(CASE WHEN NEW.kind='correction' THEN jsonb_array_length(instruction->'layers') ELSE 0 END)
    OR (NEW.kind='contribution' AND jsonb_array_length(instruction->'layers')<>1)
    OR (NEW.kind='opening' AND entry.origin NOT IN('opening','book_opening','migration'))
    OR (entry.reverses_entry_id IS NOT NULL AND NEW.kind<>'correction') THEN
   RAISE EXCEPTION 'Historical evidence must bind the exact posted equity line, book, entity, amount, date and explicit layer composition.';
  END IF;
  RETURN NEW;
 END $function$;
