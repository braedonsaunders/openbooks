-- OpenBooks forward migration 0444_warehouse_row_trigger_clone.
-- Preserve copied warehouse records during sandbox cloning and remove their dependent configuration with a deleted location.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.stock_locations_warehouse_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  IF public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
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

ALTER TABLE public.warehouses
  DROP CONSTRAINT warehouses_stock_location_fkey,
  ADD CONSTRAINT warehouses_stock_location_fkey
    FOREIGN KEY (org_id, stock_location_id)
    REFERENCES public.stock_locations (org_id, id) ON DELETE CASCADE;

ALTER TABLE public.putaway_rules
  DROP CONSTRAINT putaway_rules_warehouse_fkey,
  ADD CONSTRAINT putaway_rules_warehouse_fkey
    FOREIGN KEY (org_id, warehouse_id)
    REFERENCES public.warehouses (org_id, stock_location_id) ON DELETE CASCADE;

ALTER TABLE public.putaway_rules
  DROP CONSTRAINT putaway_rules_target_fkey,
  ADD CONSTRAINT putaway_rules_target_fkey
    FOREIGN KEY (org_id, target_location_id)
    REFERENCES public.stock_locations (org_id, id) ON DELETE CASCADE;
