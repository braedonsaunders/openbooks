-- OpenBooks forward migration 0419_warehouses.
--
-- A warehouse is a stock location of kind 'warehouse'; its bins, zones and
-- staging areas hang beneath it through parent_id, and that hierarchy stays
-- the one truth for which warehouse encloses a bin. This migration gives each
-- warehouse a name, an address and a lifecycle (draft, active, suspended,
-- retired) in `warehouses`, and adds ordered putaway rules deciding which
-- location inside a warehouse receives stock.
--
-- Ownership is not restated: stock belongs to a legal entity through its
-- cost layers, and which entities may use a location is the locations
-- dimension restriction. A warehouse therefore carries no subsidiary column.
--
-- Triggers keep every write path (setup, imports, fixtures) inside the
-- invariants: a warehouse row sits on a warehouse-kind location with no
-- warehouse-kind ancestor or descendant; a location with a warehouse row
-- keeps its kind; a putaway rule targets a location inside its own
-- warehouse; and every new warehouse-kind location receives its warehouse
-- row, so paths that create warehouses today keep their behaviour.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Mirror of the read-only preflight: refuse by name before any DDL rather
-- than failing inside the unique index build or the backfill trigger.
DO $preflight$
DECLARE
  finding record;
BEGIN
  SELECT sl.org_id, sl.code INTO finding
    FROM public.stock_locations sl
   WHERE sl.kind = 'warehouse'
   GROUP BY sl.org_id, sl.code
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'warehouse code % is used by more than one warehouse in organization %; rename all but one before applying 0419',
      finding.code, finding.org_id;
  END IF;

  WITH RECURSIVE chain AS (
    SELECT w.org_id, w.id AS warehouse_id, w.code AS warehouse_code, w.parent_id AS ancestor_id, 1 AS depth
      FROM public.stock_locations w
     WHERE w.kind = 'warehouse' AND w.parent_id IS NOT NULL
    UNION ALL
    SELECT c.org_id, c.warehouse_id, c.warehouse_code, p.parent_id, c.depth + 1
      FROM chain c
      JOIN public.stock_locations p ON p.id = c.ancestor_id AND p.org_id = c.org_id
     WHERE p.kind <> 'warehouse' AND p.parent_id IS NOT NULL AND c.depth < 64
  )
  SELECT c.org_id, c.warehouse_code, a.code AS ancestor_code INTO finding
    FROM chain c
    JOIN public.stock_locations a ON a.id = c.ancestor_id AND a.org_id = c.org_id
   WHERE a.kind = 'warehouse'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'warehouse % sits inside warehouse % in organization %; change one of them to a zone before applying 0419',
      finding.warehouse_code, finding.ancestor_code, finding.org_id;
  END IF;
END
$preflight$;

-- Nearest warehouse-kind location at or above a stock location, or null when
-- the location sits in no warehouse. Invoker rights: RLS still scopes it.
CREATE FUNCTION public.stock_location_warehouse(p_org_id uuid, p_stock_location_id uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  current_id uuid := p_stock_location_id;
  current_kind text;
  next_id uuid;
  depth integer := 0;
BEGIN
  WHILE current_id IS NOT NULL LOOP
    SELECT sl.kind, sl.parent_id INTO current_kind, next_id
      FROM public.stock_locations sl
     WHERE sl.id = current_id AND sl.org_id = p_org_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    IF current_kind = 'warehouse' THEN
      RETURN current_id;
    END IF;
    depth := depth + 1;
    IF depth > 64 THEN
      RAISE EXCEPTION 'stock location % has a parent chain deeper than 64 levels or a cycle', p_stock_location_id;
    END IF;
    current_id := next_id;
  END LOOP;
  RETURN NULL;
END
$fn$;

CREATE TABLE public.warehouses (
  stock_location_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text,
  status_changed_at timestamp with time zone,
  status_changed_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT warehouses_pkey PRIMARY KEY (stock_location_id),
  CONSTRAINT warehouses_org_stock_location_unique UNIQUE (org_id, stock_location_id),
  CONSTRAINT warehouses_stock_location_fkey
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations (org_id, id),
  CONSTRAINT warehouses_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT warehouses_status_check
    CHECK (status IN ('draft', 'active', 'suspended', 'retired')),
  CONSTRAINT warehouses_country_check CHECK (country IS NULL OR country ~ '^[A-Z]{2}$')
);

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.warehouses
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.warehouses IS
  'Name, address and lifecycle of a warehouse-kind stock location. Every movement is admitted against the enclosing warehouse status: draft and retired refuse all, suspended refuses inbound only.';
COMMENT ON COLUMN public.warehouses.country IS
  'ISO 3166-1 alpha-2 country code of the warehouse address.';

CREATE TABLE public.putaway_rules (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  sequence integer NOT NULL,
  item_id uuid,
  strategy text NOT NULL,
  target_location_id uuid NOT NULL,
  capacity_quantity numeric(28,8),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT putaway_rules_pkey PRIMARY KEY (id),
  CONSTRAINT putaway_rules_warehouse_sequence_unique UNIQUE (org_id, warehouse_id, sequence),
  CONSTRAINT putaway_rules_warehouse_fkey
    FOREIGN KEY (org_id, warehouse_id) REFERENCES public.warehouses (org_id, stock_location_id),
  CONSTRAINT putaway_rules_target_fkey
    FOREIGN KEY (org_id, target_location_id) REFERENCES public.stock_locations (org_id, id),
  CONSTRAINT putaway_rules_item_fkey
    FOREIGN KEY (org_id, item_id) REFERENCES public.items (org_id, id),
  CONSTRAINT putaway_rules_sequence_check CHECK (sequence > 0),
  CONSTRAINT putaway_rules_strategy_check
    CHECK (strategy IN ('fixed-bin', 'empty-bin', 'bulk-zone')),
  CONSTRAINT putaway_rules_capacity_check
    CHECK (capacity_quantity IS NULL OR capacity_quantity > 0),
  CONSTRAINT putaway_rules_bulk_zone_capacity_check
    CHECK (strategy <> 'bulk-zone' OR capacity_quantity IS NOT NULL)
);

ALTER TABLE public.putaway_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.putaway_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.putaway_rules
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX putaway_rules_org_target
  ON public.putaway_rules (org_id, target_location_id);

COMMENT ON TABLE public.putaway_rules IS
  'Ordered putaway rules per warehouse. Resolution walks rules by sequence; a null item_id applies to every item. fixed-bin and bulk-zone honour capacity_quantity; empty-bin takes the first active bin under the target holding no stock.';

-- A warehouse code names one warehouse per organization.
CREATE UNIQUE INDEX stock_locations_org_warehouse_code
  ON public.stock_locations (org_id, code)
  WHERE kind = 'warehouse';

-- Warehouses never nest: no warehouse-kind location may have a
-- warehouse-kind ancestor. Checked for the written row in both directions.
CREATE FUNCTION public.stock_locations_warehouse_nesting_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  enclosing uuid;
  enclosing_code text;
  nested_code text;
BEGIN
  enclosing := public.stock_location_warehouse(NEW.org_id, NEW.parent_id);
  IF NEW.kind = 'warehouse' AND enclosing IS NOT NULL THEN
    SELECT code INTO enclosing_code FROM public.stock_locations WHERE id = enclosing AND org_id = NEW.org_id;
    RAISE EXCEPTION 'warehouse % cannot sit inside warehouse %; make it a zone or move it out', NEW.code, enclosing_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.kind = 'warehouse' OR enclosing IS NOT NULL) THEN
    WITH RECURSIVE below AS (
      SELECT c.id, c.code, c.kind, 1 AS depth
        FROM public.stock_locations c
       WHERE c.parent_id = NEW.id AND c.org_id = NEW.org_id
      UNION ALL
      SELECT c.id, c.code, c.kind, b.depth + 1
        FROM below b
        JOIN public.stock_locations c ON c.parent_id = b.id AND c.org_id = NEW.org_id
       WHERE b.depth < 64
    )
    SELECT code INTO nested_code FROM below WHERE kind = 'warehouse' LIMIT 1;
    IF nested_code IS NOT NULL THEN
      RAISE EXCEPTION 'warehouse % cannot sit inside another warehouse; make it a zone or move it out', nested_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER stock_locations_warehouse_nesting_guard
  BEFORE INSERT OR UPDATE OF kind, parent_id ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.stock_locations_warehouse_nesting_guard();

-- A location that carries a warehouse row keeps its kind, and a re-parented
-- subtree may not carry a putaway target out of its rule's warehouse.
CREATE FUNCTION public.stock_locations_warehouse_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  stranded record;
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
       SELECT 1 FROM public.warehouses w
        WHERE w.stock_location_id = OLD.id AND w.org_id = OLD.org_id) THEN
    RAISE EXCEPTION 'stock location % is a warehouse and cannot change kind; retire the warehouse and create the new location instead', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    SELECT r.sequence, t.code AS target_code, wl.code AS warehouse_code INTO stranded
      FROM public.putaway_rules r
      JOIN public.stock_locations t ON t.id = r.target_location_id AND t.org_id = r.org_id
      JOIN public.stock_locations wl ON wl.id = r.warehouse_id AND wl.org_id = r.org_id
     WHERE r.org_id = NEW.org_id
       AND public.stock_location_warehouse(r.org_id, r.target_location_id) IS DISTINCT FROM r.warehouse_id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'moving % would take putaway target % out of warehouse % (rule %); change that rule first',
        NEW.code, stranded.target_code, stranded.warehouse_code, stranded.sequence
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER stock_locations_warehouse_shape_guard
  AFTER UPDATE OF kind, parent_id ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.stock_locations_warehouse_shape_guard();

-- Every warehouse-kind location has its warehouse row. A location created
-- active starts active (today's behaviour for setup, imports and fixtures);
-- one created inactive starts suspended.
CREATE FUNCTION public.stock_locations_warehouse_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  IF NEW.kind = 'warehouse' AND NOT EXISTS (
       SELECT 1 FROM public.warehouses w
        WHERE w.stock_location_id = NEW.id AND w.org_id = NEW.org_id) THEN
    INSERT INTO public.warehouses
      (stock_location_id, org_id, name, status, status_changed_at, status_changed_by, created_by, updated_by)
    VALUES
      (NEW.id, NEW.org_id, NEW.code,
       CASE WHEN NEW.is_active THEN 'active' ELSE 'suspended' END,
       now(), NEW.created_by, NEW.created_by, NEW.created_by);
  END IF;
  RETURN NULL;
END
$fn$;

CREATE TRIGGER stock_locations_warehouse_row
  AFTER INSERT OR UPDATE OF kind ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public.stock_locations_warehouse_row();

-- A warehouse row sits on a warehouse-kind location.
CREATE FUNCTION public.warehouses_location_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  location_kind text;
  location_code text;
BEGIN
  SELECT kind, code INTO location_kind, location_code
    FROM public.stock_locations
   WHERE id = NEW.stock_location_id AND org_id = NEW.org_id;
  IF location_kind IS DISTINCT FROM 'warehouse' THEN
    RAISE EXCEPTION 'stock location % is a %, not a warehouse; only a warehouse-kind location can be a warehouse',
      coalesce(location_code, NEW.stock_location_id::text), coalesce(location_kind, 'missing location')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER warehouses_location_guard
  BEFORE INSERT OR UPDATE OF stock_location_id, org_id ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.warehouses_location_guard();

-- A putaway rule's target lies inside the rule's own warehouse.
CREATE FUNCTION public.putaway_rules_target_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  target_code text;
  warehouse_code text;
BEGIN
  IF public.stock_location_warehouse(NEW.org_id, NEW.target_location_id) IS DISTINCT FROM NEW.warehouse_id THEN
    SELECT code INTO target_code FROM public.stock_locations WHERE id = NEW.target_location_id AND org_id = NEW.org_id;
    SELECT code INTO warehouse_code FROM public.stock_locations WHERE id = NEW.warehouse_id AND org_id = NEW.org_id;
    RAISE EXCEPTION 'putaway target % is not inside warehouse %; choose a bin or zone under that warehouse',
      coalesce(target_code, NEW.target_location_id::text), coalesce(warehouse_code, NEW.warehouse_id::text)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER putaway_rules_target_guard
  BEFORE INSERT OR UPDATE OF warehouse_id, target_location_id, org_id ON public.putaway_rules
  FOR EACH ROW EXECUTE FUNCTION public.putaway_rules_target_guard();

-- Backfill: every existing warehouse-kind location gets its row, named by its
-- code; active when the location is active, else suspended.
INSERT INTO public.warehouses
  (stock_location_id, org_id, name, status, status_changed_at, created_at, created_by, updated_at, updated_by)
SELECT sl.id, sl.org_id, sl.code,
       CASE WHEN sl.is_active THEN 'active' ELSE 'suspended' END,
       now(), sl.created_at, sl.created_by, now(), sl.updated_by
  FROM public.stock_locations sl
 WHERE sl.kind = 'warehouse'
   AND NOT EXISTS (
         SELECT 1 FROM public.warehouses w
          WHERE w.stock_location_id = sl.id AND w.org_id = sl.org_id);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('warehouses', '0419_warehouses'), ('putaway_rules', '0419_warehouses')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
