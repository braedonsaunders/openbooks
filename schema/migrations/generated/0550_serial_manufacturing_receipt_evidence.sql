-- OpenBooks forward migration 0550_serial_manufacturing_receipt_evidence.
-- A posted manufacturing completion receives a finished serial through an
-- assembly_build movement. Admit that receipt evidence while preserving
-- serial identity, unit quantity, location and lifecycle checks.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.inventory_serial_lifecycle_guard() RETURNS trigger
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
          AND movement.kind IN ('receipt', 'assembly_build')
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
