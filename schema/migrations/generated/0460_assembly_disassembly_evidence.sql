-- OpenBooks forward migration 0460_assembly_disassembly_evidence.
-- Record physical disassemblies independently of their journals: zero-value
-- inventory still requires immutable quantity and recovery provenance.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.assembly_disassemblies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  subsidiary_id uuid NOT NULL,
  book_id uuid NOT NULL,
  build_movement_id uuid NOT NULL REFERENCES public.inventory_movements(id) DEFERRABLE INITIALLY DEFERRED,
  quantity numeric(19,4) NOT NULL CHECK(quantity>0),
  withdrawn_value numeric(19,4) NOT NULL CHECK(withdrawn_value>=0),
  moved_on date NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
  components jsonb NOT NULL CHECK(jsonb_typeof(components)='array' AND jsonb_array_length(components)>0),
  journal_entry_id uuid REFERENCES public.journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES public.users(id),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
  FOREIGN KEY(org_id,book_id) REFERENCES public.accounting_books(org_id,id)
);
CREATE INDEX assembly_disassemblies_source ON public.assembly_disassemblies(org_id,build_movement_id,moved_on,id);
ALTER TABLE public.assembly_disassemblies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assembly_disassemblies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.assembly_disassemblies
  USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));

ALTER TABLE public.inventory_movements ADD COLUMN assembly_disassembly_id uuid;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_disassembly_owner_fk
  FOREIGN KEY(org_id,assembly_disassembly_id) REFERENCES public.assembly_disassemblies(org_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_disassembly_identity
  CHECK((kind IN ('assembly_disassembly','assembly_recovery') AND assembly_disassembly_id IS NOT NULL)
    OR (kind='return' AND reverses_movement_id IS NOT NULL)
    OR (kind NOT IN ('assembly_disassembly','assembly_recovery') AND assembly_disassembly_id IS NULL));
CREATE UNIQUE INDEX inventory_disassembly_one_component ON public.inventory_movements(assembly_disassembly_id,item_id,kind)
  WHERE kind IN ('assembly_disassembly','assembly_recovery');

CREATE FUNCTION public.assembly_disassembly_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'physical disassembly evidence is immutable; use its controlled inventory movement reversal';
END $$;
CREATE TRIGGER assembly_disassembly_immutable BEFORE UPDATE OR DELETE ON public.assembly_disassemblies
  FOR EACH ROW EXECUTE FUNCTION public.assembly_disassembly_immutable();

CREATE FUNCTION public.assembly_disassembly_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  operation_id uuid;
  operation public.assembly_disassemblies%ROWTYPE;
  source public.inventory_movements%ROWTYPE;
  component jsonb;
  actual_count integer;
BEGIN
  IF TG_TABLE_NAME='assembly_disassemblies' THEN operation_id:=NEW.id;
  ELSE operation_id:=NEW.assembly_disassembly_id; END IF;
  IF operation_id IS NULL THEN
    IF TG_TABLE_NAME='inventory_movements' THEN
    IF NEW.reverses_movement_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.inventory_movements m WHERE m.id=NEW.reverses_movement_id AND m.org_id=NEW.org_id AND m.assembly_disassembly_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a disassembly reversal must retain its operation identity';
    END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT operation FROM public.assembly_disassemblies WHERE id=operation_id AND org_id=NEW.org_id;
  SELECT * INTO STRICT source FROM public.inventory_movements WHERE id=operation.build_movement_id AND org_id=operation.org_id;
  IF source.kind<>'assembly_build' OR source.status<>'posted' OR source.subsidiary_id<>operation.subsidiary_id
     OR operation.moved_on<source.moved_at::date OR NOT EXISTS(
       SELECT 1 FROM public.journal_entries e WHERE e.id=source.journal_entry_id AND e.org_id=operation.org_id
         AND e.book_id=operation.book_id AND e.origin='inventory' AND e.custom ? 'assemblyBuild') THEN
    RAISE EXCEPTION 'disassembly must bind to its original build, organization, legal entity and accounting book';
  END IF;
  IF operation.journal_entry_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.id=operation.journal_entry_id AND e.org_id=operation.org_id
      AND e.book_id=operation.book_id AND e.subsidiary_id=operation.subsidiary_id AND e.origin='inventory' AND e.status IN ('posted','reversed')
      AND e.custom->'assemblyDisassembly'->>'operationId'=operation.id::text
      AND e.custom->'assemblyDisassembly'->'components'=operation.components) THEN
      RAISE EXCEPTION 'disassembly journal must retain the same operation and recovery evidence';
    END IF;
  ELSIF operation.withdrawn_value<>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(operation.components) c WHERE (c->>'value')::numeric<>0) THEN
    RAISE EXCEPTION 'a value-carrying disassembly requires a posted journal';
  END IF;
  SELECT count(*) INTO actual_count FROM public.inventory_movements m WHERE m.org_id=operation.org_id
    AND m.assembly_disassembly_id=operation.id AND m.kind IN ('assembly_disassembly','assembly_recovery');
  IF actual_count<>1+jsonb_array_length(operation.components) OR NOT EXISTS(
    SELECT 1 FROM public.inventory_movements m WHERE m.org_id=operation.org_id AND m.assembly_disassembly_id=operation.id
      AND m.kind='assembly_disassembly' AND m.item_id=source.item_id AND m.subsidiary_id=source.subsidiary_id
      AND m.stock_location_id=source.stock_location_id AND m.quantity=-operation.quantity AND m.total_value=-operation.withdrawn_value
      AND m.journal_entry_id IS NOT DISTINCT FROM operation.journal_entry_id AND m.status='posted') THEN
    RAISE EXCEPTION 'disassembly must record one complete quantity and value operation';
  END IF;
  FOR component IN SELECT value FROM jsonb_array_elements(operation.components) LOOP
    IF NOT component ?& ARRAY['itemId','quantity','value','originalCost']
      OR component->>'itemId' IS NULL OR component->>'quantity' IS NULL OR component->>'value' IS NULL OR component->>'originalCost' IS NULL
      OR (component->>'quantity')::numeric<=0 OR (component->>'value')::numeric<0 OR (component->>'originalCost')::numeric<0
      OR NOT EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.org_id=operation.org_id AND m.assembly_disassembly_id=operation.id
        AND m.kind='assembly_recovery' AND m.item_id=(component->>'itemId')::uuid AND m.subsidiary_id=source.subsidiary_id
        AND m.stock_location_id=source.stock_location_id AND m.quantity=(component->>'quantity')::numeric AND m.total_value=(component->>'value')::numeric
        AND m.journal_entry_id IS NOT DISTINCT FROM operation.journal_entry_id AND m.status='posted') THEN
      RAISE EXCEPTION 'each recovered component must match its recorded quantity, cost and legal entity';
    END IF;
  END LOOP;
  IF TG_TABLE_NAME='inventory_movements' THEN
  IF NEW.kind='return' AND NOT EXISTS(
    SELECT 1 FROM public.inventory_movements m WHERE m.id=NEW.reverses_movement_id AND m.org_id=NEW.org_id
      AND m.assembly_disassembly_id=operation.id AND m.item_id=NEW.item_id AND m.subsidiary_id=NEW.subsidiary_id
      AND m.stock_location_id=NEW.stock_location_id AND NEW.quantity=-m.quantity AND NEW.total_value=-m.total_value) THEN
    RAISE EXCEPTION 'a disassembly reversal must mirror its original movement';
  END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER assembly_disassembly_binding AFTER INSERT ON public.assembly_disassemblies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assembly_disassembly_binding();
CREATE CONSTRAINT TRIGGER inventory_disassembly_binding AFTER INSERT ON public.inventory_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assembly_disassembly_binding();
SELECT public.openbooks_refresh_query_catalog();
