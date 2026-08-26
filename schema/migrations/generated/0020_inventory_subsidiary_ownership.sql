-- OpenBooks forward migration 0020_inventory_subsidiary_ownership.
--
-- The inventory subledger keyed stock on org + item + location only, so it
-- had no notion of legal-entity ownership: a user scoped to subsidiary A
-- could consume cost layers owned by subsidiary B — even at B's restricted
-- warehouse — and book the inventory credit to A. The general ledger always
-- balanced per subsidiary (the kernel's jl_balanced_by_subsidiary trigger),
-- which made the mismatch worse, not better: one entity's assets silently
-- vanished into another's books while both ledgers looked internally sound.
--
-- Ownership now lives in the storage layer and is enforced there:
--
--   1. `subsidiary_id` on inventory_movements, cost_layers, and
--      cost_layer_consumptions (NOT NULL). Existing rows are backfilled from
--      their journal entry's subsidiary — every valued movement already
--      posted under exactly one legal entity — with the org root as the
--      fallback for JE-less rows (pending stubs, unvalued history).
--   2. Composite foreign keys make cross-entity facts unrepresentable:
--      a layer must be owned by its source movement's entity, and a
--      consumption must carry the same entity as BOTH its layer and its
--      issue movement. A movement may only link a journal entry that posts
--      under the same entity.
--   3. BEFORE-INSERT owner-fill triggers derive an omitted subsidiary from
--      the row's journal entry / source movement so writers outside the
--      posting engine (NRV layer splits, evidence fixtures) cannot produce
--      ownerless rows by accident; undeterminable ownership is refused.
--
-- If this migration fails on constraint creation, the database holds legacy
-- cross-entity consumptions or layers whose source movement disagrees with
-- their recorded owner. Repair that evidence before upgrading: those rows are
-- precisely the defect this migration makes impossible.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS subsidiary_id uuid;
ALTER TABLE public.cost_layers
  ADD COLUMN IF NOT EXISTS subsidiary_id uuid;
ALTER TABLE public.cost_layer_consumptions
  ADD COLUMN IF NOT EXISTS subsidiary_id uuid;

-- Backfill movements from their posting entity, then fall back to the org
-- root for rows without a journal entry (pending stubs, unvalued filler).
-- Posted movements are append-only by trigger (inv_move_guard); this
-- migration is the one sanctioned writer, so the guard is disabled for the
-- backfill's duration and re-enabled inside the same transaction.
ALTER TABLE public.inventory_movements DISABLE TRIGGER inv_move_guard;

UPDATE public.inventory_movements m
   SET subsidiary_id = je.subsidiary_id
  FROM public.journal_entries je
 WHERE je.id = m.journal_entry_id
   AND je.org_id = m.org_id
   AND m.subsidiary_id IS NULL;

UPDATE public.inventory_movements m
   SET subsidiary_id = (
         SELECT s.id
           FROM public.subsidiaries s
          WHERE s.org_id = m.org_id
            AND s.parent_id IS NULL
          ORDER BY s.created_at
          LIMIT 1)
 WHERE m.subsidiary_id IS NULL;

ALTER TABLE public.inventory_movements ENABLE TRIGGER inv_move_guard;

-- Layers and consumptions inherit the entity of their provenance movement.
UPDATE public.cost_layers l
   SET subsidiary_id = m.subsidiary_id
  FROM public.inventory_movements m
 WHERE m.id = l.source_movement_id
   AND m.org_id = l.org_id
   AND l.subsidiary_id IS NULL;

UPDATE public.cost_layer_consumptions c
   SET subsidiary_id = m.subsidiary_id
  FROM public.inventory_movements m
 WHERE m.id = c.issue_movement_id
   AND m.org_id = c.org_id
   AND c.subsidiary_id IS NULL;

ALTER TABLE public.inventory_movements
  ALTER COLUMN subsidiary_id SET NOT NULL;
ALTER TABLE public.cost_layers
  ALTER COLUMN subsidiary_id SET NOT NULL;
ALTER TABLE public.cost_layer_consumptions
  ALTER COLUMN subsidiary_id SET NOT NULL;

-- Unique keys that let composite foreign keys pin each child to a parent row
-- carrying the SAME legal entity.
CREATE UNIQUE INDEX IF NOT EXISTS inv_moves_org_sub_id
  ON public.inventory_movements USING btree (org_id, subsidiary_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS cost_layers_org_sub_id
  ON public.cost_layers USING btree (org_id, subsidiary_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_sub_id
  ON public.journal_entries USING btree (org_id, subsidiary_id, id);

-- A movement exists only under a real subsidiary of its own org...
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inv_moves_org_subsidiary_fk
  FOREIGN KEY (org_id, subsidiary_id)
  REFERENCES public.subsidiaries (org_id, id);

-- ...and can only cite a journal entry that posts under that same entity,
-- so the subledger and the per-subsidiary GL can never disagree again.
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inv_moves_entry_same_entity_fk
  FOREIGN KEY (org_id, subsidiary_id, journal_entry_id)
  REFERENCES public.journal_entries (org_id, subsidiary_id, id);

-- A layer is owned by the entity of the receipt movement that created it.
ALTER TABLE public.cost_layers
  ADD CONSTRAINT cost_layers_source_movement_entity_fk
  FOREIGN KEY (org_id, subsidiary_id, source_movement_id)
  REFERENCES public.inventory_movements (org_id, subsidiary_id, id);

-- A consumption carries ONE entity for both of its parents: an issue can
-- never draw down another legal entity's stock.
ALTER TABLE public.cost_layer_consumptions
  ADD CONSTRAINT layer_consumptions_layer_entity_fk
  FOREIGN KEY (org_id, subsidiary_id, cost_layer_id)
  REFERENCES public.cost_layers (org_id, subsidiary_id, id);

ALTER TABLE public.cost_layer_consumptions
  ADD CONSTRAINT layer_consumptions_issue_entity_fk
  FOREIGN KEY (org_id, subsidiary_id, issue_movement_id)
  REFERENCES public.inventory_movements (org_id, subsidiary_id, id);

-- Owner-fill: writers outside the posting engine omit ownership; storage
-- derives it from the row's own provenance instead of accepting ownerless
-- financial facts.

CREATE OR REPLACE FUNCTION public.inv_move_fill_subsidiary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.subsidiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT je.subsidiary_id INTO owner
    FROM public.journal_entries je
   WHERE je.id = NEW.journal_entry_id
     AND je.org_id = NEW.org_id;
  IF owner IS NULL THEN
    SELECT s.id INTO owner
      FROM public.subsidiaries s
     WHERE s.org_id = NEW.org_id
       AND s.parent_id IS NULL
     ORDER BY s.created_at
     LIMIT 1;
  END IF;
  IF owner IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'inventory movement requires a legal-entity owner',
      DETAIL = 'No subsidiary could be derived from the movement''s journal entry or organization root.',
      HINT = 'Supply subsidiary_id explicitly or configure a root subsidiary first.';
  END IF;
  NEW.subsidiary_id := owner;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inventory_movement_owner_fill ON public.inventory_movements;
CREATE TRIGGER inventory_movement_owner_fill
  BEFORE INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.inv_move_fill_subsidiary();

CREATE OR REPLACE FUNCTION public.cost_layer_fill_subsidiary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.subsidiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.subsidiary_id INTO owner
    FROM public.inventory_movements m
   WHERE m.id = NEW.source_movement_id
     AND m.org_id = NEW.org_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'cost layer requires the legal entity of its source receipt movement',
      DETAIL = 'The source movement was not found, so ownership could not be derived.',
      HINT = 'Create the source movement before its cost layer.';
  END IF;
  NEW.subsidiary_id := owner;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cost_layer_owner_fill ON public.cost_layers;
CREATE TRIGGER cost_layer_owner_fill
  BEFORE INSERT ON public.cost_layers
  FOR EACH ROW EXECUTE FUNCTION public.cost_layer_fill_subsidiary();

CREATE OR REPLACE FUNCTION public.layer_consumption_fill_subsidiary()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owner uuid;
BEGIN
  IF NEW.subsidiary_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.subsidiary_id INTO owner
    FROM public.inventory_movements m
   WHERE m.id = NEW.issue_movement_id
     AND m.org_id = NEW.org_id;
  IF owner IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'cost layer consumption requires the legal entity of its issue movement',
      DETAIL = 'The issue movement was not found, so ownership could not be derived.',
      HINT = 'Create the issue movement before recording its consumptions.';
  END IF;
  NEW.subsidiary_id := owner;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS layer_consumption_owner_fill ON public.cost_layer_consumptions;
CREATE TRIGGER layer_consumption_owner_fill
  BEFORE INSERT ON public.cost_layer_consumptions
  FOR EACH ROW EXECUTE FUNCTION public.layer_consumption_fill_subsidiary();
