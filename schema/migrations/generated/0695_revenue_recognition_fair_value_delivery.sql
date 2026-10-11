-- Effective-dated calculated fair value and auditable recognition controls.
ALTER TABLE public.fair_value_prices
  ADD COLUMN calculation_method text NOT NULL DEFAULT 'fixed',
  ADD COLUMN formula_percent numeric(19,4),
  ADD COLUMN list_price numeric(19,4),
  ADD COLUMN unit_cost numeric(19,4),
  ADD CONSTRAINT fair_value_formula_check CHECK (
    calculation_method IN ('fixed','percent_of_list','cost_plus') AND unit_price >= 0
    AND (calculation_method='fixed' OR (formula_percent >= 0 AND formula_percent IS NOT NULL
      AND CASE calculation_method WHEN 'percent_of_list' THEN list_price >= 0 AND list_price IS NOT NULL
        ELSE unit_cost >= 0 AND unit_cost IS NOT NULL END)));
ALTER TABLE public.performance_obligations
  ADD COLUMN recognition_held boolean NOT NULL DEFAULT false,
  ADD COLUMN hold_reason text,
  ADD COLUMN control_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN delivered_on date,
  ADD COLUMN delivery_bundle_document_id uuid,
  ADD COLUMN allocation_basis jsonb,
  ADD CONSTRAINT obligation_hold_reason_check CHECK (NOT recognition_held OR length(btrim(hold_reason)) >= 8),
  ADD CONSTRAINT obligation_delivery_document_fk FOREIGN KEY (org_id,delivery_bundle_document_id) REFERENCES public.documents(org_id,id);

CREATE TABLE public.recognition_control_events (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  obligation_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL CHECK (action IN ('hold','release','deliver')), reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  effective_on date, evidence text, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,obligation_id) REFERENCES public.performance_obligations(org_id,id),
  CHECK (action <> 'deliver' OR (effective_on IS NOT NULL AND length(btrim(evidence)) >= 8))
);
CREATE INDEX recognition_controls_obligation ON public.recognition_control_events(org_id,obligation_id,created_at);
ALTER TABLE public.recognition_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recognition_control_events FORCE ROW LEVEL SECURITY;
CREATE POLICY recognition_controls_tenant ON public.recognition_control_events USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

CREATE FUNCTION public.recognition_control_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF; RAISE EXCEPTION 'Recognition control evidence is immutable'; END $$;
CREATE TRIGGER recognition_controls_immutable BEFORE UPDATE OR DELETE ON public.recognition_control_events FOR EACH ROW EXECUTE FUNCTION public.recognition_control_immutable();

CREATE FUNCTION public.fair_value_used_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM public.performance_obligations o WHERE o.org_id=OLD.org_id AND o.allocation_basis->>'fairValuePriceId'=OLD.id::text) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Used fair-value policy is retained; create a successor dated policy'; END IF;
    IF ROW(NEW.org_id,NEW.item_id,NEW.currency,NEW.unit_price,NEW.low_value,NEW.high_value,NEW.effective_from,NEW.calculation_method,NEW.formula_percent,NEW.list_price,NEW.unit_cost)
       IS DISTINCT FROM ROW(OLD.org_id,OLD.item_id,OLD.currency,OLD.unit_price,OLD.low_value,OLD.high_value,OLD.effective_from,OLD.calculation_method,OLD.formula_percent,OLD.list_price,OLD.unit_cost) THEN
      RAISE EXCEPTION 'Used fair-value terms are immutable; close this window and create a successor dated policy';
    END IF;
    IF NEW.effective_to IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.performance_obligations o JOIN public.document_lines dl ON dl.org_id=o.org_id AND dl.id=o.document_line_id
      JOIN public.documents d ON d.org_id=dl.org_id AND d.id=dl.document_id
      WHERE o.org_id=OLD.org_id AND o.allocation_basis->>'fairValuePriceId'=OLD.id::text AND d.document_date>NEW.effective_to
    ) THEN RAISE EXCEPTION 'A fair-value window cannot exclude an obligation already priced by it'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fair_value_used_policy BEFORE UPDATE OR DELETE ON public.fair_value_prices FOR EACH ROW EXECUTE FUNCTION public.fair_value_used_policy_guard();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.recognition_control_events FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
