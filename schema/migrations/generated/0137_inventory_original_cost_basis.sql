-- 0137_inventory_original_cost_basis.sql: exact surviving inventory original cost.
-- Additive provenance only: legacy pooled receipt anchors cannot establish cost.
ALTER TABLE public.cost_layers ADD COLUMN IF NOT EXISTS remaining_original_cost numeric(19,4);
ALTER TABLE public.cost_layer_consumptions ADD COLUMN IF NOT EXISTS original_cost numeric(19,4);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cost_layers'::regclass AND conname='cost_layers_original_cost') THEN
    ALTER TABLE public.cost_layers ADD CONSTRAINT cost_layers_original_cost
      CHECK (remaining_original_cost >= 0 AND (remaining_quantity > 0 OR remaining_original_cost = 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.cost_layer_consumptions'::regclass AND conname='layer_consumptions_original_cost') THEN
    ALTER TABLE public.cost_layer_consumptions ADD CONSTRAINT layer_consumptions_original_cost CHECK (original_cost >= 0);
  END IF;
END $$;

-- A rolling old runtime does not maintain this new balance. Its economic
-- writes must invalidate provenance, including partial and full consumption.
-- The local marker is a writer-version signal, never an authorization grant.
CREATE OR REPLACE FUNCTION public.inventory_original_cost_writer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('openbooks.inventory_original_cost_writer',true) IS DISTINCT FROM 'basis-v1'
     AND ROW(NEW.original_quantity,NEW.remaining_quantity,NEW.unit_cost,NEW.source_movement_id,
             NEW.org_id,NEW.subsidiary_id,NEW.item_id,NEW.stock_location_id)
       IS DISTINCT FROM ROW(OLD.original_quantity,OLD.remaining_quantity,OLD.unit_cost,OLD.source_movement_id,
             OLD.org_id,OLD.subsidiary_id,OLD.item_id,OLD.stock_location_id) THEN
    NEW.remaining_original_cost := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inventory_original_cost_writer_guard ON public.cost_layers;
CREATE TRIGGER inventory_original_cost_writer_guard BEFORE UPDATE ON public.cost_layers
  FOR EACH ROW EXECUTE FUNCTION public.inventory_original_cost_writer_guard();

CREATE OR REPLACE FUNCTION public.inventory_original_cost_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.remaining_original_cost IS DISTINCT FROM OLD.remaining_original_cost THEN
    INSERT INTO public.audit_log (org_id,table_name,row_id,action,changes,actor_id)
    VALUES (NEW.org_id,'cost_layers',NEW.id,lower(TG_OP),
      jsonb_build_object('reason',CASE WHEN TG_OP='UPDATE' AND
          current_setting('openbooks.inventory_original_cost_writer',true) IS DISTINCT FROM 'basis-v1'
          AND OLD.remaining_original_cost IS NOT NULL AND NEW.remaining_original_cost IS NULL
        THEN 'Original-cost provenance invalidated by an unversioned inventory writer'
        ELSE 'Inventory original-cost balance change' END,
        'before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW)),
      CASE WHEN TG_OP='INSERT' THEN NEW.created_by
        WHEN current_setting('openbooks.inventory_original_cost_writer',true)='basis-v1' THEN NEW.updated_by ELSE NULL END);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inventory_original_cost_audit ON public.cost_layers;
CREATE TRIGGER inventory_original_cost_audit AFTER INSERT OR UPDATE ON public.cost_layers
  FOR EACH ROW EXECUTE FUNCTION public.inventory_original_cost_audit();

CREATE OR REPLACE FUNCTION public.inventory_consumed_original_cost_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.org_id,NEW.subsidiary_id,NEW.cost_layer_id,NEW.issue_movement_id,NEW.quantity,NEW.unit_cost,NEW.original_cost)
     IS DISTINCT FROM ROW(OLD.org_id,OLD.subsidiary_id,OLD.cost_layer_id,OLD.issue_movement_id,OLD.quantity,OLD.unit_cost,OLD.original_cost) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='inventory_consumed_original_cost_immutable',
      MESSAGE='inventory consumption cost evidence is immutable; use controlled reversal';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS inventory_consumed_original_cost_guard ON public.cost_layer_consumptions;
CREATE TRIGGER inventory_consumed_original_cost_guard BEFORE UPDATE ON public.cost_layer_consumptions
  FOR EACH ROW EXECUTE FUNCTION public.inventory_consumed_original_cost_guard();
