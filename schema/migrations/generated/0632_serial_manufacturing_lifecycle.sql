-- Admit serial manufacturing consumption, accepted receipt repair and governed completion reversal.
-- Existing serial identity, transfer, receipt, count-restoration and retirement controls are retained.
DO $admission$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc proc JOIN pg_catalog.pg_namespace namespace ON namespace.oid=proc.pronamespace
   WHERE namespace.nspname='public' AND proc.proname='inventory_serial_lifecycle_guard'
     AND proc.pronargs=0 AND proc.prorettype='trigger'::regtype AND NOT proc.prosecdef
     AND proc.proconfig IS NULL
     AND encode(public.digest(proc.prosrc,'sha256'),'hex')='dbfa848bebb13a143ed711a40365301b6cb5c3d49e3c41777763266a5cf89540'
 ) THEN RAISE EXCEPTION 'Serial manufacturing lifecycle requires the unchanged published serial and retirement guard.'; END IF;
END $admission$;

CREATE OR REPLACE FUNCTION public.inventory_serial_lifecycle_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
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

  IF OLD.status = 'shipped' AND NEW.status = 'in_stock'
     AND OLD.current_missing_count_movement_id IS NOT NULL
     AND NEW.current_stock_location_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.inventory_movements receipt
        WHERE receipt.org_id=OLD.org_id AND receipt.serial_id=OLD.id AND receipt.kind='receipt'
          AND public.inventory_serial_count_restoration_matches(OLD.org_id,OLD.id,
            OLD.current_missing_count_movement_id,NEW.current_stock_location_id,receipt.id)
     ) THEN
    RETURN NEW;
  END IF;

  -- A serial component leaves stock only after its valued manufacturing issue.
  IF OLD.status = 'in_stock' AND NEW.status = 'shipped'
     AND NEW.current_stock_location_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.inventory_movements movement
       JOIN public.journal_entries entry ON entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id
       JOIN public.mfg_work_orders work ON work.org_id=entry.org_id AND work.number=entry.custom->>'work_order_number'
        WHERE movement.org_id=OLD.org_id AND movement.item_id=OLD.item_id AND movement.serial_id=OLD.id
          AND movement.kind='assembly_consume' AND movement.quantity=-1 AND movement.status='posted'
          AND movement.stock_location_id=OLD.current_stock_location_id
          AND entry.origin='manufacturing' AND entry.status='posted' AND entry.reverses_entry_id IS NULL
          AND movement.subsidiary_id=work.subsidiary_id AND entry.subsidiary_id=work.subsidiary_id
          AND work.status IN ('released','in_progress') AND work.bom_revision IS NOT NULL AND work.routing_version IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.mfg_wo_materials material WHERE material.org_id=work.org_id AND material.work_order_id=work.id AND material.component_item_id=OLD.item_id)
          AND NOT EXISTS (SELECT 1 FROM public.inventory_movements reversal WHERE reversal.org_id=movement.org_id AND reversal.reverses_movement_id=movement.id)
     )
     AND (SELECT coalesce(sum(quantity),0) FROM public.inventory_movements WHERE org_id=OLD.org_id AND item_id=OLD.item_id AND serial_id=OLD.id AND status='posted')=0 THEN
    RETURN NEW;
  END IF;

  -- Repair returns the original serial after its exact issue and latest accepted operation inspection.
  IF OLD.status = 'shipped' AND NEW.status = 'in_stock'
     AND NEW.current_stock_location_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.inventory_movements receipt
       JOIN public.journal_entries entry ON entry.org_id=receipt.org_id AND entry.id=receipt.journal_entry_id
       JOIN public.mfg_work_orders work ON work.org_id=entry.org_id AND work.number=entry.custom->>'work_order_number'
       JOIN public.inventory_inspections failed ON failed.org_id=work.org_id AND failed.id=work.receipt_rework_inspection_id
       JOIN public.inventory_movements original ON original.org_id=failed.org_id AND original.id=failed.receipt_movement_id
        WHERE receipt.org_id=OLD.org_id AND receipt.item_id=OLD.item_id AND receipt.serial_id=OLD.id
          AND receipt.kind='assembly_build' AND receipt.quantity=1 AND receipt.status='posted'
          AND receipt.stock_location_id=NEW.current_stock_location_id
          AND receipt.subsidiary_id=work.subsidiary_id AND entry.subsidiary_id=work.subsidiary_id
          AND entry.origin='manufacturing' AND entry.status='posted' AND entry.reverses_entry_id IS NULL
          AND work.produced_item_id=OLD.item_id AND work.status IN ('released','in_progress')
          AND failed.item_id=OLD.item_id AND failed.serial_id=OLD.id AND failed.quantity=1
          AND failed.status='fail' AND failed.disposition='rework' AND failed.rework_work_order_id=work.id
          AND original.item_id=OLD.item_id AND original.serial_id=OLD.id AND original.status='posted'
          AND NOT EXISTS (SELECT 1 FROM public.inventory_movements reversal WHERE reversal.org_id=original.org_id AND reversal.reverses_movement_id=original.id)
          AND NOT EXISTS (SELECT 1 FROM public.inventory_movements reversal WHERE reversal.org_id=receipt.org_id AND reversal.reverses_movement_id=receipt.id)
          AND EXISTS (
            SELECT 1 FROM public.inventory_movements issued
            JOIN public.journal_entries issue_entry ON issue_entry.org_id=issued.org_id AND issue_entry.id=issued.journal_entry_id
            JOIN public.cost_layer_consumptions consumption ON consumption.org_id=issued.org_id AND consumption.issue_movement_id=issued.id
            JOIN public.cost_layers layer ON layer.org_id=consumption.org_id AND layer.id=consumption.cost_layer_id
             WHERE issued.org_id=work.org_id AND issued.item_id=OLD.item_id AND issued.serial_id=OLD.id
               AND issued.kind='assembly_consume' AND issued.quantity=-1 AND issued.status='posted'
               AND issued.stock_location_id=failed.stock_location_id AND issued.subsidiary_id=work.subsidiary_id
               AND issue_entry.origin='manufacturing' AND issue_entry.status='posted' AND issue_entry.reverses_entry_id IS NULL
               AND issue_entry.custom->>'work_order_number'=work.number
               AND layer.source_movement_id=original.id AND consumption.quantity=1
               AND NOT EXISTS (SELECT 1 FROM public.inventory_movements reversal WHERE reversal.org_id=issued.org_id AND reversal.reverses_movement_id=issued.id)
          )
          AND EXISTS (
            SELECT 1 FROM public.mfg_wo_operations operation
            JOIN public.inventory_inspections accepted ON accepted.org_id=operation.org_id AND accepted.operation_id=operation.id
             WHERE operation.org_id=work.org_id AND operation.work_order_id=work.id AND operation.sequence=work.receipt_rework_sequence
               AND operation.status='done' AND operation.quantity_done>=1
               AND accepted.item_id=OLD.item_id AND accepted.serial_id=OLD.id AND accepted.quantity>=1 AND accepted.status='pass'
               AND NOT EXISTS (SELECT 1 FROM public.inventory_inspections newer WHERE newer.org_id=accepted.org_id AND newer.operation_id=accepted.operation_id AND newer.serial_id=OLD.id AND newer.inspection_sequence>accepted.inspection_sequence)
          )
     )
     AND (SELECT coalesce(sum(quantity),0) FROM public.inventory_movements WHERE org_id=OLD.org_id AND item_id=OLD.item_id AND serial_id=OLD.id AND status='posted')=1 THEN
    RETURN NEW;
  END IF;

  -- A posted mirror receipt reversal removes stock while preserving its reusable serial identity.
  IF OLD.status = 'in_stock' AND NEW.status = 'registered'
     AND NEW.current_stock_location_id IS NULL
     AND EXISTS (
       SELECT 1 FROM public.inventory_movements source
       JOIN public.inventory_movements reversal ON reversal.org_id=source.org_id AND reversal.reverses_movement_id=source.id
       JOIN public.journal_entries entry ON entry.org_id=source.org_id AND entry.id=source.journal_entry_id
       JOIN public.journal_entries mirror ON mirror.org_id=reversal.org_id AND mirror.id=reversal.journal_entry_id AND mirror.reverses_entry_id=entry.id
       JOIN public.mfg_work_orders work ON work.org_id=entry.org_id AND work.number=entry.custom->>'work_order_number'
        WHERE source.org_id=OLD.org_id AND source.item_id=OLD.item_id AND source.serial_id=OLD.id
          AND source.kind='assembly_build' AND source.quantity=1 AND source.status='posted'
          AND source.stock_location_id=OLD.current_stock_location_id
          AND reversal.item_id=OLD.item_id AND reversal.serial_id=OLD.id AND reversal.kind='return' AND reversal.quantity=-1 AND reversal.status='posted'
          AND reversal.stock_location_id=source.stock_location_id AND reversal.subsidiary_id=source.subsidiary_id
          AND entry.origin='manufacturing' AND entry.status='reversed' AND mirror.status='posted'
          AND mirror.book_id=entry.book_id AND mirror.subsidiary_id=entry.subsidiary_id
          AND source.subsidiary_id=work.subsidiary_id AND entry.subsidiary_id=work.subsidiary_id
     )
     AND (SELECT coalesce(sum(quantity),0) FROM public.inventory_movements WHERE org_id=OLD.org_id AND item_id=OLD.item_id AND serial_id=OLD.id AND status='posted')=0 THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'serial lifecycle transition lacks matching posted inventory evidence';
END
$$;
