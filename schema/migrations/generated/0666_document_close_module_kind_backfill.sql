-- OpenBooks forward migration 0666_document_close_module_kind_backfill.
--
-- The table-driven registry the storage fence reads lacks the close module
-- for cash sales and refunds, inventory receipts and fulfillments, and
-- field tickets, so those kinds posted under the GL lock alone. This
-- backfill inserts exactly the missing pairs; existing rows are untouched
-- and a rerun inserts nothing.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

INSERT INTO public.openbooks_document_close_modules (kind, close_module, added_in)
VALUES
    ('cash_sale', 'ar', '0666'),
    ('cash_refund', 'ar', '0666'),
    ('purchase_receipt', 'ap', '0666'),
    ('sales_fulfillment', 'ar', '0666'),
    ('field_ticket', 'gl', '0666')
ON CONFLICT (kind) DO NOTHING;

-- The backfill must land exactly these pairs: refuse by name otherwise, so
-- a conflicting row can never silently survive beside the engine map (the
-- parity test pins the table against the map in both directions).
DO $document_close_module_backfill_check$
DECLARE
  missing_names text;
BEGIN
  WITH expected(kind, close_module) AS (
    VALUES
      ('cash_sale', 'ar'),
      ('cash_refund', 'ar'),
      ('purchase_receipt', 'ap'),
      ('sales_fulfillment', 'ar'),
      ('field_ticket', 'gl')
  )
  SELECT string_agg(e.kind, ', ') INTO missing_names
    FROM expected e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.openbooks_document_close_modules t
      WHERE t.kind = e.kind AND t.close_module = e.close_module
   );
  IF missing_names IS NOT NULL THEN
    RAISE EXCEPTION 'document close module backfill is missing %', missing_names;
  END IF;
END
$document_close_module_backfill_check$;
