-- OpenBooks forward migration 0421_pick_lists_and_shipments.
--
-- A pick list reserves bin stock for sales-order lines before it leaves the
-- warehouse; a shipment records what was picked, the cartons, the carrier
-- and the tracking number, and on completion becomes the existing sales
-- fulfilment that issues the stock and relieves COGS. Both are ordinary
-- documents (kinds pick_list and shipment) reusing the documents lifecycle:
-- draft, released to approved, voided before completion. Their operational
-- stage lives in a one-to-one side table, never a new document status.
--
-- fulfillment_documents carries the stage (open, then done), the warehouse,
-- and for shipments the carrier, service, tracking number, a snapshot of the
-- ship-to address and the sales fulfilment the completion produced. A done
-- row is final. fulfillment_lines ties each pick or shipment line to the
-- sales-order line it serves, the lot or serial chosen, the pick line a
-- shipment line ships, and the carton it was packed in. carriers is the
-- per-organization list of carriers and their service levels; it holds no
-- credentials.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Mirror of the read-only preflight: the two kinds and link types are new, so
-- any existing use would be reinterpreted by this migration.
DO $preflight$
DECLARE
  finding record;
BEGIN
  SELECT d.org_id, d.kind INTO finding
    FROM public.documents d
   WHERE d.kind IN ('pick_list', 'shipment')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'organization % already has a document of kind %; relabel it before applying 0421',
      finding.org_id, finding.kind;
  END IF;
  SELECT l.org_id, l.link_type INTO finding
    FROM public.document_links l
   WHERE l.link_type IN ('reserves', 'ships')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'organization % already has a document link of type %; relabel it before applying 0421',
      finding.org_id, finding.link_type;
  END IF;
END
$preflight$;

CREATE TABLE public.carriers (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  services text[] NOT NULL,
  tracking_url_template text,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT carriers_pkey PRIMARY KEY (id),
  CONSTRAINT carriers_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT carriers_org_code_unique UNIQUE (org_id, code),
  CONSTRAINT carriers_code_check CHECK (btrim(code) <> ''),
  CONSTRAINT carriers_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT carriers_services_check
    CHECK (cardinality(services) > 0
           AND array_position(services, NULL) IS NULL
           AND array_position(services, '') IS NULL),
  CONSTRAINT carriers_tracking_url_template_check
    CHECK (tracking_url_template IS NULL OR position('{tracking}' in tracking_url_template) > 0)
);

ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carriers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.carriers
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.carriers IS
  'Carriers an organization ships with, their service levels, and an optional tracking link template containing {tracking}. Holds no credentials.';

CREATE TABLE public.fulfillment_documents (
  document_id uuid NOT NULL,
  org_id uuid NOT NULL,
  stage text DEFAULT 'open' NOT NULL,
  warehouse_id uuid NOT NULL,
  carrier_id uuid,
  carrier_service text,
  tracking_number text,
  ship_to_address jsonb,
  sales_fulfillment_id uuid,
  completed_at timestamp with time zone,
  completed_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT fulfillment_documents_pkey PRIMARY KEY (document_id),
  CONSTRAINT fulfillment_documents_org_document_unique UNIQUE (org_id, document_id),
  CONSTRAINT fulfillment_documents_document_fkey
    FOREIGN KEY (org_id, document_id) REFERENCES public.documents (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fulfillment_documents_warehouse_fkey
    FOREIGN KEY (org_id, warehouse_id) REFERENCES public.warehouses (org_id, stock_location_id),
  CONSTRAINT fulfillment_documents_carrier_fkey
    FOREIGN KEY (org_id, carrier_id) REFERENCES public.carriers (org_id, id),
  CONSTRAINT fulfillment_documents_sales_fulfillment_fkey
    FOREIGN KEY (org_id, sales_fulfillment_id) REFERENCES public.documents (org_id, id),
  CONSTRAINT fulfillment_documents_stage_check CHECK (stage IN ('open', 'done')),
  CONSTRAINT fulfillment_documents_done_check
    CHECK (stage <> 'done' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT fulfillment_documents_service_check
    CHECK (carrier_service IS NULL OR carrier_id IS NOT NULL),
  CONSTRAINT fulfillment_documents_tracking_check
    CHECK (tracking_number IS NULL OR btrim(tracking_number) <> ''),
  CONSTRAINT fulfillment_documents_ship_to_check
    CHECK (ship_to_address IS NULL OR jsonb_typeof(ship_to_address) = 'object')
);

CREATE INDEX fulfillment_documents_org_stage
  ON public.fulfillment_documents (org_id, stage);
CREATE UNIQUE INDEX fulfillment_documents_org_sales_fulfillment
  ON public.fulfillment_documents (org_id, sales_fulfillment_id)
  WHERE sales_fulfillment_id IS NOT NULL;

ALTER TABLE public.fulfillment_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.fulfillment_documents
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.fulfillment_documents IS
  'Operational stage of a pick list or shipment document (one row per document). open until completion, then done and final. Shipments carry the carrier, service, tracking number, ship-to snapshot and the sales fulfilment their completion recorded.';

CREATE TABLE public.fulfillment_lines (
  line_id uuid NOT NULL,
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sales_order_line_id uuid NOT NULL,
  pick_line_id uuid,
  lot_id uuid,
  serial_id uuid,
  carton text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT fulfillment_lines_pkey PRIMARY KEY (line_id),
  CONSTRAINT fulfillment_lines_line_fkey
    FOREIGN KEY (org_id, line_id) REFERENCES public.document_lines (org_id, id) ON DELETE CASCADE,
  CONSTRAINT fulfillment_lines_document_fkey
    FOREIGN KEY (org_id, document_id) REFERENCES public.fulfillment_documents (org_id, document_id) ON DELETE CASCADE,
  CONSTRAINT fulfillment_lines_sales_order_line_fkey
    FOREIGN KEY (org_id, sales_order_line_id) REFERENCES public.document_lines (org_id, id),
  CONSTRAINT fulfillment_lines_pick_line_fkey
    FOREIGN KEY (org_id, pick_line_id) REFERENCES public.document_lines (org_id, id),
  CONSTRAINT fulfillment_lines_lot_fkey FOREIGN KEY (lot_id) REFERENCES public.lots (id),
  CONSTRAINT fulfillment_lines_serial_fkey FOREIGN KEY (serial_id) REFERENCES public.serials (id),
  CONSTRAINT fulfillment_lines_carton_check CHECK (carton IS NULL OR btrim(carton) <> '')
);

CREATE INDEX fulfillment_lines_org_document
  ON public.fulfillment_lines (org_id, document_id);
CREATE INDEX fulfillment_lines_org_sales_order_line
  ON public.fulfillment_lines (org_id, sales_order_line_id);

ALTER TABLE public.fulfillment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fulfillment_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.fulfillment_lines
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.fulfillment_lines IS
  'Pick-list and shipment line detail: the sales-order line served, the lot or serial chosen, the pick line a shipment line ships, and its carton. The bin and quantity are the document line''s own stock_location_id and quantity.';

-- The side row belongs to a pick list or shipment; a pick list carries no
-- carrier, tracking, ship-to or fulfilment; a completed shipment names its
-- carrier, service and fulfilment; and a done row is never changed again.
CREATE FUNCTION public.fulfillment_documents_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  document_kind text;
  document_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    SELECT status INTO document_status
      FROM public.documents WHERE id = OLD.document_id AND org_id = OLD.org_id;
    IF document_status IS NULL OR document_status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'fulfilment detail of a % document cannot be deleted; void the document instead', document_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.stage = 'done' THEN
    RAISE EXCEPTION 'a completed pick list or shipment is final and cannot be changed'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT kind INTO document_kind
    FROM public.documents WHERE id = NEW.document_id AND org_id = NEW.org_id;
  IF document_kind IS DISTINCT FROM 'pick_list' AND document_kind IS DISTINCT FROM 'shipment' THEN
    RAISE EXCEPTION 'fulfilment detail belongs to a pick list or shipment, not a %', coalesce(document_kind, 'missing document')
      USING ERRCODE = 'check_violation';
  END IF;
  IF document_kind = 'pick_list' AND (
       NEW.carrier_id IS NOT NULL OR NEW.carrier_service IS NOT NULL OR NEW.tracking_number IS NOT NULL
       OR NEW.ship_to_address IS NOT NULL OR NEW.sales_fulfillment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a pick list carries no carrier, tracking, ship-to address or fulfilment; those belong to its shipment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF document_kind = 'shipment' AND NEW.stage = 'done' AND (
       NEW.carrier_id IS NULL OR NEW.carrier_service IS NULL OR NEW.sales_fulfillment_id IS NULL) THEN
    RAISE EXCEPTION 'a completed shipment names its carrier, service and sales fulfilment'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER fulfillment_documents_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fulfillment_documents
  FOR EACH ROW EXECUTE FUNCTION public.fulfillment_documents_guard();

-- A line's detail sits on the line's own document; shipment lines name the
-- pick line they ship and pick lines do not; only the carton changes after
-- insert, and only while the document is a draft.
CREATE FUNCTION public.fulfillment_lines_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  line_document uuid;
  document_kind text;
  document_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    SELECT status INTO document_status
      FROM public.documents WHERE id = OLD.document_id AND org_id = OLD.org_id;
    IF document_status IS NULL OR document_status = 'draft'
       OR NOT EXISTS (SELECT 1 FROM public.document_lines WHERE id = OLD.line_id AND org_id = OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'fulfilment line detail of a % document cannot be deleted; void the document instead', document_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT d.kind, d.status INTO document_kind, document_status
    FROM public.documents d WHERE d.id = NEW.document_id AND d.org_id = NEW.org_id;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.line_id, NEW.org_id, NEW.document_id, NEW.sales_order_line_id, NEW.pick_line_id, NEW.lot_id, NEW.serial_id)
       IS DISTINCT FROM
       (OLD.line_id, OLD.org_id, OLD.document_id, OLD.sales_order_line_id, OLD.pick_line_id, OLD.lot_id, OLD.serial_id) THEN
      RAISE EXCEPTION 'only the carton of a fulfilment line can change'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.carton IS DISTINCT FROM OLD.carton AND document_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'cartons can change only while the shipment is a draft'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
  END IF;
  SELECT document_id INTO line_document
    FROM public.document_lines WHERE id = NEW.line_id AND org_id = NEW.org_id;
  IF line_document IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'fulfilment line detail must sit on the line''s own document'
      USING ERRCODE = 'check_violation';
  END IF;
  IF document_kind = 'pick_list' AND (NEW.pick_line_id IS NOT NULL OR NEW.carton IS NOT NULL) THEN
    RAISE EXCEPTION 'a pick-list line names no pick line and no carton'
      USING ERRCODE = 'check_violation';
  END IF;
  IF document_kind = 'shipment' AND NEW.pick_line_id IS NULL THEN
    RAISE EXCEPTION 'a shipment line names the pick line it ships'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER fulfillment_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.fulfillment_lines
  FOR EACH ROW EXECUTE FUNCTION public.fulfillment_lines_guard();

-- Both kinds are non-posting order-cycle documents governed by the
-- receivables close, like the sales order they serve.
INSERT INTO public.openbooks_document_close_modules (kind, close_module, added_in)
VALUES ('pick_list', 'ar', '0421_pick_lists_and_shipments'),
       ('shipment', 'ar', '0421_pick_lists_and_shipments')
ON CONFLICT (kind) DO NOTHING; -- expected on replay

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('carriers', '0421_pick_lists_and_shipments'),
       ('fulfillment_documents', '0421_pick_lists_and_shipments'),
       ('fulfillment_lines', '0421_pick_lists_and_shipments')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
