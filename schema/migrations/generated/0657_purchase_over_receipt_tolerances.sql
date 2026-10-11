-- Purchase over-receipt tolerances: how much a goods receipt may exceed a
-- purchase-order line's remaining quantity. NULL item_category is the
-- org-wide default; a row naming the item's stored category wins for that
-- category. Allowed excess per line is ordered × tolerance_percent / 100
-- plus tolerance_quantity; both default to zero, preserving exact
-- remaining-quantity enforcement until configured. Effective-dated like
-- every Setup policy: the receipt reads the row effective on its date.
CREATE TABLE public.purchase_over_receipt_tolerances (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 item_category text CHECK(item_category IS NULL OR btrim(item_category)<>''),
 tolerance_percent numeric(9,4) NOT NULL DEFAULT 0 CHECK(tolerance_percent>=0 AND tolerance_percent<=100),
 tolerance_quantity numeric(28,8) NOT NULL DEFAULT 0 CHECK(tolerance_quantity>=0),
 reason text NOT NULL,CONSTRAINT purchase_over_receipt_tolerance_reason CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
 effective_from date NOT NULL,effective_to date,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 UNIQUE(org_id,id),CHECK(effective_to IS NULL OR effective_to>effective_from),
 CONSTRAINT purchase_over_receipt_tolerance_overlap EXCLUDE USING gist(org_id WITH =,coalesce(item_category,'') WITH =,daterange(effective_from,effective_to,'[)') WITH &&)
);
ALTER TABLE public.purchase_over_receipt_tolerances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_over_receipt_tolerances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.purchase_over_receipt_tolerances USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
