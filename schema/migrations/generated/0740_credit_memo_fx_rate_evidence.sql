-- Admit recorded exchange-rate evidence on customer and vendor credit memos.
--
-- A credit memo in a foreign currency can now be measured at an explicit rate
-- with its source and reason, as invoices, bills and payments already are. The
-- invoice write-off uses it to write a foreign-currency receivable off at the
-- rate it is carried at, so the credit relieves exactly the carrying amount it
-- settles. Every other part of the evidence rule — shape, rate equality with
-- the document rate, trimmed source and reason, currency and legal-entity
-- equality — is unchanged.
-- Backfill: none. Existing documents carry no credit-memo evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.documents
 DROP CONSTRAINT documents_fx_rate_evidence_bound;
ALTER TABLE public.documents
 ADD CONSTRAINT documents_fx_rate_evidence_bound CHECK (
  document_fx_rate_evidence IS NULL OR COALESCE((
   kind IN ('customer_invoice', 'vendor_bill', 'customer_credit', 'vendor_credit', 'customer_payment', 'vendor_payment')
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
