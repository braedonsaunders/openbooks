-- Serial count recovery binds to the current missing-count movement and final posted review evidence.
-- Retired external custody remains immutable history without claiming current valued stock.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

ALTER TABLE public.serials ADD COLUMN current_missing_count_movement_id uuid;
ALTER TABLE public.serials ADD CONSTRAINT serial_missing_count_tenant
 FOREIGN KEY(org_id,current_missing_count_movement_id) REFERENCES public.inventory_movements(org_id,id)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.serials ADD CONSTRAINT serial_missing_count_state
 CHECK(current_missing_count_movement_id IS NULL OR (status='shipped' AND current_stock_location_id IS NULL));
ALTER TABLE public.stock_count_lines ADD CONSTRAINT serial_count_first_observer
 FOREIGN KEY(first_counted_by) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.stock_count_lines ADD CONSTRAINT serial_count_second_observer
 FOREIGN KEY(second_counted_by) REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED;

-- Pending evidence belongs to this transaction; historical evidence must already have completed review.
CREATE FUNCTION public.inventory_serial_count_line_matches(subject_org uuid,subject_line uuid,subject_movement uuid,require_posted boolean)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.stock_count_lines line
  JOIN public.stock_counts count ON count.org_id=line.org_id AND count.id=line.stock_count_id
  JOIN public.inventory_movements movement ON movement.org_id=line.org_id AND movement.id=line.adjustment_movement_id
  JOIN public.journal_entries entry ON entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id
  JOIN public.serials serial ON serial.org_id=line.org_id AND serial.id=line.serial_id
  JOIN public.users actor ON actor.org_id=movement.org_id AND actor.id=movement.created_by
  WHERE line.org_id=subject_org AND line.id=subject_line AND movement.id=subject_movement
   AND count.status=CASE WHEN require_posted THEN 'posted' ELSE 'review' END
   AND movement.status='posted' AND movement.kind IN('receipt','issue')
   AND movement.item_id=line.item_id AND movement.stock_location_id=line.stock_location_id
   AND movement.subsidiary_id=count.subsidiary_id AND movement.serial_id=line.serial_id
   AND movement.lot_id IS NOT DISTINCT FROM line.lot_id
   AND serial.item_id=line.item_id AND serial.lot_id IS NOT DISTINCT FROM line.lot_id
   AND movement.moved_at::date=count.counted_on AND movement.quantity=line.counted_quantity-line.expected_quantity
   AND ((movement.kind='receipt' AND line.expected_quantity=0 AND line.counted_quantity=1 AND movement.quantity=1)
     OR (movement.kind='issue' AND line.expected_quantity=1 AND line.counted_quantity=0 AND movement.quantity=-1))
   AND line.first_counted_quantity IS NOT NULL AND line.first_counted_by IS NOT NULL
   AND line.first_counted_quantity IN(0,1) AND line.variance_tolerance IS NOT NULL
   AND EXISTS(SELECT 1 FROM public.users observer WHERE observer.org_id=line.org_id AND observer.id=line.first_counted_by)
   AND (abs(line.first_counted_quantity-line.expected_quantity)<=line.variance_tolerance
     OR (line.second_counted_quantity=line.counted_quantity AND line.second_counted_at IS NOT NULL
       AND EXISTS(SELECT 1 FROM public.users observer WHERE observer.org_id=line.org_id AND observer.id=line.second_counted_by)))
   AND entry.status='posted' AND entry.origin='inventory' AND entry.subsidiary_id=count.subsidiary_id
   AND entry.posting_date=count.counted_on AND entry.posted_by=movement.created_by
   AND line.updated_by=movement.created_by
   AND (require_posted OR movement.xmin=(pg_current_xact_id()::text::bigint % 4294967296)::text::xid)

 );
$$;

CREATE FUNCTION public.inventory_serial_count_restoration_matches(subject_org uuid,subject_serial uuid,missing_movement uuid,destination uuid,receipt_movement uuid)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.inventory_movements missing
  JOIN public.stock_count_lines missing_line ON missing_line.org_id=missing.org_id AND missing_line.adjustment_movement_id=missing.id
  JOIN public.inventory_movements receipt ON receipt.org_id=missing.org_id
  JOIN public.stock_count_lines found_line ON found_line.org_id=receipt.org_id AND found_line.adjustment_movement_id=receipt.id
  WHERE missing.org_id=subject_org AND missing.id=missing_movement AND missing.serial_id=subject_serial
   AND missing.kind='issue' AND receipt.id=receipt_movement AND receipt.kind='receipt'
   AND receipt.serial_id=missing.serial_id AND receipt.item_id=missing.item_id
   AND receipt.subsidiary_id=missing.subsidiary_id AND receipt.stock_location_id=missing.stock_location_id
   AND receipt.stock_location_id=destination AND receipt.lot_id IS NOT DISTINCT FROM missing.lot_id
   AND public.inventory_serial_count_line_matches(subject_org,missing_line.id,missing.id,true)
   AND public.inventory_serial_count_line_matches(subject_org,found_line.id,receipt.id,false)
   AND NOT EXISTS(SELECT 1 FROM public.inventory_movements reversal
     WHERE reversal.org_id=missing.org_id AND reversal.reverses_movement_id=missing.id)
 );
$$;

-- Registered copying preserves immutable count evidence; audit logs remain environment-local.
CREATE FUNCTION public.inventory_serial_count_clone_line_matches(candidate public.stock_count_lines)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.orgs target
  JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
  JOIN public.stock_count_lines source ON source.org_id=target.sandbox_of
  WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
   AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
   AND public.ob_rebase(source.id,target.sandbox_seed)=(candidate).id
   AND (public.ob_rebase(source.stock_count_id,target.sandbox_seed),public.ob_rebase(source.item_id,target.sandbox_seed),
     public.ob_rebase(source.stock_location_id,target.sandbox_seed),public.ob_rebase(source.lot_id,target.sandbox_seed),
     public.ob_rebase(source.serial_id,target.sandbox_seed),public.ob_rebase(source.adjustment_movement_id,target.sandbox_seed),
     source.expected_quantity,source.counted_quantity,source.variance_tolerance,source.first_counted_quantity,
     source.second_counted_quantity,source.second_counted_at,public.ob_rebase(source.first_counted_by,target.sandbox_seed),
     public.ob_rebase(source.second_counted_by,target.sandbox_seed)) IS NOT DISTINCT FROM
    ((candidate).stock_count_id,(candidate).item_id,(candidate).stock_location_id,(candidate).lot_id,
     (candidate).serial_id,(candidate).adjustment_movement_id,(candidate).expected_quantity,(candidate).counted_quantity,
     (candidate).variance_tolerance,(candidate).first_counted_quantity,(candidate).second_counted_quantity,
     (candidate).second_counted_at,(candidate).first_counted_by,(candidate).second_counted_by)
 );
$$;
CREATE FUNCTION public.inventory_serial_count_clone_marker_matches(candidate public.serials)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.orgs target
  JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
  JOIN public.serials source ON source.org_id=target.sandbox_of
  WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
   AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
   AND public.ob_rebase(source.id,target.sandbox_seed)=(candidate).id
   AND (public.ob_rebase(source.item_id,target.sandbox_seed),public.ob_rebase(source.lot_id,target.sandbox_seed),
     public.ob_rebase(source.current_stock_location_id,target.sandbox_seed),source.status,
     public.ob_rebase(source.current_missing_count_movement_id,target.sandbox_seed)) IS NOT DISTINCT FROM
    ((candidate).item_id,(candidate).lot_id,(candidate).current_stock_location_id,(candidate).status,
     (candidate).current_missing_count_movement_id)
 );
$$;

CREATE FUNCTION public.inventory_serial_count_marker_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.current_missing_count_movement_id IS NULL OR public.inventory_serial_count_clone_marker_matches(NEW) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Serial missing-count identity requires its native posted transition';
 END IF;
 IF NEW.current_missing_count_movement_id IS DISTINCT FROM OLD.current_missing_count_movement_id
    AND NEW.current_missing_count_movement_id IS NOT NULL THEN
  IF OLD.status='in_stock' AND NEW.status='shipped' AND NEW.current_stock_location_id IS NULL AND EXISTS(
   SELECT 1 FROM public.stock_count_lines line JOIN public.inventory_movements movement
    ON movement.org_id=line.org_id AND movement.id=line.adjustment_movement_id
   WHERE line.org_id=NEW.org_id AND movement.id=NEW.current_missing_count_movement_id
    AND movement.kind='issue' AND movement.serial_id=NEW.id AND movement.item_id=NEW.item_id
    AND movement.stock_location_id=OLD.current_stock_location_id AND movement.lot_id IS NOT DISTINCT FROM NEW.lot_id
    AND public.inventory_serial_count_line_matches(NEW.org_id,line.id,movement.id,false)
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Serial missing-count identity must match its exact current count issue';
 END IF;
 IF (NEW.status,NEW.current_stock_location_id) IS DISTINCT FROM (OLD.status,OLD.current_stock_location_id) THEN
  NEW.current_missing_count_movement_id=NULL;
  RETURN NEW;
 END IF;
 IF NEW.current_missing_count_movement_id IS DISTINCT FROM OLD.current_missing_count_movement_id THEN
  RAISE EXCEPTION 'Serial missing-count identity cannot change without its lifecycle transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_serial_count_marker_guard BEFORE INSERT OR UPDATE ON public.serials
 FOR EACH ROW EXECUTE FUNCTION public.inventory_serial_count_marker_guard();

-- A receipt or shortage cannot commit from a reviewed shell or a stale/forged line association.
CREATE FUNCTION public.inventory_serial_count_posted_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE required_review boolean;
BEGIN
 IF NEW.serial_id IS NULL OR NEW.adjustment_movement_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.inventory_serial_count_clone_line_matches(NEW) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Copied serial count evidence must retain its exact registered source identity and observations';
 END IF;
 IF TG_OP='UPDATE' AND NEW.adjustment_movement_id IS NOT DISTINCT FROM OLD.adjustment_movement_id THEN RETURN NEW; END IF;
 SELECT coalesce((settings->'approvals'->>'requireStockCountReview')='true',false) INTO required_review
  FROM public.orgs WHERE id=NEW.org_id;
 IF NOT public.inventory_serial_count_line_matches(NEW.org_id,NEW.id,NEW.adjustment_movement_id,true)
    OR NOT EXISTS(
     SELECT 1 FROM public.stock_count_lines line
     JOIN public.stock_counts count ON count.org_id=line.org_id AND count.id=line.stock_count_id
     JOIN public.inventory_movements movement ON movement.org_id=line.org_id AND movement.id=line.adjustment_movement_id
     JOIN public.audit_log audit ON audit.org_id=count.org_id AND audit.table_name='stock_counts' AND audit.row_id=count.id
     WHERE line.org_id=NEW.org_id AND line.id=NEW.id AND movement.id=NEW.adjustment_movement_id
      AND movement.xmin=(pg_current_xact_id()::text::bigint % 4294967296)::text::xid
      AND audit.xmin=movement.xmin AND audit.changes->>'operation'='post'
      AND audit.actor_id=movement.created_by AND audit.changes->'review'->>'postedBy'=audit.actor_id::text
      AND count.updated_by=audit.actor_id AND (audit.changes->'review'->>'required')::boolean=required_review
      AND (NOT required_review OR NOT (coalesce(audit.changes->'review'->'contributors','[]'::jsonb) ? audit.actor_id::text))
      AND (NOT required_review OR NOT EXISTS(
        SELECT 1 FROM public.stock_count_lines contributor WHERE contributor.org_id=count.org_id AND contributor.stock_count_id=count.id
          AND audit.actor_id IN(contributor.created_by,contributor.first_counted_by,contributor.second_counted_by)
        UNION ALL SELECT 1 WHERE count.created_by=audit.actor_id
        UNION ALL SELECT 1 FROM public.audit_log observation WHERE observation.org_id=count.org_id
          AND observation.table_name='stock_count_lines' AND observation.changes->>'countId'=count.id::text
          AND observation.changes->>'operation' IN('record','recount','second_count') AND observation.actor_id=audit.actor_id
      ))
    ) THEN
  RAISE EXCEPTION 'Serial count adjustment requires exact posted count, journal and independent review evidence';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER inventory_serial_count_posted_guard AFTER INSERT OR UPDATE ON public.stock_count_lines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_serial_count_posted_guard();

CREATE FUNCTION public.inventory_serial_count_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF OLD.serial_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.stock_counts count
   WHERE count.org_id=OLD.org_id AND count.id=OLD.stock_count_id AND count.status='posted') THEN
  RAISE EXCEPTION 'Posted serial count observations and movement associations are immutable; record a new count';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_serial_count_history_guard BEFORE UPDATE OR DELETE ON public.stock_count_lines
 FOR EACH ROW EXECUTE FUNCTION public.inventory_serial_count_history_guard();

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

  RAISE EXCEPTION 'serial lifecycle transition lacks matching posted inventory evidence';
END
$$;

CREATE OR REPLACE FUNCTION public.consignment_position_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE tracking_mode text; location_owner text; location_party uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Custody history is immutable; return the stock through the custody command';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.subsidiary_id,NEW.item_id,NEW.stock_location_id,NEW.owner_party_id,NEW.owner_kind,NEW.lot_id,NEW.serial_id,NEW.received_on,NEW.original_quantity,NEW.reason,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.subsidiary_id,OLD.item_id,OLD.stock_location_id,OLD.owner_party_id,OLD.owner_kind,OLD.lot_id,OLD.serial_id,OLD.received_on,OLD.original_quantity,OLD.reason,OLD.created_by,OLD.created_at)
    OR NEW.remaining_quantity>OLD.remaining_quantity THEN
   RAISE EXCEPTION 'Custody identity and received quantity are immutable; record a new custody operation';
  END IF;
  RETURN NEW;
 END IF;
 SELECT inventory_ownership,owner_party_id INTO location_owner,location_party FROM public.stock_locations
  WHERE org_id=NEW.org_id AND id=NEW.stock_location_id FOR SHARE;
 IF location_owner IS DISTINCT FROM NEW.owner_kind OR location_party IS DISTINCT FROM NEW.owner_party_id THEN
  RAISE EXCEPTION 'Custody location must carry the recorded external owner';
 END IF;
 SELECT tracking INTO tracking_mode FROM public.item_inventory_profiles WHERE org_id=NEW.org_id AND item_id=NEW.item_id FOR SHARE;
 IF tracking_mode IS NULL OR tracking_mode NOT IN('none','lot','serial','lot_serial') THEN RAISE EXCEPTION 'Custody requires an inventory profile'; END IF;
 IF tracking_mode IN('lot','lot_serial') THEN
  IF NEW.lot_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.lots WHERE org_id=NEW.org_id AND id=NEW.lot_id AND item_id=NEW.item_id) THEN RAISE EXCEPTION 'Custody requires the item lot'; END IF;
 ELSIF NEW.lot_id IS NOT NULL THEN RAISE EXCEPTION 'This custody item does not track lots'; END IF;
 IF tracking_mode IN('serial','lot_serial') THEN
  PERFORM id FROM public.serials WHERE org_id=NEW.org_id AND id=NEW.serial_id FOR UPDATE;
  IF NEW.serial_id IS NULL OR NEW.original_quantity<>1 OR NOT EXISTS(SELECT 1 FROM public.serials
    WHERE org_id=NEW.org_id AND id=NEW.serial_id AND item_id=NEW.item_id
      AND (tracking_mode<>'lot_serial' OR lot_id=NEW.lot_id)) THEN RAISE EXCEPTION 'Custody requires one unit of the item serial and its lot'; END IF;
  IF NEW.remaining_quantity>0 AND EXISTS(SELECT 1 FROM public.cost_layers layer JOIN public.inventory_movements source ON source.org_id=layer.org_id AND source.id=layer.source_movement_id
    WHERE layer.org_id=NEW.org_id AND source.serial_id=NEW.serial_id AND layer.remaining_quantity>0) THEN
   RAISE EXCEPTION 'Serial is already valued stock; issue or return it before receiving external custody';
  END IF;
 ELSIF NEW.serial_id IS NOT NULL THEN RAISE EXCEPTION 'This custody item does not track serials'; END IF;
 RETURN NEW;
END $$;
