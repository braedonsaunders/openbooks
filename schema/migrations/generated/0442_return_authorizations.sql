-- OpenBooks forward migration 0442_return_authorizations.
-- RMA side tables hold authorization and inspection evidence for the generic
-- non-posting document; inventory and receivable effects remain in the normal
-- document and inventory ledgers.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.rma_documents (
  document_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  stage text NOT NULL DEFAULT 'requested',
  source_document_id uuid NOT NULL,
  customer_credit_id uuid,
  decided_at timestamptz,
  decided_by uuid,
  rejection_reason text,
  received_at timestamptz,
  received_by uuid,
  inspected_at timestamptz,
  inspected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT rma_documents_document_org_unique UNIQUE (org_id, document_id),
  CONSTRAINT rma_documents_stage_check CHECK (stage IN ('requested', 'receiving', 'inspected', 'done', 'rejected')),
  CONSTRAINT rma_documents_decision_pair CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT rma_documents_received_pair CHECK ((received_at IS NULL) = (received_by IS NULL)),
  CONSTRAINT rma_documents_inspected_pair CHECK ((inspected_at IS NULL) = (inspected_by IS NULL)),
  CONSTRAINT rma_documents_rejection_check CHECK (
    (stage <> 'rejected' AND rejection_reason IS NULL)
    OR (stage = 'rejected' AND rejection_reason IS NOT NULL
        AND char_length(btrim(rejection_reason)) BETWEEN 8 AND 1000)
  ),
  CONSTRAINT rma_documents_document_fk FOREIGN KEY (document_id) REFERENCES public.documents(id),
  CONSTRAINT rma_documents_source_document_fk FOREIGN KEY (source_document_id) REFERENCES public.documents(id),
  CONSTRAINT rma_documents_customer_credit_fk FOREIGN KEY (customer_credit_id) REFERENCES public.documents(id)
);

ALTER TABLE public.rma_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.rma_documents
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX rma_documents_org_stage ON public.rma_documents (org_id, stage, document_id);
CREATE INDEX rma_documents_org_source ON public.rma_documents (org_id, source_document_id);

CREATE TABLE public.rma_lines (
  line_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  document_id uuid NOT NULL,
  source_issue_movement_id uuid NOT NULL REFERENCES public.inventory_movements(id),
  authorized numeric(28,8) NOT NULL,
  received numeric(28,8) NOT NULL DEFAULT 0,
  accepted numeric(28,8) NOT NULL DEFAULT 0,
  disposition text,
  disposition_location_id uuid,
  vendor_credit_id uuid REFERENCES public.documents(id),
  scrap_movement_id uuid REFERENCES public.inventory_movements(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT rma_lines_document_line_fk FOREIGN KEY (line_id) REFERENCES public.document_lines(id),
  CONSTRAINT rma_lines_document_fk FOREIGN KEY (org_id, document_id)
    REFERENCES public.rma_documents(org_id, document_id),
  CONSTRAINT rma_lines_authorized_positive CHECK (authorized > 0),
  CONSTRAINT rma_lines_received_range CHECK (received >= 0 AND received <= authorized),
  CONSTRAINT rma_lines_accepted_range CHECK (accepted >= 0 AND accepted <= received),
  CONSTRAINT rma_lines_disposition_check CHECK (disposition IS NULL OR disposition IN ('restock', 'scrap', 'vendor-return')),
  CONSTRAINT rma_lines_disposition_pair CHECK (
    (accepted = 0 AND disposition IS NULL AND disposition_location_id IS NULL)
    OR (accepted > 0 AND disposition IS NOT NULL AND disposition_location_id IS NOT NULL)
  ),
  CONSTRAINT rma_lines_vendor_credit_check CHECK (vendor_credit_id IS NULL OR disposition = 'vendor-return'),
  CONSTRAINT rma_lines_scrap_check CHECK (scrap_movement_id IS NULL OR disposition = 'scrap')
);

ALTER TABLE public.rma_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rma_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.rma_lines
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX rma_lines_org_document ON public.rma_lines (org_id, document_id, line_id);
CREATE INDEX rma_lines_org_source ON public.rma_lines (org_id, source_issue_movement_id);

CREATE FUNCTION public.rma_document_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  record_org uuid;
  record_kind text;
BEGIN
  SELECT org_id, kind INTO record_org, record_kind
    FROM public.documents WHERE id = NEW.document_id;
  IF record_org IS DISTINCT FROM NEW.org_id OR record_kind IS DISTINCT FROM 'rma' THEN
    RAISE EXCEPTION 'RMA details require a return authorization document in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT org_id, kind INTO record_org, record_kind
    FROM public.documents WHERE id = NEW.source_document_id;
  IF record_org IS DISTINCT FROM NEW.org_id OR record_kind NOT IN ('customer_invoice', 'sales_fulfillment') THEN
    RAISE EXCEPTION 'RMA source must be a customer invoice or sales fulfillment in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.customer_credit_id IS NOT NULL THEN
    SELECT org_id, kind INTO record_org, record_kind
      FROM public.documents WHERE id = NEW.customer_credit_id;
    IF record_org IS DISTINCT FROM NEW.org_id OR record_kind IS DISTINCT FROM 'customer_credit' THEN
      RAISE EXCEPTION 'RMA customer credit must belong to the same organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER rma_documents_kind_guard
  BEFORE INSERT OR UPDATE ON public.rma_documents
  FOR EACH ROW EXECUTE FUNCTION public.rma_document_kind_guard();

CREATE FUNCTION public.rma_line_kind_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  rma_org uuid;
  document_kind text;
  line_document uuid;
  source_org uuid;
  location_org uuid;
  credit_org uuid;
  credit_kind text;
  scrap_org uuid;
BEGIN
  SELECT org_id INTO rma_org FROM public.rma_documents
   WHERE document_id = NEW.document_id AND org_id = NEW.org_id;
  SELECT d.kind, l.document_id INTO document_kind, line_document
    FROM public.document_lines l JOIN public.documents d ON d.id = l.document_id AND d.org_id = l.org_id
   WHERE l.id = NEW.line_id AND l.org_id = NEW.org_id;
  IF rma_org IS NULL OR document_kind IS DISTINCT FROM 'rma' OR line_document IS DISTINCT FROM NEW.document_id THEN
    RAISE EXCEPTION 'RMA line must belong to an RMA document in the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT org_id INTO source_org FROM public.inventory_movements WHERE id = NEW.source_issue_movement_id;
  IF source_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'RMA source movement must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.disposition_location_id IS NOT NULL THEN
    SELECT org_id INTO location_org FROM public.stock_locations WHERE id = NEW.disposition_location_id;
    IF location_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'RMA disposition location must belong to the same organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.vendor_credit_id IS NOT NULL THEN
    SELECT org_id, kind INTO credit_org, credit_kind FROM public.documents WHERE id = NEW.vendor_credit_id;
    IF credit_org IS DISTINCT FROM NEW.org_id OR credit_kind IS DISTINCT FROM 'vendor_credit' THEN
      RAISE EXCEPTION 'RMA vendor credit must belong to the same organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.scrap_movement_id IS NOT NULL THEN
    SELECT org_id INTO scrap_org FROM public.inventory_movements WHERE id = NEW.scrap_movement_id;
    IF scrap_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'RMA scrap movement must belong to the same organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER rma_lines_kind_guard
  BEFORE INSERT OR UPDATE ON public.rma_lines
  FOR EACH ROW EXECUTE FUNCTION public.rma_line_kind_guard();

INSERT INTO public.openbooks_document_close_modules (kind, close_module, added_in)
VALUES ('rma', 'ar', '0442_return_authorizations');

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('rma_documents', '0442_return_authorizations'),
       ('rma_lines', '0442_return_authorizations')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
