-- Retain the payment policy used at posting independently of mutable vendor setup.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.documents ADD COLUMN payment_terms_snapshot jsonb;
COMMENT ON COLUMN public.documents.payment_terms_snapshot IS
 'Native posting-time vendor payment terms and economic revision. Null means no retained authority; automatic discount capture refuses it.';

CREATE FUNCTION public.document_payment_terms_snapshot_valid(evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_catalog SET datestyle = 'ISO, YMD' AS $$
DECLARE terms jsonb; percentage numeric; has_discount boolean;
BEGIN
 IF evidence IS NULL THEN RETURN true; END IF;
 IF jsonb_typeof(evidence) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(evidence)) <> 7
  OR NOT evidence ?& ARRAY['version','mode','source','documentKind','partyId','documentDate','terms']
  OR evidence->'version' <> '1'::jsonb
  OR jsonb_typeof(evidence->'documentDate') <> 'string'
  OR (evidence->>'documentDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  OR (evidence->>'documentDate')::date::text <> evidence->>'documentDate'
  OR (evidence->>'documentDate')::date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
 THEN RETURN false; END IF;
 IF evidence->>'mode' = 'not_applicable' THEN
  RETURN evidence->>'documentKind' = 'expense_report' AND evidence->>'source' = 'not_applicable'
   AND evidence->'terms' = 'null'::jsonb
   AND (evidence->'partyId' = 'null'::jsonb OR
    (jsonb_typeof(evidence->'partyId') = 'string' AND
     (evidence->>'partyId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'));
 END IF;
 IF evidence->>'documentKind' <> 'vendor_bill' OR jsonb_typeof(evidence->'partyId') <> 'string'
  OR (evidence->>'partyId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
 THEN RETURN false; END IF;
 IF evidence->>'source' = 'none' THEN
  RETURN evidence->>'mode' = 'no_discount' AND evidence->'terms' = 'null'::jsonb;
 END IF;
 terms := evidence->'terms';
 IF evidence->>'source' NOT IN ('vendor','company') OR jsonb_typeof(terms) <> 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(terms)) <> 6
  OR NOT terms ?& ARRAY['id','name','netDays','discountDays','discountPercent','revisionHash']
  OR jsonb_typeof(terms->'id') <> 'string'
  OR (terms->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  OR jsonb_typeof(terms->'name') <> 'string' OR btrim(terms->>'name') = ''
  OR jsonb_typeof(terms->'revisionHash') <> 'string' OR (terms->>'revisionHash') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(terms->'netDays') <> 'number' OR (terms->>'netDays') !~ '^[0-9]+$'
  OR (terms->>'netDays')::numeric > 3652058
 THEN RETURN false; END IF;
 IF (evidence->>'documentDate')::date + (terms->>'netDays')::integer > DATE '9999-12-31' THEN RETURN false; END IF;
 IF terms->'discountDays' <> 'null'::jsonb AND
  (jsonb_typeof(terms->'discountDays') <> 'number' OR (terms->>'discountDays') !~ '^[0-9]+$'
   OR (terms->>'discountDays')::numeric > 3652058)
 THEN RETURN false; END IF;
 IF terms->'discountPercent' = 'null'::jsonb THEN percentage := 0;
 ELSE
  IF jsonb_typeof(terms->'discountPercent') <> 'string'
   OR (terms->>'discountPercent') !~ '^[0-9]{1,15}(\.[0-9]{1,4})?$' THEN RETURN false; END IF;
  percentage := (terms->>'discountPercent')::numeric;
  IF percentage < 0 OR percentage >= 100 THEN RETURN false; END IF;
 END IF;
 has_discount := percentage > 0;
 IF has_discount AND terms->'discountDays' = 'null'::jsonb THEN RETURN false; END IF;
 IF has_discount AND (evidence->>'documentDate')::date + (terms->>'discountDays')::integer > DATE '9999-12-31' THEN RETURN false; END IF;
 RETURN evidence->>'mode' = CASE WHEN has_discount THEN 'discount' ELSE 'no_discount' END;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE public.documents ADD CONSTRAINT documents_payment_terms_snapshot_shape
 CHECK (public.document_payment_terms_snapshot_valid(payment_terms_snapshot) IS TRUE);

CREATE FUNCTION public.document_payment_terms_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 -- Native financial-history cloning is an explicit paired transaction-local
 -- operation; its source evidence remains subject to the shape constraint.
 IF TG_OP = 'INSERT' AND coalesce(current_setting('openbooks.migration', true),'off') = 'on'
  AND coalesce(current_setting('openbooks.amend', true),'off') = 'on' THEN RETURN NEW; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.payment_terms_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Payment terms are captured only by posting an approved document.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.payment_terms_snapshot IS NOT DISTINCT FROM OLD.payment_terms_snapshot THEN RETURN NEW; END IF;
 IF OLD.payment_terms_snapshot IS NOT NULL OR OLD.status <> 'approved' OR NEW.status <> 'posted' THEN
  RAISE EXCEPTION 'Posted payment terms are immutable; preserve the source and use a governed document correction.' USING ERRCODE='23514';
 END IF;
 IF NEW.payment_terms_snapshot->>'documentKind' IS DISTINCT FROM NEW.kind
  OR NEW.payment_terms_snapshot->'partyId' IS DISTINCT FROM coalesce(to_jsonb(NEW.party_id), 'null'::jsonb)
  OR NEW.payment_terms_snapshot->>'documentDate' IS DISTINCT FROM NEW.document_date::text THEN
  RAISE EXCEPTION 'Retained payment terms must belong to the posting document and vendor.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER documents_payment_terms_snapshot_guard BEFORE INSERT OR UPDATE OF payment_terms_snapshot
 ON public.documents FOR EACH ROW EXECUTE FUNCTION public.document_payment_terms_snapshot_guard();

-- Rebase only the declared native identities; keep the economic revision intact.
CREATE FUNCTION public.document_payment_terms_snapshot_for_clone(evidence jsonb, source_tenant uuid, source_party uuid, seed uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 IF evidence IS NULL THEN RETURN NULL; END IF;
 IF public.document_payment_terms_snapshot_valid(evidence) IS NOT TRUE OR seed IS NULL
  OR evidence->'partyId' IS DISTINCT FROM coalesce(to_jsonb(source_party), 'null'::jsonb) THEN
  RAISE EXCEPTION 'Cannot clone payment terms whose source document identity is missing or invalid.' USING ERRCODE='23514';
 END IF;
 IF source_party IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.parties WHERE org_id = source_tenant AND id = source_party
 ) THEN
  RAISE EXCEPTION 'Cannot clone payment terms whose party has no source-organization identity.' USING ERRCODE='23514';
 END IF;
 IF evidence->'terms' <> 'null'::jsonb AND NOT EXISTS (
  SELECT 1 FROM public.payment_terms WHERE org_id = source_tenant AND id = (evidence #>> '{terms,id}')::uuid
 ) THEN
  RAISE EXCEPTION 'Cannot clone retained payment terms whose policy identity is absent from the source organization.' USING ERRCODE='23514';
 END IF;
 result := jsonb_set(evidence, '{partyId}', coalesce(to_jsonb(public.ob_rebase(source_party, seed)::text), 'null'::jsonb), false);
 IF evidence->'terms' <> 'null'::jsonb THEN
  result := jsonb_set(result, '{terms,id}', to_jsonb(public.ob_rebase((evidence #>> '{terms,id}')::uuid, seed)::text), false);
 END IF;
 RETURN result;
END;
$$;
