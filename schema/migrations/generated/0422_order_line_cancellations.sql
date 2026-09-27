-- OpenBooks forward migration 0422_order_line_cancellations.
--
-- A sales-order line's remainder could only be closed by voiding the whole
-- order. document_lines.quantity_cancelled records the part of an approved
-- line the business will no longer ship, so the line's open quantity is
-- quantity - quantity_fulfilled - quantity_cancelled and the three terms
-- always account for the whole ordered quantity. The check allows a zero
-- cancellation on every existing row unchanged, and once anything is
-- cancelled it forbids fulfilled plus cancelled from exceeding the order.
--
-- order_line_cancellations is the evidence for each cancellation: which
-- line, how much, why, and who. It is append-only; a cancellation is never
-- edited or removed, and the line's quantity_cancelled is the sum of its
-- rows.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.document_lines
  ADD COLUMN quantity_cancelled numeric(28,8) DEFAULT 0 NOT NULL,
  ADD CONSTRAINT document_lines_quantity_cancelled_check
    CHECK (quantity_cancelled >= 0
           AND (quantity_cancelled = 0
                OR quantity_fulfilled + quantity_cancelled <= quantity));

COMMENT ON COLUMN public.document_lines.quantity_cancelled IS
  'Order quantity cancelled and no longer owed to the customer; the sum of the line''s order_line_cancellations rows. Open quantity is quantity - quantity_fulfilled - quantity_cancelled.';

CREATE TABLE public.order_line_cancellations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  line_id uuid NOT NULL,
  quantity numeric(28,8) NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT order_line_cancellations_pkey PRIMARY KEY (id),
  CONSTRAINT order_line_cancellations_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_line_cancellations_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT order_line_cancellations_document_fkey
    FOREIGN KEY (org_id, document_id) REFERENCES public.documents (org_id, id),
  CONSTRAINT order_line_cancellations_line_fkey
    FOREIGN KEY (org_id, line_id) REFERENCES public.document_lines (org_id, id)
);

CREATE INDEX order_line_cancellations_org_document
  ON public.order_line_cancellations (org_id, document_id, line_id);

ALTER TABLE public.order_line_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_line_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.order_line_cancellations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE OR REPLACE FUNCTION public.order_line_cancellations_append_only_guard()
RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'order_line_cancellations is append-only';
END $$;

CREATE TRIGGER order_line_cancellations_append_only
  BEFORE UPDATE OR DELETE ON public.order_line_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.order_line_cancellations_append_only_guard();

COMMENT ON TABLE public.order_line_cancellations IS
  'Append-only evidence for each cancelled order-line remainder: the line, the quantity, the reason and the actor. document_lines.quantity_cancelled is the sum of a line''s rows.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('order_line_cancellations', '0422')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
