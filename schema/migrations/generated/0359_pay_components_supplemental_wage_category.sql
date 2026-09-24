-- OpenBooks forward migration 0359_pay_components_supplemental_wage_category.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.pay_component_earning_classifications (
  org_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  supplemental_wage_category text,
  CONSTRAINT pay_component_earning_classifications_pkey
    PRIMARY KEY (org_id, pay_component_id),
  CONSTRAINT pay_component_earning_classifications_component_fkey
    FOREIGN KEY (org_id, pay_component_id)
    REFERENCES public.pay_components(org_id, id) ON DELETE CASCADE,
  CONSTRAINT pay_component_earning_classifications_supplemental_category
    CHECK (supplemental_wage_category IS NULL
      OR supplemental_wage_category IN ('bonus_or_stock_option', 'other'))
);

ALTER TABLE public.pay_component_earning_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pay_component_earning_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pay_component_earning_classifications
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

INSERT INTO public.pay_component_earning_classifications (org_id, pay_component_id)
SELECT org_id, id FROM public.pay_components;

CREATE FUNCTION public.pay_components_create_earning_classification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.pay_component_earning_classifications (org_id, pay_component_id)
  VALUES (NEW.org_id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER pay_components_earning_classification_insert
AFTER INSERT ON public.pay_components
FOR EACH ROW EXECUTE FUNCTION public.pay_components_create_earning_classification();

CREATE FUNCTION public.pay_component_earning_classifications_prevent_orphan_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pay_components
     WHERE org_id = OLD.org_id AND id = OLD.pay_component_id
  ) THEN
    RAISE EXCEPTION 'pay component classifications cannot be deleted independently';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER pay_component_earning_classifications_protect_parent
BEFORE DELETE ON public.pay_component_earning_classifications
FOR EACH ROW EXECUTE FUNCTION public.pay_component_earning_classifications_prevent_orphan_delete();

COMMENT ON TABLE public.pay_component_earning_classifications IS
  'One tenant-scoped, one-to-one classification record per pay component. Independent dimensions preserve composability when an earning has multiple statutory classifications.';
COMMENT ON COLUMN public.pay_component_earning_classifications.supplemental_wage_category IS
  'US supplemental wage class used by state methods that distinguish bonus/stock-option pay from other supplemental wages.';
