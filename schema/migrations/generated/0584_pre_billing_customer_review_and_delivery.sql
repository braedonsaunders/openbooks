-- OpenBooks forward migration 0584_pre_billing_customer_review_and_delivery.
-- Pre-billing worksheets gain an optional customer review step and delivery
-- tracking for the invoice they produce.
--
-- * wip_prebills.status adds 'customer_review': an approved worksheet sent
--   to the customer through the customer portal. The customer either
--   accepts it (signer name, optional purchase order number) or disputes
--   specific lines, which returns the worksheet to draft.
-- * customer_review_digest fingerprints the exact lines and amounts the
--   customer was shown, so an acceptance can only ever apply to that content.
-- * wip_prebill_lines.customer_dispute_note keeps the customer's comment on a
--   disputed line beside the line it concerns.
-- * delivered_at / customer_viewed_at record when the resulting invoice was
--   emailed with its backup and when the customer first opened the package.
-- * wip_prebill_events accepts the new lifecycle event types.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.wip_prebills
  ADD COLUMN customer_review_sent_at timestamp with time zone,
  ADD COLUMN customer_review_sent_by uuid,
  ADD COLUMN customer_review_digest text,
  ADD COLUMN customer_decision text,
  ADD COLUMN customer_decided_at timestamp with time zone,
  ADD COLUMN customer_signer_name text,
  ADD COLUMN customer_decision_note text,
  ADD COLUMN customer_po_number text,
  ADD COLUMN customer_viewed_at timestamp with time zone,
  ADD COLUMN delivered_at timestamp with time zone,
  ADD COLUMN delivered_by uuid;

ALTER TABLE public.wip_prebills DROP CONSTRAINT wip_prebills_status_chk;
ALTER TABLE public.wip_prebills
  ADD CONSTRAINT wip_prebills_status_chk CHECK (status = ANY (ARRAY[
    'draft'::text, 'review'::text, 'approved'::text, 'customer_review'::text,
    'converted'::text, 'void'::text
  ]));

-- A worksheet with the customer always names when it was sent and what the
-- customer is being asked to accept.
ALTER TABLE public.wip_prebills
  ADD CONSTRAINT wip_prebills_customer_review_chk CHECK (
    status <> 'customer_review'
    OR (customer_review_sent_at IS NOT NULL AND NULLIF(btrim(customer_review_digest), '') IS NOT NULL)
  );

ALTER TABLE public.wip_prebills
  ADD CONSTRAINT wip_prebills_customer_decision_chk CHECK (
    customer_decision IS NULL OR customer_decision = ANY (ARRAY['accepted'::text, 'disputed'::text])
  );

-- An acceptance is evidence: it carries who accepted and when.
ALTER TABLE public.wip_prebills
  ADD CONSTRAINT wip_prebills_customer_acceptance_chk CHECK (
    customer_decision IS DISTINCT FROM 'accepted'
    OR (customer_decided_at IS NOT NULL AND NULLIF(btrim(customer_signer_name), '') IS NOT NULL)
  );

-- Only an invoice can be delivered.
ALTER TABLE public.wip_prebills
  ADD CONSTRAINT wip_prebills_delivery_chk CHECK (
    delivered_at IS NULL OR (status = 'converted' AND delivered_by IS NOT NULL)
  );

ALTER TABLE public.wip_prebill_lines
  ADD COLUMN customer_dispute_note text;

-- The worksheet trail records approval routing failures, reopening, the
-- customer review exchange and delivery alongside the existing events.
ALTER TABLE public.wip_prebill_events DROP CONSTRAINT wip_prebill_events_type_chk;
ALTER TABLE public.wip_prebill_events
  ADD CONSTRAINT wip_prebill_events_type_chk CHECK (event_type = ANY (ARRAY[
    'created'::text, 'line_updated'::text, 'hold_created'::text, 'hold_released'::text,
    'submitted'::text, 'submit_failed'::text, 'returned'::text, 'approved'::text, 'reopened'::text,
    'customer_review_sent'::text, 'customer_review_emailed'::text, 'customer_review_email_failed'::text,
    'customer_viewed'::text, 'customer_accepted'::text, 'customer_disputed'::text,
    'converted'::text, 'delivered'::text, 'voided'::text
  ]));

CREATE INDEX wip_prebills_org_status ON public.wip_prebills USING btree (org_id, status);

SELECT public.openbooks_refresh_query_catalog();
