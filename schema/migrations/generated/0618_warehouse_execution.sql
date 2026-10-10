-- Directed warehouse work records suggestions, confirmations, exceptions and physical handling-unit history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

CREATE TABLE public.warehouse_execution_tasks (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL,stage text NOT NULL CHECK(stage IN('receive','putaway','pick','pack','count')),
 document_line_id uuid,count_line_id uuid,item_id uuid NOT NULL,lot_id uuid,serial_id uuid,
 from_stock_location_id uuid NOT NULL,to_stock_location_id uuid NOT NULL,
 quantity numeric(19,4) NOT NULL CHECK(quantity>=0),document_quantity numeric(28,8) NOT NULL CHECK(document_quantity>=0),
 document_unit text,posting_date date NOT NULL,basis jsonb NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','done','cancelled')),
 command_key text NOT NULL CHECK(length(btrim(command_key)) BETWEEN 8 AND 200),result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,command_key),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),
 FOREIGN KEY(org_id,from_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,to_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,lot_id) REFERENCES public.lots(org_id,id),FOREIGN KEY(org_id,serial_id) REFERENCES public.serials(org_id,id),
 FOREIGN KEY(document_line_id) REFERENCES public.document_lines(id),FOREIGN KEY(count_line_id) REFERENCES public.stock_count_lines(id),
 FOREIGN KEY(created_by) REFERENCES public.users(id),FOREIGN KEY(updated_by) REFERENCES public.users(id),
 CHECK((stage='count')=(count_line_id IS NOT NULL)),CHECK(stage IN('putaway','count') OR document_line_id IS NOT NULL)
);
CREATE INDEX warehouse_execution_open ON public.warehouse_execution_tasks(org_id,subsidiary_id,stage,created_at,id) WHERE status='open';
CREATE UNIQUE INDEX warehouse_receive_confirmed_line ON public.warehouse_execution_tasks(org_id,document_line_id)
 WHERE stage='receive' AND status='done';
CREATE TABLE public.warehouse_scan_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),task_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN('confirmed','exception')),observed jsonb NOT NULL,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES public.users(id),
 UNIQUE(org_id,id),FOREIGN KEY(org_id,task_id) REFERENCES public.warehouse_execution_tasks(org_id,id),
 CHECK((outcome='exception')=(reason IS NOT NULL))
);

ALTER TABLE public.fulfillment_documents ADD COLUMN execution_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.fulfillment_documents ADD COLUMN pick_priority integer NOT NULL DEFAULT 0;
ALTER TABLE public.fulfillment_documents ADD COLUMN release_cutoff_at timestamptz;
CREATE FUNCTION public.fulfillment_execution_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.execution_required IS DISTINCT FROM OLD.execution_required THEN
  RAISE EXCEPTION 'Fulfillment execution policy is captured at creation and cannot reinterpret existing work';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_execution_policy BEFORE UPDATE OF execution_required ON public.fulfillment_documents
 FOR EACH ROW EXECUTE FUNCTION public.fulfillment_execution_policy_guard();
CREATE TABLE public.pick_waves (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 warehouse_id uuid NOT NULL,mode text NOT NULL CHECK(mode IN('cutoff','priority')),cutoff_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('released','pending_approval')),command_key text NOT NULL,request jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES public.users(id),
 UNIQUE(org_id,id),UNIQUE(org_id,command_key),FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,warehouse_id) REFERENCES public.stock_locations(org_id,id)
);
CREATE TABLE public.pick_wave_members (
 org_id uuid NOT NULL REFERENCES public.orgs(id),wave_id uuid NOT NULL,pick_list_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0),priority integer NOT NULL,cutoff_at timestamptz NOT NULL,
 release_status text NOT NULL CHECK(release_status IN('approved','pending_approval')),
 PRIMARY KEY(org_id,wave_id,pick_list_id),UNIQUE(org_id,wave_id,sequence),
 FOREIGN KEY(org_id,wave_id) REFERENCES public.pick_waves(org_id,id),FOREIGN KEY(pick_list_id) REFERENCES public.documents(id)
);
CREATE TABLE public.pick_execution_lines (
 line_id uuid PRIMARY KEY REFERENCES public.document_lines(id),org_id uuid NOT NULL REFERENCES public.orgs(id),
 document_id uuid NOT NULL REFERENCES public.documents(id),requested_quantity numeric(28,8) NOT NULL CHECK(requested_quantity>0),
 picked_quantity numeric(28,8) NOT NULL CHECK(picked_quantity>=0),short_quantity numeric(28,8) NOT NULL CHECK(short_quantity>=0),
 current_stock_location_id uuid NOT NULL,confirmation_task_id uuid,reason text,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES public.users(id),
 UNIQUE(org_id,line_id),CHECK(picked_quantity+short_quantity=requested_quantity),
 CHECK(short_quantity=0 OR length(btrim(reason)) BETWEEN 5 AND 500),
 FOREIGN KEY(org_id,current_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,confirmation_task_id) REFERENCES public.warehouse_execution_tasks(org_id,id)
);

CREATE TABLE public.handling_units (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 code text NOT NULL CHECK(length(btrim(code)) BETWEEN 1 AND 60),warehouse_id uuid NOT NULL,current_stock_location_id uuid NOT NULL,initial_stock_location_id uuid NOT NULL,
 shipment_document_id uuid NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','packed','shipped','voided')),
 content_version bigint NOT NULL DEFAULT 0 CHECK(content_version>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,code),FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,warehouse_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,current_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,initial_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(shipment_document_id) REFERENCES public.documents(id),
 FOREIGN KEY(created_by) REFERENCES public.users(id),FOREIGN KEY(updated_by) REFERENCES public.users(id)
);
CREATE TABLE public.handling_unit_contents (
 org_id uuid NOT NULL REFERENCES public.orgs(id),handling_unit_id uuid NOT NULL,shipment_line_id uuid NOT NULL,
 pick_line_id uuid NOT NULL,item_id uuid NOT NULL,lot_id uuid,serial_id uuid,
 quantity numeric(19,4) NOT NULL CHECK(quantity>0),document_quantity numeric(28,8) NOT NULL CHECK(document_quantity>0),
 confirmation_task_id uuid,confirmed_at timestamptz,confirmed_by uuid REFERENCES public.users(id),
 CHECK((confirmed_at IS NULL)=(confirmed_by IS NULL)),
 PRIMARY KEY(org_id,handling_unit_id,shipment_line_id),UNIQUE(org_id,shipment_line_id),
 FOREIGN KEY(org_id,handling_unit_id) REFERENCES public.handling_units(org_id,id),
 FOREIGN KEY(shipment_line_id) REFERENCES public.document_lines(id),FOREIGN KEY(pick_line_id) REFERENCES public.document_lines(id),
 FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),FOREIGN KEY(org_id,lot_id) REFERENCES public.lots(org_id,id),
 FOREIGN KEY(org_id,serial_id) REFERENCES public.serials(org_id,id),
 FOREIGN KEY(org_id,confirmation_task_id) REFERENCES public.warehouse_execution_tasks(org_id,id)
);
CREATE TABLE public.handling_unit_moves (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),handling_unit_id uuid NOT NULL,
 from_stock_location_id uuid NOT NULL,to_stock_location_id uuid NOT NULL,moved_on date NOT NULL,
 command_key text NOT NULL,request jsonb NOT NULL,movements jsonb NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL REFERENCES public.users(id),
 UNIQUE(org_id,id),UNIQUE(org_id,handling_unit_id,command_key),
 FOREIGN KEY(org_id,handling_unit_id) REFERENCES public.handling_units(org_id,id),
 FOREIGN KEY(org_id,from_stock_location_id) REFERENCES public.stock_locations(org_id,id),
 FOREIGN KEY(org_id,to_stock_location_id) REFERENCES public.stock_locations(org_id,id)
);
ALTER TABLE public.shipment_labels ADD COLUMN handling_unit_id uuid;
ALTER TABLE public.shipment_labels ADD COLUMN direction text CHECK(direction IN('outbound','return'));
ALTER TABLE public.shipment_labels ADD COLUMN handling_unit_version bigint;
ALTER TABLE public.shipment_labels ADD CONSTRAINT label_handling_unit_tenant FOREIGN KEY(org_id,handling_unit_id) REFERENCES public.handling_units(org_id,id);
CREATE UNIQUE INDEX shipment_labels_live_unit ON public.shipment_labels(org_id,handling_unit_id,direction) WHERE handling_unit_id IS NOT NULL AND status='purchased';
ALTER TABLE public.shipping_rate_quotes ADD COLUMN handling_unit_id uuid;
ALTER TABLE public.shipping_rate_quotes ADD COLUMN direction text CHECK(direction IN('outbound','return'));
ALTER TABLE public.shipping_rate_quotes ADD COLUMN handling_unit_version bigint;
ALTER TABLE public.shipping_rate_quotes ADD CONSTRAINT quote_handling_unit_tenant FOREIGN KEY(org_id,handling_unit_id) REFERENCES public.handling_units(org_id,id);

CREATE FUNCTION public.warehouse_execution_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Warehouse execution evidence is immutable; record a new warehouse operation';
END $$;
CREATE TRIGGER warehouse_scan_history BEFORE UPDATE OR DELETE ON public.warehouse_scan_events FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_history_guard();
CREATE TRIGGER pick_wave_history BEFORE UPDATE OR DELETE ON public.pick_waves FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_history_guard();
CREATE TRIGGER pick_wave_member_history BEFORE UPDATE OR DELETE ON public.pick_wave_members FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_history_guard();
CREATE TRIGGER handling_unit_move_history BEFORE UPDATE OR DELETE ON public.handling_unit_moves FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_history_guard();

CREATE FUNCTION public.warehouse_execution_task_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Warehouse suggestions and execution history cannot be deleted';
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','result','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','result','updated_at','updated_by']) OR OLD.status<>'open' THEN
  RAISE EXCEPTION 'Warehouse suggestion identity is immutable; create a fresh suggestion';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER warehouse_execution_task_guard BEFORE UPDATE OR DELETE ON public.warehouse_execution_tasks FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_task_guard();

CREATE FUNCTION public.pick_execution_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Pick confirmations and short quantities cannot be deleted';
 END IF;
 IF (to_jsonb(NEW)-'current_stock_location_id') IS DISTINCT FROM (to_jsonb(OLD)-'current_stock_location_id') THEN
  RAISE EXCEPTION 'Pick confirmation and short-pick release are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pick_execution_history_guard BEFORE UPDATE OR DELETE ON public.pick_execution_lines FOR EACH ROW EXECUTE FUNCTION public.pick_execution_history_guard();

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['warehouse_execution_tasks','warehouse_scan_events','pick_waves','pick_wave_members','pick_execution_lines','handling_units','handling_unit_contents','handling_unit_moves'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING(public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',relation);
 END LOOP;
END $$;

-- Only declared physical identities are rebased in copied handling-unit evidence.
CREATE FUNCTION public.warehouse_execution_clone_json(payload jsonb,seed uuid)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE field text; element jsonb; result jsonb;
BEGIN
 IF payload IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(payload)='array' THEN
  result='[]'::jsonb;
  FOR element IN SELECT value FROM jsonb_array_elements(payload) LOOP
   result=result||jsonb_build_array(public.warehouse_execution_clone_json(element,seed));
  END LOOP;
  RETURN result;
 END IF;
 IF jsonb_typeof(payload)<>'object' THEN RETURN payload; END IF;
 result=payload;
 FOREACH field IN ARRAY ARRAY['fromMovementId','toMovementId','entryId','toBinId','shipmentLineId'] LOOP
  IF payload->>field IS NOT NULL THEN result=jsonb_set(result,ARRAY[field],to_jsonb(public.ob_rebase((payload->>field)::uuid,seed)::text)); END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.warehouse_execution_clone_row_matches(relation text,candidate jsonb)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE target public.orgs%ROWTYPE; source jsonb; expected jsonb; field record; key_column text;
BEGIN
 IF relation NOT IN('pick_execution_lines','handling_units','handling_unit_contents','handling_unit_moves')
   OR NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
 SELECT * INTO target FROM public.orgs org WHERE org.id=(candidate->>'org_id')::uuid AND org.env_kind='sandbox'
   AND org.sandbox_seed IS NOT NULL AND EXISTS(SELECT 1 FROM public.sandboxes control
     WHERE control.org_id=org.id AND control.production_org_id=org.sandbox_of);
 IF NOT FOUND THEN RETURN false; END IF;
 key_column=CASE relation WHEN 'pick_execution_lines' THEN 'line_id' WHEN 'handling_unit_contents' THEN 'shipment_line_id' ELSE 'id' END;
 EXECUTE format('SELECT to_jsonb(source) FROM public.%I source WHERE source.org_id=$1 AND public.ob_rebase(source.%I,$2)=($3->>%L)::uuid',relation,key_column,key_column)
   INTO source USING target.sandbox_of,target.sandbox_seed,candidate;
 IF source IS NULL THEN RETURN false; END IF;
 expected=source;
 FOR field IN SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('public.'||relation)
    AND atttypid='uuid'::regtype AND attnum>0 AND NOT attisdropped LOOP
  expected=jsonb_set(expected,ARRAY[field.attname],CASE WHEN field.attname='org_id' THEN to_jsonb(target.id::text)
    WHEN field.attname='confirmation_task_id' THEN 'null'::jsonb
    ELSE coalesce(to_jsonb(public.ob_rebase((source->>field.attname)::uuid,target.sandbox_seed)::text),'null'::jsonb) END);
 END LOOP;
 IF relation='handling_unit_moves' THEN
  expected=jsonb_set(expected,'{request}',public.warehouse_execution_clone_json(source->'request',target.sandbox_seed));
  expected=jsonb_set(expected,'{movements}',public.warehouse_execution_clone_json(source->'movements',target.sandbox_seed));
 END IF;
 RETURN expected=candidate;
END $$;

CREATE FUNCTION public.warehouse_execution_subject_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE candidate jsonb; actor uuid; entity uuid; item uuid; lot uuid; serial uuid; line_org uuid; header record;
BEGIN
 candidate=to_jsonb(NEW);
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.warehouse_execution_clone_row_matches(TG_TABLE_NAME,candidate) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Warehouse copy must preserve its exact registered source evidence';
 END IF;
 FOREACH actor IN ARRAY ARRAY[(candidate->>'created_by')::uuid,(candidate->>'updated_by')::uuid,(candidate->>'confirmed_by')::uuid] LOOP
  IF actor IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users WHERE id=actor AND org_id=NEW.org_id) THEN
   RAISE EXCEPTION 'Warehouse operation actor must belong to its organization';
  END IF;
 END LOOP;
 entity=(candidate->>'subsidiary_id')::uuid;item=(candidate->>'item_id')::uuid;
 lot=(candidate->>'lot_id')::uuid;serial=(candidate->>'serial_id')::uuid;
 IF lot IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.lots WHERE org_id=NEW.org_id AND id=lot AND item_id=item) THEN
  RAISE EXCEPTION 'Suggested lot must belong to the suggested item and organization'; END IF;
 IF serial IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.serials WHERE org_id=NEW.org_id AND id=serial AND item_id=item AND lot_id IS NOT DISTINCT FROM lot) THEN
  RAISE EXCEPTION 'Suggested serial and lot must belong to the suggested item and organization'; END IF;
 IF TG_TABLE_NAME='warehouse_execution_tasks' THEN
  IF NEW.document_line_id IS NOT NULL THEN
   SELECT doc.org_id,doc.subsidiary_id,line.item_id INTO header FROM public.document_lines line
     JOIN public.documents doc ON doc.org_id=line.org_id AND doc.id=line.document_id WHERE line.id=NEW.document_line_id;
   IF NOT FOUND OR (header.org_id,header.subsidiary_id,header.item_id) IS DISTINCT FROM (NEW.org_id,entity,item) THEN
    RAISE EXCEPTION 'Warehouse suggestion must retain the source document item and legal entity'; END IF;
  END IF;
  IF NEW.count_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_count_lines line
   JOIN public.stock_counts count ON count.org_id=line.org_id AND count.id=line.stock_count_id
   WHERE line.org_id=NEW.org_id AND line.id=NEW.count_line_id AND count.subsidiary_id=entity AND line.item_id=item
     AND line.stock_location_id=NEW.to_stock_location_id AND line.lot_id IS NOT DISTINCT FROM lot AND line.serial_id IS NOT DISTINCT FROM serial) THEN
   RAISE EXCEPTION 'Count suggestion must retain its exact count line and identifiers'; END IF;
 ELSIF TG_TABLE_NAME='handling_units' THEN
  SELECT doc.org_id,doc.subsidiary_id,doc.kind,doc.status,fd.warehouse_id,fd.stage INTO header FROM public.documents doc
   JOIN public.fulfillment_documents fd ON fd.org_id=doc.org_id AND fd.document_id=doc.id WHERE doc.id=NEW.shipment_document_id;
  IF NOT FOUND OR header.org_id<>NEW.org_id OR header.subsidiary_id IS DISTINCT FROM entity OR header.kind<>'shipment'
    OR header.warehouse_id<>NEW.warehouse_id THEN RAISE EXCEPTION 'Handling unit must retain its shipment warehouse and legal entity'; END IF;
  IF TG_OP='INSERT' AND (header.status<>'draft' OR header.stage<>'open' OR NEW.status<>'open' OR NEW.content_version<>0
    OR NEW.current_stock_location_id<>NEW.initial_stock_location_id) THEN RAISE EXCEPTION 'Create an open handling unit on a draft shipment'; END IF;
  IF public.stock_location_warehouse(NEW.org_id,NEW.current_stock_location_id) IS DISTINCT FROM NEW.warehouse_id THEN
   RAISE EXCEPTION 'Handling unit must stay in its shipment warehouse'; END IF;
 ELSIF TG_TABLE_NAME='handling_unit_contents' THEN
  IF NOT EXISTS(SELECT 1 FROM public.handling_units unit JOIN public.document_lines line
    ON line.org_id=unit.org_id AND line.document_id=unit.shipment_document_id
    JOIN public.fulfillment_lines fl ON fl.org_id=line.org_id AND fl.line_id=line.id
    WHERE unit.org_id=NEW.org_id AND unit.id=NEW.handling_unit_id AND unit.status='open'
      AND line.id=NEW.shipment_line_id AND line.item_id=NEW.item_id AND line.quantity=NEW.document_quantity
      AND fl.pick_line_id=NEW.pick_line_id AND fl.lot_id IS NOT DISTINCT FROM NEW.lot_id AND fl.serial_id IS NOT DISTINCT FROM NEW.serial_id) THEN
   RAISE EXCEPTION 'Carton contents must match their assigned draft shipment lines'; END IF;
 ELSIF TG_TABLE_NAME='pick_wave_members' THEN
  IF NOT EXISTS(SELECT 1 FROM public.pick_waves wave JOIN public.documents pick
    ON pick.org_id=wave.org_id AND pick.subsidiary_id=wave.subsidiary_id
    JOIN public.fulfillment_documents fd ON fd.org_id=pick.org_id AND fd.document_id=pick.id
    WHERE wave.org_id=NEW.org_id AND wave.id=NEW.wave_id AND pick.id=NEW.pick_list_id AND pick.kind='pick_list'
      AND fd.warehouse_id=wave.warehouse_id AND pick.status=NEW.release_status) THEN
   RAISE EXCEPTION 'Wave membership must retain the released pick warehouse and legal entity'; END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['warehouse_execution_tasks','warehouse_scan_events','pick_waves','pick_wave_members','pick_execution_lines','handling_units','handling_unit_contents','handling_unit_moves'] LOOP
  EXECUTE format('CREATE TRIGGER warehouse_execution_subject BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_subject_guard()',relation);
 END LOOP;
END $$;

CREATE FUNCTION public.handling_unit_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Handling-unit history cannot be deleted'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','current_stock_location_id','content_version','updated_at','updated_by']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','current_stock_location_id','content_version','updated_at','updated_by']) THEN
  RAISE EXCEPTION 'Handling-unit shipment, warehouse and identity are immutable'; END IF;
 IF OLD.status IN('shipped','voided') OR NOT((OLD.status=NEW.status) OR (OLD.status='open' AND NEW.status='packed')
   OR (OLD.status='packed' AND NEW.status='shipped') OR (OLD.status IN('open','packed') AND NEW.status='voided')) THEN RAISE EXCEPTION 'Handling-unit lifecycle transition is not supported'; END IF;
 IF NEW.current_stock_location_id IS DISTINCT FROM OLD.current_stock_location_id AND (OLD.status<>'packed' OR NEW.status<>'packed') THEN
  RAISE EXCEPTION 'Only a packed handling unit can move as one identity'; END IF;
 IF NEW.content_version<OLD.content_version OR NEW.content_version>OLD.content_version+1 THEN
  RAISE EXCEPTION 'Handling-unit content version must advance one confirmed operation at a time'; END IF;
 IF EXISTS(SELECT 1 FROM public.shipment_labels label WHERE label.org_id=OLD.org_id AND label.handling_unit_id=OLD.id AND label.status='purchased')
   AND (NEW.content_version,NEW.current_stock_location_id) IS DISTINCT FROM (OLD.content_version,OLD.current_stock_location_id) THEN
  RAISE EXCEPTION 'Void the handling-unit label before changing its physical contents or position'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER handling_unit_lifecycle BEFORE UPDATE OR DELETE ON public.handling_units FOR EACH ROW EXECUTE FUNCTION public.handling_unit_lifecycle_guard();
CREATE FUNCTION public.handling_unit_content_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Assigned carton contents cannot be deleted'; END IF;
 IF OLD.confirmed_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['confirmed_at','confirmed_by','confirmation_task_id']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['confirmed_at','confirmed_by','confirmation_task_id']) OR NEW.confirmed_at IS NULL THEN
  RAISE EXCEPTION 'Carton content identity and confirmed history are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER handling_unit_content_history BEFORE UPDATE OR DELETE ON public.handling_unit_contents FOR EACH ROW EXECUTE FUNCTION public.handling_unit_content_history_guard();

CREATE FUNCTION public.warehouse_execution_confirmation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE task public.warehouse_execution_tasks%ROWTYPE; subject uuid;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() AND public.warehouse_execution_clone_row_matches(TG_TABLE_NAME,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='handling_unit_contents' AND to_jsonb(NEW)->>'confirmed_at' IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO task FROM public.warehouse_execution_tasks WHERE org_id=NEW.org_id AND id=NEW.confirmation_task_id;
 subject=(to_jsonb(NEW)->>CASE TG_TABLE_NAME WHEN 'pick_execution_lines' THEN 'line_id' ELSE 'shipment_line_id' END)::uuid;
 IF NOT FOUND OR task.status<>'done' OR task.document_line_id<>subject
    OR task.stage<>(CASE TG_TABLE_NAME WHEN 'pick_execution_lines' THEN 'pick' ELSE 'pack' END)
    OR NOT EXISTS(SELECT 1 FROM public.warehouse_scan_events event WHERE event.org_id=task.org_id AND event.task_id=task.id
      AND event.outcome='confirmed' AND event.xmin=(txid_current()%4294967296)::text::xid) THEN
  RAISE EXCEPTION 'Physical confirmation requires its exact current native execution evidence'; END IF;
 IF TG_TABLE_NAME='pick_execution_lines' THEN
  IF NOT EXISTS(SELECT 1 FROM public.document_lines line JOIN public.documents pick ON pick.org_id=line.org_id AND pick.id=line.document_id
    WHERE line.org_id=NEW.org_id AND line.id=NEW.line_id AND line.document_id=NEW.document_id AND pick.kind='pick_list'
      AND pick.status='approved' AND line.quantity=NEW.requested_quantity AND task.document_quantity=NEW.picked_quantity
      AND task.item_id=line.item_id AND task.subsidiary_id=pick.subsidiary_id AND task.from_stock_location_id=line.stock_location_id) THEN
   RAISE EXCEPTION 'Pick confirmation must preserve its released pick line and quantity'; END IF;
 ELSIF task.item_id<>NEW.item_id OR task.lot_id IS DISTINCT FROM NEW.lot_id OR task.serial_id IS DISTINCT FROM NEW.serial_id
    OR task.quantity<>NEW.quantity OR task.document_quantity<>NEW.document_quantity OR (task.basis->>'unitId')::uuid<>NEW.handling_unit_id THEN
  RAISE EXCEPTION 'Pack confirmation must match its exact assigned carton contents';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER pick_execution_confirmation AFTER INSERT ON public.pick_execution_lines DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_confirmation_guard();
CREATE CONSTRAINT TRIGGER handling_unit_confirmation AFTER INSERT OR UPDATE ON public.handling_unit_contents DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.warehouse_execution_confirmation_guard();

CREATE FUNCTION public.warehouse_execution_transfer_matches(subject_org uuid,subject_unit uuid,source_bin uuid,target_bin uuid,evidence jsonb)
 RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_typeof(evidence)='array' AND EXISTS(SELECT 1 FROM public.handling_unit_contents WHERE org_id=subject_org AND handling_unit_id=subject_unit)
  AND (SELECT count(*)=count(DISTINCT proof->>'shipmentLineId')
      AND count(*)=count(DISTINCT proof->>'fromMovementId') AND count(*)=count(DISTINCT proof->>'toMovementId')
      AND count(*)=(SELECT count(*) FROM public.handling_unit_contents WHERE org_id=subject_org AND handling_unit_id=subject_unit)
    FROM jsonb_array_elements(evidence) proof)
  AND NOT EXISTS(SELECT 1 FROM public.handling_unit_contents content
   JOIN public.handling_units unit ON unit.org_id=content.org_id AND unit.id=content.handling_unit_id
   WHERE content.org_id=subject_org AND content.handling_unit_id=subject_unit AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(evidence) proof
     JOIN public.inventory_movements outbound ON outbound.org_id=subject_org AND outbound.id=(proof->>'fromMovementId')::uuid
     JOIN public.inventory_movements inbound ON inbound.org_id=subject_org AND inbound.id=(proof->>'toMovementId')::uuid
     WHERE (proof->>'shipmentLineId')::uuid=content.shipment_line_id
       AND outbound.kind='transfer_out' AND inbound.kind='transfer_in' AND outbound.status='posted' AND inbound.status='posted'
       AND inbound.paired_movement_id=outbound.id AND outbound.stock_location_id=source_bin AND inbound.stock_location_id=target_bin
       AND outbound.item_id=content.item_id AND inbound.item_id=content.item_id
       AND outbound.subsidiary_id=unit.subsidiary_id AND inbound.subsidiary_id=unit.subsidiary_id
       AND outbound.lot_id IS NOT DISTINCT FROM content.lot_id AND inbound.lot_id IS NOT DISTINCT FROM content.lot_id
       AND outbound.serial_id IS NOT DISTINCT FROM content.serial_id AND inbound.serial_id IS NOT DISTINCT FROM content.serial_id
       AND outbound.quantity=-content.quantity AND inbound.quantity=content.quantity
       AND inbound.xmin=(txid_current()%4294967296)::text::xid AND outbound.xmin=(txid_current()%4294967296)::text::xid
   ));
$$;
CREATE FUNCTION public.handling_unit_posted_state_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE current_unit public.handling_units%ROWTYPE;
BEGIN
 SELECT * INTO current_unit FROM public.handling_units WHERE org_id=NEW.org_id AND id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF current_unit.status IN('packed','shipped') AND (NOT EXISTS(SELECT 1 FROM public.handling_unit_contents WHERE org_id=NEW.org_id AND handling_unit_id=NEW.id)
   OR EXISTS(SELECT 1 FROM public.handling_unit_contents content
     LEFT JOIN public.document_lines line ON line.org_id=content.org_id AND line.id=content.shipment_line_id
     LEFT JOIN public.fulfillment_lines fl ON fl.org_id=content.org_id AND fl.line_id=content.shipment_line_id
     WHERE content.org_id=NEW.org_id AND content.handling_unit_id=NEW.id AND (content.confirmed_at IS NULL OR line.id IS NULL OR fl.line_id IS NULL
       OR line.document_id IS DISTINCT FROM NEW.shipment_document_id OR line.item_id IS DISTINCT FROM content.item_id OR line.quantity IS DISTINCT FROM content.document_quantity
       OR line.stock_location_id IS DISTINCT FROM current_unit.current_stock_location_id OR fl.pick_line_id IS DISTINCT FROM content.pick_line_id
       OR fl.carton IS DISTINCT FROM NEW.code OR fl.lot_id IS DISTINCT FROM content.lot_id OR fl.serial_id IS DISTINCT FROM content.serial_id))) THEN
  RAISE EXCEPTION 'Packed handling unit must retain its exact confirmed shipment contents'; END IF;
 IF current_unit.status='shipped' AND NOT EXISTS(SELECT 1 FROM public.documents doc JOIN public.fulfillment_documents fd
    ON fd.org_id=doc.org_id AND fd.document_id=doc.id WHERE doc.org_id=NEW.org_id AND doc.id=NEW.shipment_document_id
    AND doc.kind='shipment' AND doc.status='approved' AND fd.stage='done') THEN
  RAISE EXCEPTION 'A handling unit ships only with its posted shipment'; END IF;
 IF TG_OP='UPDATE' AND NEW.current_stock_location_id IS DISTINCT FROM OLD.current_stock_location_id THEN
  IF NEW.content_version<>OLD.content_version+1 OR NOT EXISTS(SELECT 1 FROM public.handling_unit_moves move
    WHERE move.org_id=NEW.org_id AND move.handling_unit_id=NEW.id AND move.from_stock_location_id=OLD.current_stock_location_id
      AND move.to_stock_location_id=NEW.current_stock_location_id AND move.xmin=(txid_current()%4294967296)::text::xid
      AND public.warehouse_execution_transfer_matches(NEW.org_id,NEW.id,OLD.current_stock_location_id,NEW.current_stock_location_id,move.movements)) THEN
   RAISE EXCEPTION 'Handling-unit position requires its exact current native transfers and movement history'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER handling_unit_posted_state AFTER INSERT OR UPDATE ON public.handling_units DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.handling_unit_posted_state_guard();

CREATE FUNCTION public.pick_execution_position_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.current_stock_location_id=OLD.current_stock_location_id THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.handling_unit_contents content JOIN public.handling_units unit
   ON unit.org_id=content.org_id AND unit.id=content.handling_unit_id
   JOIN public.warehouse_execution_tasks task ON task.org_id=content.org_id AND task.id=content.confirmation_task_id
   JOIN public.inventory_movements outbound ON outbound.org_id=task.org_id AND outbound.id=(task.result->'movement'->>'fromMovementId')::uuid
   JOIN public.inventory_movements inbound ON inbound.org_id=task.org_id AND inbound.id=(task.result->'movement'->>'toMovementId')::uuid
   WHERE content.org_id=NEW.org_id AND content.pick_line_id=NEW.line_id AND content.confirmed_at IS NOT NULL
     AND task.stage='pack' AND task.status='done' AND task.from_stock_location_id=OLD.current_stock_location_id
     AND task.to_stock_location_id=NEW.current_stock_location_id AND content.document_quantity=NEW.picked_quantity
     AND task.xmin=(txid_current()%4294967296)::text::xid AND outbound.kind='transfer_out' AND inbound.kind='transfer_in'
     AND outbound.status='posted' AND inbound.status='posted' AND inbound.paired_movement_id=outbound.id
     AND outbound.item_id=content.item_id AND inbound.item_id=content.item_id
     AND outbound.quantity=-content.quantity AND inbound.quantity=content.quantity
     AND outbound.stock_location_id=OLD.current_stock_location_id AND inbound.stock_location_id=NEW.current_stock_location_id
     AND outbound.subsidiary_id=unit.subsidiary_id AND inbound.subsidiary_id=unit.subsidiary_id
     AND outbound.lot_id IS NOT DISTINCT FROM content.lot_id AND inbound.lot_id IS NOT DISTINCT FROM content.lot_id
     AND outbound.serial_id IS NOT DISTINCT FROM content.serial_id AND inbound.serial_id IS NOT DISTINCT FROM content.serial_id
 ) OR EXISTS(SELECT 1 FROM public.handling_unit_contents content JOIN public.handling_unit_moves move
   ON move.org_id=content.org_id AND move.handling_unit_id=content.handling_unit_id
   WHERE content.org_id=NEW.org_id AND content.pick_line_id=NEW.line_id AND content.document_quantity=NEW.picked_quantity
     AND move.from_stock_location_id=OLD.current_stock_location_id AND move.to_stock_location_id=NEW.current_stock_location_id
     AND move.xmin=(txid_current()%4294967296)::text::xid
     AND public.warehouse_execution_transfer_matches(NEW.org_id,move.handling_unit_id,OLD.current_stock_location_id,NEW.current_stock_location_id,move.movements)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Pick reservation can move only with its confirmed carton and native transfer evidence';
END $$;
CREATE CONSTRAINT TRIGGER pick_execution_position AFTER UPDATE ON public.pick_execution_lines DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.pick_execution_position_guard();
