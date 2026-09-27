-- OpenBooks forward migration 0420_drop_ship.
--
-- Drop-ship routing links an approved sales-order stock line to a purchase-
-- order line. The PO snapshot identifies the sales order and preserves the
-- customer's ship-to address as it stood when the PO was created.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.drop_ship_lines (
  org_id uuid NOT NULL,
  sales_order_line_id uuid NOT NULL,
  purchase_order_line_id uuid,
  routed_at timestamptz NOT NULL DEFAULT now(),
  routed_by uuid NOT NULL,
  CONSTRAINT drop_ship_lines_pkey PRIMARY KEY (org_id, sales_order_line_id),
  CONSTRAINT drop_ship_lines_sales_line_fkey
    FOREIGN KEY (org_id, sales_order_line_id)
    REFERENCES public.document_lines (org_id, id),
  CONSTRAINT drop_ship_lines_purchase_line_fkey
    FOREIGN KEY (org_id, purchase_order_line_id)
    REFERENCES public.document_lines (org_id, id),
  CONSTRAINT drop_ship_lines_routed_by_fkey
    FOREIGN KEY (routed_by) REFERENCES public.users (id)
);

CREATE UNIQUE INDEX drop_ship_lines_org_purchase_line
  ON public.drop_ship_lines (org_id, purchase_order_line_id)
  WHERE purchase_order_line_id IS NOT NULL;
CREATE INDEX drop_ship_lines_org_id ON public.drop_ship_lines (org_id);

ALTER TABLE public.drop_ship_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drop_ship_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.drop_ship_lines
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.drop_ship_lines IS
  'Sales-order stock lines routed to vendor shipment; a purchase-order line is assigned once the corresponding drop-ship PO is created.';

CREATE TABLE public.drop_ship_orders (
  org_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  ship_to_address jsonb NOT NULL,
  CONSTRAINT drop_ship_orders_pkey PRIMARY KEY (org_id, purchase_order_id),
  CONSTRAINT drop_ship_orders_purchase_order_fkey
    FOREIGN KEY (org_id, purchase_order_id)
    REFERENCES public.documents (org_id, id),
  CONSTRAINT drop_ship_orders_sales_order_fkey
    FOREIGN KEY (org_id, sales_order_id)
    REFERENCES public.documents (org_id, id),
  CONSTRAINT drop_ship_orders_ship_to_check
    CHECK (jsonb_typeof(ship_to_address) = 'object')
);

CREATE INDEX drop_ship_orders_org_id ON public.drop_ship_orders (org_id);

ALTER TABLE public.drop_ship_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drop_ship_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.drop_ship_orders
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.drop_ship_orders IS
  'Drop-ship purchase orders and the sales order they serve, with the customer''s ship-to address captured at PO creation.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('drop_ship_lines', '0420_drop_ship'), ('drop_ship_orders', '0420_drop_ship')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
