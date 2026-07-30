BEGIN;

-- Tracked stock must retain discrete receipt provenance. Moving-average
-- blending destroys the lot/serial-to-layer relationship, so fail closed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'item_inventory_profiles'::regclass
       AND conname = 'item_inventory_profiles_tracking_costing'
  ) THEN
    ALTER TABLE item_inventory_profiles
      ADD CONSTRAINT item_inventory_profiles_tracking_costing
      CHECK (tracking = 'none' OR costing_method <> 'moving_average')
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE item_inventory_profiles
  VALIDATE CONSTRAINT item_inventory_profiles_tracking_costing;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'serials'::regclass
       AND conname = 'serials_status_location'
  ) THEN
    ALTER TABLE serials
      ADD CONSTRAINT serials_status_location
      CHECK (
        (status = 'in_stock' AND current_stock_location_id IS NOT NULL)
        OR (status <> 'in_stock' AND current_stock_location_id IS NULL)
      )
      NOT VALID;
  END IF;
END
$$;
ALTER TABLE serials VALIDATE CONSTRAINT serials_status_location;

CREATE OR REPLACE FUNCTION inventory_movement_tracking_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_tracking text;
BEGIN
  SELECT profile.tracking
    INTO v_tracking
    FROM item_inventory_profiles profile
   WHERE profile.org_id = NEW.org_id
     AND profile.item_id = NEW.item_id;
  IF v_tracking IS NULL THEN
    RAISE EXCEPTION 'inventory movement item has no tenant-owned inventory profile'
      USING ERRCODE = '23514';
  END IF;

  IF v_tracking = 'none' THEN
    IF NEW.lot_id IS NOT NULL OR NEW.serial_id IS NOT NULL THEN
      RAISE EXCEPTION 'untracked inventory movement cannot carry lot or serial evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tracking = 'lot' THEN
    IF NEW.lot_id IS NULL OR NEW.serial_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM lots lot
       WHERE lot.id = NEW.lot_id
         AND lot.org_id = NEW.org_id
         AND lot.item_id = NEW.item_id
    ) THEN
      RAISE EXCEPTION 'lot-tracked movement requires a tenant/item-owned lot'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_tracking = 'serial' THEN
    IF NEW.serial_id IS NULL OR NEW.lot_id IS NOT NULL
       OR abs(NEW.quantity) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM serials serial
          WHERE serial.id = NEW.serial_id
            AND serial.org_id = NEW.org_id
            AND serial.item_id = NEW.item_id
       ) THEN
      RAISE EXCEPTION 'serial-tracked movement requires one tenant/item-owned serial'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported inventory tracking policy %', v_tracking
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS inventory_movement_tracking_guard_trigger
  ON inventory_movements;
CREATE TRIGGER inventory_movement_tracking_guard_trigger
BEFORE INSERT OR UPDATE OF org_id, item_id, lot_id, serial_id, quantity
ON inventory_movements
FOR EACH ROW EXECUTE FUNCTION inventory_movement_tracking_guard();

CREATE OR REPLACE FUNCTION inventory_lot_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'lot identity and recall evidence cannot be deleted';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.lot_number IS DISTINCT FROM OLD.lot_number
     OR (OLD.expires_on IS NOT NULL
         AND NEW.expires_on IS DISTINCT FROM OLD.expires_on) THEN
    RAISE EXCEPTION 'lot identity is immutable; only a missing expiry may be completed';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS inventory_lot_identity_guard_trigger ON lots;
CREATE TRIGGER inventory_lot_identity_guard_trigger
BEFORE UPDATE OR DELETE ON lots
FOR EACH ROW EXECUTE FUNCTION inventory_lot_identity_guard();

CREATE OR REPLACE FUNCTION inventory_serial_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'serial identity and movement evidence cannot be deleted';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.serial_number IS DISTINCT FROM OLD.serial_number THEN
    RAISE EXCEPTION 'serial identity is immutable';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.current_stock_location_id IS NOT DISTINCT FROM OLD.current_stock_location_id THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'registered' AND NEW.status = 'in_stock'
     AND NEW.current_stock_location_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM inventory_movements movement
        WHERE movement.org_id = OLD.org_id
          AND movement.serial_id = OLD.id
          AND movement.kind = 'receipt'
          AND movement.quantity = 1
          AND movement.stock_location_id = NEW.current_stock_location_id
          AND movement.status = 'posted'
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'in_stock' AND NEW.status = 'shipped'
     AND NEW.current_stock_location_id IS NULL
     AND EXISTS (
       SELECT 1 FROM inventory_movements movement
        WHERE movement.org_id = OLD.org_id
          AND movement.serial_id = OLD.id
          AND movement.kind = 'issue'
          AND movement.quantity = -1
          AND movement.stock_location_id = OLD.current_stock_location_id
          AND movement.status = 'posted'
          AND NOT EXISTS (
            SELECT 1 FROM inventory_movements reversal
             WHERE reversal.org_id = movement.org_id
               AND reversal.reverses_movement_id = movement.id
          )
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'in_stock' AND NEW.status = 'in_stock'
     AND NEW.current_stock_location_id IS DISTINCT FROM OLD.current_stock_location_id
     AND (
       EXISTS (
         SELECT 1
           FROM inventory_movements outbound
           JOIN inventory_movements inbound
             ON inbound.org_id = outbound.org_id
            AND inbound.paired_movement_id = outbound.id
          WHERE outbound.org_id = OLD.org_id
            AND outbound.serial_id = OLD.id
            AND inbound.serial_id = OLD.id
            AND outbound.kind = 'transfer_out'
            AND inbound.kind = 'transfer_in'
            AND outbound.stock_location_id = OLD.current_stock_location_id
            AND inbound.stock_location_id = NEW.current_stock_location_id
            AND outbound.status = 'posted'
            AND inbound.status = 'posted'
       )
       OR EXISTS (
         SELECT 1
           FROM inventory_movements source_out
           JOIN inventory_movements source_in
             ON source_in.org_id = source_out.org_id
            AND source_in.paired_movement_id = source_out.id
           JOIN inventory_movements reversal_out
             ON reversal_out.org_id = source_out.org_id
            AND reversal_out.reverses_movement_id = source_out.id
           JOIN inventory_movements reversal_in
             ON reversal_in.org_id = source_in.org_id
            AND reversal_in.reverses_movement_id = source_in.id
          WHERE source_out.org_id = OLD.org_id
            AND source_out.serial_id = OLD.id
            AND source_in.serial_id = OLD.id
            AND source_in.stock_location_id = OLD.current_stock_location_id
            AND source_out.stock_location_id = NEW.current_stock_location_id
       )
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'shipped' AND NEW.status = 'in_stock'
     AND NEW.current_stock_location_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM inventory_movements source
         JOIN inventory_movements reversal
           ON reversal.org_id = source.org_id
          AND reversal.reverses_movement_id = source.id
        WHERE source.org_id = OLD.org_id
          AND source.serial_id = OLD.id
          AND source.kind = 'issue'
          AND source.stock_location_id = NEW.current_stock_location_id
          AND reversal.serial_id = OLD.id
          AND reversal.status = 'posted'
     ) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'in_stock' AND NEW.status = 'returned'
     AND NEW.current_stock_location_id IS NULL
     AND EXISTS (
       SELECT 1
         FROM inventory_movements source
         JOIN inventory_movements reversal
           ON reversal.org_id = source.org_id
          AND reversal.reverses_movement_id = source.id
        WHERE source.org_id = OLD.org_id
          AND source.serial_id = OLD.id
          AND source.kind = 'receipt'
          AND source.stock_location_id = OLD.current_stock_location_id
          AND reversal.serial_id = OLD.id
          AND reversal.status = 'posted'
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'serial lifecycle transition lacks matching posted inventory evidence';
END
$$;

DROP TRIGGER IF EXISTS inventory_serial_lifecycle_guard_trigger ON serials;
CREATE TRIGGER inventory_serial_lifecycle_guard_trigger
BEFORE UPDATE OR DELETE ON serials
FOR EACH ROW EXECUTE FUNCTION inventory_serial_lifecycle_guard();

COMMIT;
