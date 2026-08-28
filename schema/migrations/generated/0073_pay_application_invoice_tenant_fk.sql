-- OpenBooks forward migration 0073_pay_application_invoice_tenant_fk.
--
-- Migration 0003 installed a single-column foreign key for
-- pay_applications.invoice_document_id.  That proves only that the UUID is
-- present in documents; it does not prove that the invoice belongs to the
-- application's organization.  This forward-only migration replaces that
-- constraint with the composite tenant-coherent relationship.
--
-- The preflight is deliberately fail-closed.  Existing cross-organization or
-- orphaned pointers are financial provenance that must be reconciled by an
-- approved repair; this migration never rewrites them.  Every statement is
-- replay-safe so a retry after a failed validation can converge cleanly.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $preflight$
DECLARE
  violation record;
BEGIN
  SELECT pa.ctid::text AS child_ctid,
         pa.org_id::text AS child_org_id,
         pa.invoice_document_id::text AS invoice_document_id,
         d.org_id::text AS referenced_org_id
    INTO violation
    FROM public.pay_applications pa
    LEFT JOIN public.documents d
      ON d.id = pa.invoice_document_id
   WHERE pa.invoice_document_id IS NOT NULL
     AND (d.id IS NULL OR d.org_id IS DISTINCT FROM pa.org_id)
   ORDER BY pa.ctid
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.pay_applications.invoice_document_id',
      DETAIL = jsonb_build_object(
        'table', 'pay_applications',
        'row', violation.child_ctid,
        'org_id', violation.child_org_id,
        'invoice_document_id', violation.invoice_document_id,
        'referenced_org_id', violation.referenced_org_id
      )::text,
      HINT = 'Reconcile the invoice pointer to a document owned by the same organization, then retry migration 0073; this migration will not rewrite financial history.';
  END IF;
END
$preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- The canonical baseline already carries this index; IF NOT EXISTS also makes
-- the migration safe for installations whose baseline predates that index.
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique
  ON public.documents (org_id, id);

-- 0003's constraint has the same name but the wrong one-column shape.  Drop it
-- before installing the tenant-coherent definition; IF EXISTS also handles a
-- fresh database where 0003 was not applied independently.
ALTER TABLE public.pay_applications
  DROP CONSTRAINT IF EXISTS pay_applications_invoice_document_id_fkey;

ALTER TABLE public.pay_applications
  ADD CONSTRAINT pay_applications_invoice_document_id_fkey
  FOREIGN KEY (org_id, invoice_document_id)
  REFERENCES public.documents (org_id, id)
  ON DELETE SET NULL (invoice_document_id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.pay_applications
  VALIDATE CONSTRAINT pay_applications_invoice_document_id_fkey;
