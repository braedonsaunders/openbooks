-- OpenBooks forward migration 0003_pay_application_invoice_fk.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: orphaned pointers are cleared before
-- the FK is added, and every statement tolerates re-execution.
--
-- pay_applications.invoice_document_id names a customer_invoice. Void/delete
-- already release the pointer in application code; without a database FK a
-- deleted invoice can still leave a row pointing at a missing document.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

-- Clear pointers that no longer resolve so the FK can be added on live data.
UPDATE public.pay_applications pa
   SET invoice_document_id = NULL
 WHERE invoice_document_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.documents d
      WHERE d.id = pa.invoice_document_id AND d.org_id = pa.org_id
   );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pay_applications_invoice_document_id_fkey'
  ) THEN
    ALTER TABLE public.pay_applications
      ADD CONSTRAINT pay_applications_invoice_document_id_fkey
      FOREIGN KEY (invoice_document_id) REFERENCES public.documents(id)
      ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;
