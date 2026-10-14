-- Record an operator-supplied exchange rate on a customer invoice or vendor
-- bill with its source and reason, bound to the conversion it measures: the
-- document currency into its legal entity's functional currency. Storage
-- proves the evidence's shape and that the document's currency, rate and
-- legal entity are the ones it records; posting proves the functional
-- currency and effective posting date. The evidence is frozen once the
-- document leaves draft, and a copied document carries only its source's
-- exact evidence.
-- Backfill: none. Existing documents keep null evidence and their stored rates.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.documents
 ADD COLUMN document_fx_rate_evidence jsonb;

-- Every term is definite: a missing key or JSON null makes the predicate
-- false, never unknown, so incomplete evidence cannot pass the constraint.
ALTER TABLE public.documents
 ADD CONSTRAINT documents_fx_rate_evidence_bound CHECK (
  document_fx_rate_evidence IS NULL OR COALESCE((
   kind IN ('customer_invoice', 'vendor_bill')
   AND jsonb_typeof(document_fx_rate_evidence) = 'object'
   AND document_fx_rate_evidence ?& ARRAY['version', 'rate', 'source', 'reason', 'fromCurrency', 'toCurrency', 'rateDate', 'subsidiaryId']
   AND document_fx_rate_evidence - ARRAY['version', 'rate', 'source', 'reason', 'fromCurrency', 'toCurrency', 'rateDate', 'subsidiaryId'] = '{}'::jsonb
   AND document_fx_rate_evidence->'version' = '1'::jsonb
   AND jsonb_typeof(document_fx_rate_evidence->'rate') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'source') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'reason') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'fromCurrency') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'toCurrency') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'rateDate') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'subsidiaryId') = 'string'
   AND CASE WHEN (document_fx_rate_evidence->>'rate') ~ '^[0-9]{1,9}(\.[0-9]{1,10})?$'
        THEN (document_fx_rate_evidence->>'rate')::numeric > 0
         AND fx_rate = (document_fx_rate_evidence->>'rate')::numeric
        ELSE false END
   AND char_length(document_fx_rate_evidence->>'source') BETWEEN 1 AND 120
   AND document_fx_rate_evidence->>'source' = btrim(document_fx_rate_evidence->>'source')
   AND char_length(document_fx_rate_evidence->>'reason') BETWEEN 8 AND 500
   AND document_fx_rate_evidence->>'reason' = btrim(document_fx_rate_evidence->>'reason')
   AND (document_fx_rate_evidence->>'fromCurrency') ~ '^[A-Z]{3}$'
   AND (document_fx_rate_evidence->>'toCurrency') ~ '^[A-Z]{3}$'
   AND document_fx_rate_evidence->>'fromCurrency' <> document_fx_rate_evidence->>'toCurrency'
   AND currency = document_fx_rate_evidence->>'fromCurrency'
   AND (document_fx_rate_evidence->>'rateDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND subsidiary_id IS NOT NULL
   AND subsidiary_id::text = document_fx_rate_evidence->>'subsidiaryId'
  ), false)
 );

COMMENT ON COLUMN public.documents.document_fx_rate_evidence IS
 'Operator-recorded document-to-functional exchange rate with source, reason, currencies, rate date and owning legal entity. Null: the rate is resolved from the organization''s exchange rates at posting.';

-- Evidence changes only on a draft. Once a document leaves draft no session
-- setting admits a change: returning it to draft changes only its status,
-- and a later draft edit may then replace the evidence.
CREATE FUNCTION public.document_fx_rate_evidence_frozen_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF OLD.status <> 'draft' AND NEW.document_fx_rate_evidence IS DISTINCT FROM OLD.document_fx_rate_evidence THEN
  RAISE EXCEPTION 'document % is % — its recorded exchange rate evidence changes only on a draft; return it to draft and record the rate again', OLD.id, OLD.status
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$function$;

CREATE TRIGGER documents_fx_rate_evidence_frozen
 BEFORE UPDATE OF document_fx_rate_evidence ON public.documents
 FOR EACH ROW
 WHEN (old.status <> 'draft'
       AND new.document_fx_rate_evidence IS DISTINCT FROM old.document_fx_rate_evidence)
 EXECUTE FUNCTION public.document_fx_rate_evidence_frozen_guard();

-- The evidence a copied document carries: the source document's exact
-- evidence with its legal entity rebased like the document's own subsidiary,
-- and, in a masked copy, the authored source and reason redacted. The copy
-- construction and every source comparison use this one projection.
CREATE FUNCTION public.document_fx_rate_evidence_for_clone(evidence jsonb, seed uuid, masked boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $function$
 SELECT CASE WHEN evidence IS NULL THEN NULL
  ELSE evidence
   || jsonb_build_object('subsidiaryId', public.ob_rebase((evidence->>'subsidiaryId')::uuid, seed)::text)
   || CASE WHEN masked IS TRUE THEN jsonb_build_object('source', 'REDACTED', 'reason', 'REDACTED') ELSE '{}'::jsonb END
  END;
$function$;

-- Under native clone authority a document may carry evidence only when it
-- is the registered sandbox source's exact projected evidence. This
-- predicate grants no authority of its own.
CREATE FUNCTION public.document_fx_rate_evidence_clone_matches(candidate public.documents)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $function$
 SELECT EXISTS (
  SELECT 1 FROM public.orgs target
   JOIN public.sandboxes control ON control.org_id = target.id AND control.production_org_id = target.sandbox_of
   JOIN public.orgs source ON source.id = target.sandbox_of
   JOIN public.documents original ON original.org_id = source.id
  WHERE public.openbooks_clone_authority() AND target.id = (candidate).org_id
   AND target.env_kind = 'sandbox' AND target.sandbox_seed IS NOT NULL
   AND original.kind = (candidate).kind AND original.document_number = (candidate).document_number
   AND public.ob_rebase(original.id, target.sandbox_seed) = (candidate).id
   AND public.ob_rebase(original.subsidiary_id, target.sandbox_seed) IS NOT DISTINCT FROM (candidate).subsidiary_id
   AND (original.currency, original.fx_rate) IS NOT DISTINCT FROM ((candidate).currency, (candidate).fx_rate)
   AND public.document_fx_rate_evidence_for_clone(original.document_fx_rate_evidence, target.sandbox_seed, control.masked)
       IS NOT DISTINCT FROM (candidate).document_fx_rate_evidence
 );
$function$;

-- Evidence is recorded on an existing draft through the document editor.
-- An inserted row may carry it only as an exact native clone of its source.
CREATE FUNCTION public.document_fx_rate_evidence_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF public.openbooks_clone_authority() AND public.document_fx_rate_evidence_clone_matches(NEW) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Explicit exchange rate evidence is recorded on a draft through the document editor; a copied document must retain its source document''s exact evidence.'
  USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER documents_fx_rate_evidence_insert
 BEFORE INSERT ON public.documents
 FOR EACH ROW
 WHEN (new.document_fx_rate_evidence IS NOT NULL)
 EXECUTE FUNCTION public.document_fx_rate_evidence_insert_guard();

-- Sales sources copied into a sandbox also match their recorded exchange
-- rate evidence exactly, as projected for the copy.
CREATE OR REPLACE FUNCTION public.sales_document_clone_matches(candidate public.documents)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $function$
 SELECT EXISTS (
    SELECT 1 FROM public.orgs target
     JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
     JOIN public.orgs source ON source.id=target.sandbox_of
     JOIN public.documents original ON original.org_id=source.id
     WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
      AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
      AND original.kind=(candidate).kind AND original.document_number=(candidate).document_number
      AND public.ob_rebase(original.id,target.sandbox_seed)=(candidate).id
      AND (original.kind,original.document_number,original.revision_seq,original.status,
           original.subtotal,original.total,original.tax_total,original.fx_rate,original.open_balance,
           public.ob_rebase(original.party_id,target.sandbox_seed),
           original.currency,original.document_date,original.posting_date,
           original.updated_at,original.updated_by,
           public.ob_rebase(original.sales_rep_id,target.sandbox_seed),
           public.ob_rebase(original.sales_team_id,target.sandbox_seed),
           public.ob_rebase(original.subsidiary_id,target.sandbox_seed),
           public.ob_rebase(original.posted_entry_id,target.sandbox_seed),
           public.ob_rebase(original.reversal_entry_id,target.sandbox_seed),
           public.document_fx_rate_evidence_for_clone(original.document_fx_rate_evidence,target.sandbox_seed,control.masked))
       IS NOT DISTINCT FROM
          ((candidate).kind,(candidate).document_number,(candidate).revision_seq,(candidate).status,
           (candidate).subtotal,(candidate).total,(candidate).tax_total,(candidate).fx_rate,(candidate).open_balance,
           (candidate).party_id,(candidate).currency,(candidate).document_date,(candidate).posting_date,
           (candidate).updated_at,(candidate).updated_by,
           (candidate).sales_rep_id,(candidate).sales_team_id,(candidate).subsidiary_id,
           (candidate).posted_entry_id,(candidate).reversal_entry_id,
           (candidate).document_fx_rate_evidence)
 );
$function$;

SELECT public.openbooks_refresh_query_catalog();
