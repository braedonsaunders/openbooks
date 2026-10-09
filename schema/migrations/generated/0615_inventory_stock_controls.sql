-- Physical allocation controls, external ownership and auditable count evidence preserve the inventory subledger.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

ALTER TABLE public.lots ADD COLUMN hold_reason text CHECK(hold_reason IS NULL OR length(btrim(hold_reason)) BETWEEN 5 AND 500);
ALTER TABLE public.serials ADD COLUMN hold_reason text CHECK(hold_reason IS NULL OR length(btrim(hold_reason)) BETWEEN 5 AND 500);
ALTER TABLE public.serials ADD COLUMN lot_id uuid;
ALTER TABLE public.serials ADD CONSTRAINT serials_lot_tenant FOREIGN KEY(org_id,lot_id) REFERENCES public.lots(org_id,id);
ALTER TABLE public.item_inventory_profiles ADD CONSTRAINT inventory_tracking_mode CHECK(tracking IN('none','lot','serial','lot_serial')) NOT VALID;
ALTER TABLE public.mfg_wo_materials DROP CONSTRAINT mfg_wo_materials_tracking_check;
ALTER TABLE public.mfg_wo_materials ADD CONSTRAINT mfg_wo_materials_tracking_check CHECK(lot_serial_policy IN('none','lot','serial','lot_serial'));
ALTER TABLE public.item_inventory_profiles ADD COLUMN abc_class text CHECK(abc_class IN('A','B','C'));
ALTER TABLE public.stock_locations ADD COLUMN inventory_ownership text NOT NULL DEFAULT 'owned' CHECK(inventory_ownership IN('owned','vendor','customer'));
ALTER TABLE public.stock_locations ADD COLUMN owner_party_id uuid;
ALTER TABLE public.stock_locations ADD CONSTRAINT stock_location_owner_tenant FOREIGN KEY(org_id,owner_party_id) REFERENCES public.parties(org_id,id);
ALTER TABLE public.stock_locations ADD CONSTRAINT stock_location_external_owner CHECK((inventory_ownership='owned')=(owner_party_id IS NULL));

CREATE OR REPLACE FUNCTION public.inventory_movement_tracking_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE tracking_mode text; serial_lot uuid;
BEGIN
 SELECT tracking INTO tracking_mode FROM public.item_inventory_profiles WHERE org_id=NEW.org_id AND item_id=NEW.item_id;
 IF tracking_mode IS NULL OR tracking_mode NOT IN('none','lot','serial','lot_serial') THEN
  RAISE EXCEPTION 'Inventory movement requires a supported tenant-owned profile' USING ERRCODE='23514';
 END IF;
 IF tracking_mode='none' AND num_nonnulls(NEW.lot_id,NEW.serial_id)>0 THEN
  RAISE EXCEPTION 'Untracked stock cannot carry identifiers' USING ERRCODE='23514';
 END IF;
 IF tracking_mode IN('lot','lot_serial') THEN
  IF NEW.lot_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.lots WHERE org_id=NEW.org_id AND id=NEW.lot_id AND item_id=NEW.item_id) THEN
   RAISE EXCEPTION 'Lot tracking requires the item and tenant lot' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.lot_id IS NOT NULL THEN RAISE EXCEPTION 'This profile does not track lots' USING ERRCODE='23514'; END IF;
 IF tracking_mode IN('serial','lot_serial') THEN
  IF NEW.serial_id IS NULL OR abs(NEW.quantity)<>1 OR NOT EXISTS(SELECT 1 FROM public.serials WHERE org_id=NEW.org_id AND id=NEW.serial_id AND item_id=NEW.item_id) THEN
   RAISE EXCEPTION 'Serial tracking requires exactly one unit of the item and tenant serial' USING ERRCODE='23514';
  END IF;
  SELECT lot_id INTO serial_lot FROM public.serials WHERE org_id=NEW.org_id AND id=NEW.serial_id;
  IF tracking_mode='lot_serial' AND serial_lot IS DISTINCT FROM NEW.lot_id THEN
   RAISE EXCEPTION 'Serial must belong to the movement lot' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.serial_id IS NOT NULL THEN RAISE EXCEPTION 'This profile does not track serials' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION public.inventory_serial_lot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.lot_id IS NOT NULL AND NEW.lot_id IS DISTINCT FROM OLD.lot_id THEN RAISE EXCEPTION 'Serial lot identity is immutable'; END IF;
 IF NEW.lot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.lots WHERE org_id=NEW.org_id AND id=NEW.lot_id AND item_id=NEW.item_id) THEN RAISE EXCEPTION 'Serial lot must belong to its item and tenant'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_serial_lot_guard BEFORE INSERT OR UPDATE OF lot_id ON public.serials FOR EACH ROW EXECUTE FUNCTION public.inventory_serial_lot_guard();

CREATE TABLE public.inventory_count_policies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 abc_class text NOT NULL CHECK(abc_class IN('A','B','C')),interval_days integer NOT NULL CHECK(interval_days BETWEEN 1 AND 3650),
 variance_tolerance numeric(19,4) NOT NULL CHECK(variance_tolerance>=0),effective_from date NOT NULL,effective_to date,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 UNIQUE(org_id,id),CHECK(effective_to IS NULL OR effective_to>effective_from),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 CONSTRAINT inventory_count_policy_overlap EXCLUDE USING gist(org_id WITH =,subsidiary_id WITH =,abc_class WITH =,daterange(effective_from,effective_to,'[)') WITH &&)
);
ALTER TABLE public.stock_counts ADD COLUMN blind boolean NOT NULL DEFAULT false;
ALTER TABLE public.stock_count_lines ADD COLUMN serial_id uuid;
ALTER TABLE public.stock_count_lines ADD CONSTRAINT count_line_serial_tenant FOREIGN KEY(org_id,serial_id) REFERENCES public.serials(org_id,id);
ALTER TABLE public.stock_count_lines ADD COLUMN variance_tolerance numeric(19,4) CHECK(variance_tolerance>=0);
ALTER TABLE public.stock_count_lines ADD COLUMN first_counted_quantity numeric(19,4) CHECK(first_counted_quantity>=0);
ALTER TABLE public.stock_count_lines ADD COLUMN second_counted_quantity numeric(19,4) CHECK(second_counted_quantity>=0);
ALTER TABLE public.stock_count_lines ADD COLUMN first_counted_by uuid;
ALTER TABLE public.stock_count_lines ADD COLUMN second_counted_by uuid;
ALTER TABLE public.stock_count_lines ADD COLUMN second_counted_at timestamptz;
DROP INDEX public.stock_count_lines_no_duplicate_subject;
CREATE UNIQUE INDEX stock_count_lines_no_duplicate_subject ON public.stock_count_lines(org_id,stock_count_id,item_id,stock_location_id,lot_id,serial_id) NULLS NOT DISTINCT WHERE NOT is_pre_guard_legacy;

CREATE TABLE public.consignment_stock (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 item_id uuid NOT NULL,stock_location_id uuid NOT NULL,owner_party_id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN('vendor','customer')),
 lot_id uuid,serial_id uuid,received_on date NOT NULL,original_quantity numeric(19,4) NOT NULL CHECK(original_quantity>0),remaining_quantity numeric(19,4) NOT NULL CHECK(remaining_quantity>=0 AND remaining_quantity<=original_quantity),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),FOREIGN KEY(org_id,stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,owner_party_id) REFERENCES public.parties(org_id,id),FOREIGN KEY(org_id,lot_id) REFERENCES public.lots(org_id,id),FOREIGN KEY(org_id,serial_id) REFERENCES public.serials(org_id,id),
 CHECK(serial_id IS NULL OR original_quantity=1)
);
CREATE FUNCTION public.consignment_position_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
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
  IF EXISTS(SELECT 1 FROM public.cost_layers layer JOIN public.inventory_movements source ON source.org_id=layer.org_id AND source.id=layer.source_movement_id
    WHERE layer.org_id=NEW.org_id AND source.serial_id=NEW.serial_id AND layer.remaining_quantity>0) THEN
   RAISE EXCEPTION 'Serial is already valued stock; issue or return it before receiving external custody';
  END IF;
 ELSIF NEW.serial_id IS NOT NULL THEN RAISE EXCEPTION 'This custody item does not track serials'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER consignment_position_guard BEFORE INSERT OR UPDATE OR DELETE ON public.consignment_stock FOR EACH ROW EXECUTE FUNCTION public.consignment_position_guard();
CREATE UNIQUE INDEX consignment_live_serial ON public.consignment_stock(org_id,serial_id) WHERE serial_id IS NOT NULL AND remaining_quantity>0;
CREATE UNIQUE INDEX inventory_movements_org_id_identity ON public.inventory_movements(org_id,id);
CREATE TABLE public.consignment_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),stock_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('receive','transfer','return','take_ownership')),quantity numeric(19,4) NOT NULL CHECK(quantity>0),
 occurred_on date NOT NULL,to_stock_id uuid,receipt_movement_id uuid,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,
 UNIQUE(org_id,id),FOREIGN KEY(org_id,stock_id) REFERENCES public.consignment_stock(org_id,id),FOREIGN KEY(org_id,to_stock_id) REFERENCES public.consignment_stock(org_id,id),
 FOREIGN KEY(org_id,receipt_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CHECK((kind='take_ownership')=(receipt_movement_id IS NOT NULL)),CHECK((kind='transfer')=(to_stock_id IS NOT NULL))
);
CREATE FUNCTION public.consignment_event_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Consignment events are immutable; record a correcting stock operation';
END $$;
CREATE TRIGGER consignment_event_immutable BEFORE UPDATE OR DELETE ON public.consignment_events FOR EACH ROW EXECUTE FUNCTION public.consignment_event_immutable();

ALTER TABLE public.inventory_count_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.inventory_count_policies USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
ALTER TABLE public.consignment_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consignment_stock FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.consignment_stock USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
ALTER TABLE public.consignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consignment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.consignment_events USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE FUNCTION public.stock_location_ownership_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.inventory_ownership,NEW.owner_party_id) IS DISTINCT FROM (OLD.inventory_ownership,OLD.owner_party_id) THEN
  IF EXISTS(SELECT 1 FROM public.cost_layers WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inventory_provisional_costs WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.consignment_stock WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.stock_locations WHERE org_id=OLD.org_id AND parent_id=OLD.id) THEN
   RAISE EXCEPTION 'Location ownership is fixed once stock history exists; use a new location for a different owner';
  END IF;
 END IF;
 IF NEW.parent_id IS NOT NULL THEN
  PERFORM id FROM public.stock_locations WHERE org_id=NEW.org_id AND id=NEW.parent_id FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM public.stock_locations p WHERE p.org_id=NEW.org_id AND p.id=NEW.parent_id
    AND p.inventory_ownership=NEW.inventory_ownership AND p.owner_party_id IS NOT DISTINCT FROM NEW.owner_party_id) THEN
   RAISE EXCEPTION 'Child locations must preserve their parent ownership';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_location_ownership_guard BEFORE INSERT OR UPDATE OF inventory_ownership,owner_party_id,parent_id ON public.stock_locations FOR EACH ROW EXECUTE FUNCTION public.stock_location_ownership_guard();
CREATE FUNCTION public.inventory_owned_position_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE ownership text;
BEGIN
 SELECT inventory_ownership INTO ownership FROM public.stock_locations WHERE org_id=NEW.org_id AND id=NEW.stock_location_id FOR SHARE;
 IF ownership IS DISTINCT FROM 'owned' THEN RAISE EXCEPTION 'Valued inventory requires an owned stock location; use the custody command'; END IF;
 IF NEW.serial_id IS NOT NULL THEN
  PERFORM id FROM public.serials WHERE org_id=NEW.org_id AND id=NEW.serial_id FOR UPDATE;
  IF NEW.quantity>0 AND EXISTS(SELECT 1 FROM public.consignment_stock WHERE org_id=NEW.org_id AND serial_id=NEW.serial_id AND remaining_quantity>0) THEN
   RAISE EXCEPTION 'Serial is externally owned; take ownership through the custody command';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_owned_position_guard BEFORE INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_owned_position_guard();
CREATE FUNCTION public.inventory_count_policy_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF OLD.effective_from<=current_date THEN
  IF TG_OP='UPDATE' AND (NEW.org_id,NEW.subsidiary_id,NEW.abc_class,NEW.interval_days,NEW.variance_tolerance,NEW.effective_from)
   IS NOT DISTINCT FROM (OLD.org_id,OLD.subsidiary_id,OLD.abc_class,OLD.interval_days,OLD.variance_tolerance,OLD.effective_from)
   AND NEW.effective_to IS NOT NULL AND NEW.effective_to>=current_date AND (OLD.effective_to IS NULL OR NEW.effective_to<=OLD.effective_to) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Effective cycle-count policies are immutable; close the policy and add a successor';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_count_policy_history_guard BEFORE UPDATE OR DELETE ON public.inventory_count_policies FOR EACH ROW EXECUTE FUNCTION public.inventory_count_policy_history_guard();
SELECT public.openbooks_refresh_query_catalog();
COMMENT ON POLICY org_isolation ON public.inventory_count_policies IS 'openbooks:org_isolation:v1';
COMMENT ON POLICY org_isolation ON public.consignment_stock IS 'openbooks:org_isolation:v1';
COMMENT ON POLICY org_isolation ON public.consignment_events IS 'openbooks:org_isolation:v1';
