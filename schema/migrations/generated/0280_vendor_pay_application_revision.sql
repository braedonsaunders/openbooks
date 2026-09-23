-- OpenBooks forward migration 0280_vendor_pay_application_revision.
--
-- Vendor pay-application line edits carried no revision evidence: two
-- editors opening the same draft read the same certified inputs, and the
-- second save silently overwrote the first — approved draws could certify
-- amounts neither editor saw together. The application header gains the
-- house optimistic-concurrency token (revision, starting at 1 like every
-- other revisioned record); the line update requires the revision its
-- editor read and bumps it, so a stale save fails with a 409 naming the
-- conflict instead of overwriting certified inputs.
--
-- Backfill: none needed. Existing applications start at revision 1, which
-- is exactly what an editor who read them before this migration holds.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.vendor_pay_applications
  ADD COLUMN IF NOT EXISTS revision integer DEFAULT 1 NOT NULL;

COMMENT ON COLUMN public.vendor_pay_applications.revision IS
  'Optimistic-concurrency token for draft line edits (0280). The line update requires the revision its editor read and bumps it on success, so concurrent editors cannot silently overwrite each other''s certified inputs.';

DROP VIEW openbooks_query.vendor_pay_applications;
CREATE VIEW openbooks_query.vendor_pay_applications WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    subcontract_id,
    application_number,
    period_end,
    vendor_invoice_number,
    status,
    default_retainage_percent,
    gross_this_period,
    retainage_this_period,
    net_due,
    vendor_bill_document_id,
    memo,
    submitted_at,
    submitted_by,
    approved_at,
    approved_by,
    revision,
    created_at,
    created_by,
    updated_at,
    updated_by
   FROM public.vendor_pay_applications
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON TABLE openbooks_query.vendor_pay_applications TO openbooks_read;
