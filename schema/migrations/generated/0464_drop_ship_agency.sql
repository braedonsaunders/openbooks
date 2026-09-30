-- OpenBooks forward migration 0464_drop_ship_agency.
-- Preserve independently approved control judgments and exact cumulative vendor allocations.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
    WHERE conrelid='public.financial_changes'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%provision%';
  EXECUTE format('ALTER TABLE public.financial_changes DROP CONSTRAINT %I',constraint_name);
  EXECUTE format('ALTER TABLE public.financial_changes ADD CONSTRAINT %I CHECK(domain IN (''lease'',''revenue'',''asset'',''consolidation'',''manufacturing'',''provision'',''sales''))',constraint_name);
END $$;
CREATE UNIQUE INDEX financial_changes_drop_ship_control ON public.financial_changes(org_id,subject_id)
  WHERE domain='sales' AND status='applied';
CREATE FUNCTION public.drop_ship_control_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.domain='sales' AND NOT EXISTS(SELECT 1 FROM public.drop_ship_lines route
    JOIN public.document_lines line ON line.org_id=route.org_id AND line.id=route.sales_order_line_id
    JOIN public.documents document ON document.org_id=line.org_id AND document.id=line.document_id
    WHERE route.org_id=NEW.org_id AND route.sales_order_line_id=NEW.subject_id AND document.subsidiary_id=NEW.subsidiary_id
      AND NEW.operation='drop_ship_control_assessment' AND NEW.payload->'requiredSubsidiaryIds'=jsonb_build_array(NEW.subsidiary_id::text)
  ) THEN RAISE EXCEPTION 'control assessment must bind to its routed order line and legal entity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drop_ship_control_binding BEFORE INSERT OR UPDATE ON public.financial_changes FOR EACH ROW EXECUTE FUNCTION public.drop_ship_control_binding();
CREATE TABLE public.drop_ship_agent_allocations (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE RESTRICT,
  document_line_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sales_order_line_id uuid NOT NULL,
  change_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('customer_invoice','vendor_bill')),
  gross_amount numeric(20,4) NOT NULL CHECK(gross_amount>=0),
  vendor_amount numeric(20,4) NOT NULL CHECK(vendor_amount>=0 AND vendor_amount<=gross_amount),
  quantity numeric(28,8) NOT NULL CHECK(quantity>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,document_line_id),
  FOREIGN KEY(org_id,document_line_id) REFERENCES public.document_lines(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,document_id) REFERENCES public.documents(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,sales_order_line_id) REFERENCES public.document_lines(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(change_id) REFERENCES public.financial_changes(id) ON DELETE RESTRICT
);
ALTER TABLE public.drop_ship_agent_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drop_ship_agent_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.drop_ship_agent_allocations
  USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE FUNCTION public.drop_ship_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'agency allocations are immutable; reverse and replace the document through its controlled workflow';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.financial_changes change JOIN public.document_lines line ON line.org_id=change.org_id AND line.id=NEW.document_line_id
    JOIN public.documents document ON document.org_id=line.org_id AND document.id=line.document_id
    WHERE change.id=NEW.change_id AND change.org_id=NEW.org_id AND change.domain='sales' AND change.subject_id=NEW.sales_order_line_id AND change.status='applied'
      AND change.payload->>'controlsBeforeTransfer'='false' AND document.id=NEW.document_id AND document.kind=NEW.kind AND document.subsidiary_id=change.subsidiary_id)
    THEN RAISE EXCEPTION 'agency allocation must bind to its approved control judgment and native document'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER drop_ship_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.drop_ship_agent_allocations FOR EACH ROW EXECUTE FUNCTION public.drop_ship_allocation_guard();
SELECT public.openbooks_refresh_query_catalog();
