-- OpenBooks forward migration 0244_item_pricing_hierarchy.
--
-- Industry-neutral selling-price hierarchy:
--   customer/item absolute schedule
--   > customer's effective price level
--   > base price level
--   > the item's simple base price.
-- Each schedule is currency- and effective-date-specific and owns an ordered
-- all-units quantity grid. Project/T&M rate books remain a separate contract
-- resolver because package decomposition and usage-date pricing are different
-- commercial semantics, not another quantity discount.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.price_levels (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  pricing_method text NOT NULL DEFAULT 'explicit',
  percentage numeric(9,4),
  cost_basis text,
  is_base boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT price_levels_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT price_levels_org_code_unique UNIQUE (org_id, code),
  CONSTRAINT price_levels_code_present CHECK (char_length(btrim(code)) > 0),
  CONSTRAINT price_levels_name_present CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT price_levels_method CHECK (pricing_method IN ('explicit', 'markup_discount', 'cost_plus')),
  CONSTRAINT price_levels_formula_shape CHECK (
    (pricing_method = 'explicit' AND percentage IS NULL AND cost_basis IS NULL)
    OR (pricing_method = 'markup_discount' AND percentage IS NOT NULL AND cost_basis IS NULL)
    OR (pricing_method = 'cost_plus' AND percentage IS NOT NULL AND cost_basis IN ('item_cost', 'standard_cost', 'average_cost'))
  )
);
CREATE UNIQUE INDEX price_levels_one_base ON public.price_levels (org_id) WHERE is_base AND is_active;
CREATE INDEX price_levels_org_active ON public.price_levels (org_id, name) WHERE is_active;

CREATE TABLE public.customer_price_level_assignments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  price_level_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT customer_price_level_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_price_level_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT customer_price_level_customer_fk FOREIGN KEY (org_id, customer_id)
    REFERENCES public.parties (org_id, id),
  CONSTRAINT customer_price_level_level_fk FOREIGN KEY (org_id, price_level_id)
    REFERENCES public.price_levels (org_id, id)
);
ALTER TABLE public.customer_price_level_assignments
  ADD CONSTRAINT customer_price_level_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    customer_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (is_active);
CREATE INDEX customer_price_level_lookup
  ON public.customer_price_level_assignments (org_id, customer_id, effective_from DESC)
  WHERE is_active;

CREATE TABLE public.item_price_schedules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  price_level_id uuid,
  customer_id uuid,
  currency text NOT NULL,
  quantity_basis text NOT NULL DEFAULT 'line_quantity',
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT item_price_schedules_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT item_price_schedule_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT item_price_schedule_quantity_basis CHECK (quantity_basis IN ('line_quantity', 'overall_item_quantity')),
  CONSTRAINT item_price_schedule_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT item_price_schedule_scope CHECK (
    (customer_id IS NULL AND price_level_id IS NOT NULL)
    OR (customer_id IS NOT NULL AND price_level_id IS NULL)
  ),
  CONSTRAINT item_price_schedule_item_fk FOREIGN KEY (org_id, item_id)
    REFERENCES public.items (org_id, id),
  CONSTRAINT item_price_schedule_level_fk FOREIGN KEY (org_id, price_level_id)
    REFERENCES public.price_levels (org_id, id),
  CONSTRAINT item_price_schedule_customer_fk FOREIGN KEY (org_id, customer_id)
    REFERENCES public.parties (org_id, id)
);
-- General matrix rows always name their level, including the tenant's one base
-- level. Customer/item absolute prices are the only schedules without a level.
ALTER TABLE public.item_price_schedules
  ADD CONSTRAINT item_price_schedule_general_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    item_id WITH =,
    currency WITH =,
    price_level_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (is_active AND customer_id IS NULL);
-- A customer/item absolute price outranks every level and has one effective
-- window per currency.
ALTER TABLE public.item_price_schedules
  ADD CONSTRAINT item_price_schedule_customer_no_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    item_id WITH =,
    currency WITH =,
    customer_id WITH =,
    daterange(effective_from, COALESCE(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (is_active AND customer_id IS NOT NULL);
CREATE INDEX item_price_schedule_lookup
  ON public.item_price_schedules (org_id, item_id, currency, effective_from DESC)
  WHERE is_active;

CREATE TABLE public.item_price_breaks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  minimum_quantity numeric(19,4) NOT NULL,
  unit_price numeric(19,4) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT item_price_break_quantity_positive CHECK (minimum_quantity > 0),
  CONSTRAINT item_price_break_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT item_price_break_schedule_fk FOREIGN KEY (org_id, schedule_id)
    REFERENCES public.item_price_schedules (org_id, id) ON DELETE CASCADE,
  CONSTRAINT item_price_break_unique UNIQUE (org_id, schedule_id, minimum_quantity)
);
CREATE INDEX item_price_break_lookup
  ON public.item_price_breaks (org_id, schedule_id, minimum_quantity DESC);

CREATE FUNCTION public.item_pricing_customer_role_guard() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customer_roles role
     WHERE role.org_id = NEW.org_id AND role.party_id = NEW.customer_id AND role.is_active
  ) THEN
    RAISE EXCEPTION 'Pricing customer % is not an active customer in this organization', NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$func$;
CREATE TRIGGER customer_price_level_role_check
  BEFORE INSERT OR UPDATE OF org_id, customer_id, is_active
  ON public.customer_price_level_assignments
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION public.item_pricing_customer_role_guard();
CREATE TRIGGER item_price_schedule_customer_role_check
  BEFORE INSERT OR UPDATE OF org_id, customer_id, is_active
  ON public.item_price_schedules
  FOR EACH ROW WHEN (NEW.is_active AND NEW.customer_id IS NOT NULL)
  EXECUTE FUNCTION public.item_pricing_customer_role_guard();

CREATE FUNCTION public.item_pricing_level_guard() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF NEW.price_level_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.price_levels level
     WHERE level.org_id = NEW.org_id AND level.id = NEW.price_level_id AND level.is_active
  ) THEN
    RAISE EXCEPTION 'Pricing level % is not active in this organization', NEW.price_level_id;
  END IF;
  RETURN NEW;
END;
$func$;
CREATE TRIGGER customer_price_level_active_check
  BEFORE INSERT OR UPDATE OF org_id, price_level_id, is_active
  ON public.customer_price_level_assignments
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION public.item_pricing_level_guard();
CREATE TRIGGER item_price_schedule_level_active_check
  BEFORE INSERT OR UPDATE OF org_id, price_level_id, is_active
  ON public.item_price_schedules
  FOR EACH ROW WHEN (NEW.is_active AND NEW.price_level_id IS NOT NULL)
  EXECUTE FUNCTION public.item_pricing_level_guard();

INSERT INTO public.price_levels (org_id, code, name, is_base, is_active)
SELECT org.id, 'BASE', 'Base price', true, true FROM public.orgs org
WHERE NOT EXISTS (SELECT 1 FROM public.price_levels level WHERE level.org_id = org.id AND level.is_base AND level.is_active);

CREATE FUNCTION public.create_org_base_price_level() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  INSERT INTO public.price_levels (org_id, code, name, is_base, is_active)
  VALUES (NEW.id, 'BASE', 'Base price', true, true);
  RETURN NEW;
END;
$func$;
CREATE TRIGGER org_base_price_level AFTER INSERT ON public.orgs
  FOR EACH ROW EXECUTE FUNCTION public.create_org_base_price_level();

CREATE FUNCTION public.protect_org_base_price_level() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF OLD.is_base THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'The organization base price level must remain active; edit its name or add another price level instead';
    END IF;
    IF NOT NEW.is_base OR NOT NEW.is_active OR NEW.org_id <> OLD.org_id THEN
      RAISE EXCEPTION 'The organization base price level must remain active; edit its name or add another price level instead';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$func$;
CREATE TRIGGER price_level_base_guard
  BEFORE UPDATE OR DELETE ON public.price_levels
  FOR EACH ROW EXECUTE FUNCTION public.protect_org_base_price_level();

DO $rls$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['price_levels', 'customer_price_level_assignments', 'item_price_schedules', 'item_price_breaks'] LOOP
    EXECUTE format('ALTER TABLE ONLY public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE ONLY public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY org_isolation ON public.%I USING ((current_setting(''app.bypass_rls'', true) = ''on'') OR (org_id::text = current_setting(''app.current_org'', true))) WITH CHECK ((current_setting(''app.bypass_rls'', true) = ''on'') OR (org_id::text = current_setting(''app.current_org'', true)))', tbl
    );
  END LOOP;
END;
$rls$;

COMMENT ON TABLE public.price_levels IS 'Tenant-defined item price levels and formula metadata; the item matrix stores the auditable resolved prices.';
COMMENT ON TABLE public.customer_price_level_assignments IS 'Effective-dated default price level for a customer; active windows may not overlap.';
COMMENT ON TABLE public.item_price_schedules IS 'Effective-dated currency and quantity pricing grids, optionally absolute for one customer.';
COMMENT ON TABLE public.item_price_breaks IS 'All-units quantity breaks; the greatest applicable minimum quantity supplies the exact unit price.';
