-- OpenBooks forward migration 0257_provisional_cost_subsidiary.
--
-- The negative-stock deficit table keyed its rows on org + item + location
-- only, so a receipt could settle ANOTHER subsidiary's deficit: Sub A issues
-- 5 short at $10, Sub B receives 5 at $12, and B's receipt consumed A's
-- deficit — B got no cost layer while booking DR Inventory 50 + DR COGS 10
-- for stock it holds, and A's inventory GL stayed -50 with no layers behind
-- it. The on-hand reader (position.ts) already scopes provisional stock
-- through the issuing movement's legal entity, so the settlement writer was
-- the one leg that disagreed.
--
-- Ownership now lives on the row, in the 0020 shape:
--
--   1. `subsidiary_id` on inventory_provisional_costs (NOT NULL), backfilled
--      from the issuing movement — every deficit is born by exactly one
--      issue movement, which has carried its legal entity since 0020, so no
--      fallback guess is needed. A deficit whose issue movement is missing
--      refuses the upgrade: that row has no truthful owner.
--   2. Composite foreign keys make cross-entity facts unrepresentable: a
--      deficit belongs to its org's subsidiary, and to the same entity as
--      the issue movement that created it.
--   3. A BEFORE-INSERT owner-fill trigger derives an omitted subsidiary from
--      the row's own issue movement so writers cannot produce ownerless
--      deficits by accident; undeterminable ownership is refused.
--   4. A subsidiary-scoped lookup index serves the settlement query, which
--      now filters org + item + location + subsidiary.
--
-- The governed read surface is untouched: per 0191/0200 precedent, the
-- openbooks_query projection gains columns only through its own view
-- migrations, and the harness tie-out already attributes provisional value
-- through the issuing movement, which this migration makes explicit.
--
-- Staged build (U-staging): inventory_provisional_costs is a hot
-- transactional table, so this file declares `-- openbooks: no-transaction`
-- and the runner executes it statement by statement with a bounded session
-- lock_timeout. The contract that makes a mid-file failure retry-safe:
-- every statement is idempotent (IF NOT EXISTS throughout, guarded adds,
-- anti-joined fills), and the DO block below drops this file's own INVALID
-- indexes — a failed CONCURRENTLY build leaves one behind, and IF NOT
-- EXISTS below would then skip the name forever, silently keeping the
-- missing index. Both lookup indexes build CONCURRENTLY and both foreign
-- keys arrive NOT VALID with separate guarded VALIDATE steps, so no step
-- takes a write-blocking lock over the whole table.
--
-- This file carries no lock_timeout of its own (refused for ordinals above
-- 0251 by check-migration-headers); the runner's bound governs.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Retry safety: drop our own INVALID indexes before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT
-- EXISTS below would then skip it forever. Plain (non-concurrent) DROP
-- inside the DO block is safe: an INVALID index answers no query, so its
-- brief exclusive lock contends with nothing.
DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
       AND c.relname IN (
         'inv_provisional_org_sub_id',
         'inventory_provisional_subsidiary_fifo'
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

ALTER TABLE public.inventory_provisional_costs
  ADD COLUMN IF NOT EXISTS subsidiary_id uuid;

-- Every deficit is born by exactly one issue movement, and that movement has
-- carried its legal entity since 0020. Backfill from it; there is no fallback
-- subsidiary to guess.
UPDATE public.inventory_provisional_costs pc
   SET subsidiary_id = m.subsidiary_id
  FROM public.inventory_movements m
 WHERE m.id = pc.issue_movement_id
   AND m.org_id = pc.org_id
   AND pc.subsidiary_id IS NULL;

-- A deficit with no issuing movement has no truthful owner. Refuse the
-- upgrade with the row count rather than inventing a subsidiary: attributing
-- another entity's shortfall to the wrong books is a silent wrong answer.
DO $preflight$
DECLARE
  ownerless bigint;
BEGIN
  SELECT count(*) INTO ownerless
    FROM public.inventory_provisional_costs
   WHERE subsidiary_id IS NULL;
  IF ownerless > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0257 refused: public.inventory_provisional_costs holds ' || ownerless ||
        ' row(s) with no issuing movement to derive a legal entity from',
      DETAIL = 'Attribute each row to its owning subsidiary (or confirm the rows are stray and remove them) before this constraint can be installed.',
      HINT = 'Select id, org_id, item_id, stock_location_id, issue_movement_id from public.inventory_provisional_costs where subsidiary_id is null.';
  END IF;
END;
$preflight$;

ALTER TABLE public.inventory_provisional_costs
  ALTER COLUMN subsidiary_id SET NOT NULL;

-- Unique key letting the composite foreign key below pin each deficit to an
-- issue movement carrying the SAME legal entity.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inv_provisional_org_sub_id
  ON public.inventory_provisional_costs USING btree (org_id, subsidiary_id, id);

-- The settlement query filters org + item + location + subsidiary under a
-- position lock; index that shape directly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_provisional_subsidiary_fifo
  ON public.inventory_provisional_costs USING btree (org_id, item_id, stock_location_id, subsidiary_id);

-- A deficit exists only under a real subsidiary of its own org...
-- (guarded: the runner retries on lock timeouts, so every constraint add
-- below must be re-runnable).
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_provisional_org_subsidiary_fk') THEN
  ALTER TABLE public.inventory_provisional_costs
    ADD CONSTRAINT inv_provisional_org_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries (org_id, id) NOT VALID; END IF; END $$;
DO $$ BEGIN IF EXISTS (
  SELECT 1 FROM pg_constraint
   WHERE conrelid = 'public.inventory_provisional_costs'::regclass
     AND conname = 'inv_provisional_org_subsidiary_fk'
     AND NOT convalidated
) THEN
  ALTER TABLE public.inventory_provisional_costs
    VALIDATE CONSTRAINT inv_provisional_org_subsidiary_fk; END IF; END $$;

-- ...and belongs to the same entity as the issue movement that created it,
-- so one subsidiary's receipt can never settle another's shortfall again.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_provisional_issue_movement_entity_fk') THEN
  ALTER TABLE public.inventory_provisional_costs
    ADD CONSTRAINT inv_provisional_issue_movement_entity_fk
    FOREIGN KEY (org_id, subsidiary_id, issue_movement_id)
    REFERENCES public.inventory_movements (org_id, subsidiary_id, id) NOT VALID; END IF; END $$;
DO $$ BEGIN IF EXISTS (
  SELECT 1 FROM pg_constraint
   WHERE conrelid = 'public.inventory_provisional_costs'::regclass
     AND conname = 'inv_provisional_issue_movement_entity_fk'
     AND NOT convalidated
) THEN
  ALTER TABLE public.inventory_provisional_costs
    VALIDATE CONSTRAINT inv_provisional_issue_movement_entity_fk; END IF; END $$;

-- Owner-fill: writers omit ownership at their peril; storage derives it from
-- the row's own issue movement instead of accepting ownerless deficits.
CREATE OR REPLACE FUNCTION public.inv_provisional_fill_subsidiary()
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
      MESSAGE = 'inventory provisional cost requires the legal entity of its issue movement',
      DETAIL = 'The issue movement was not found, so ownership could not be derived.',
      HINT = 'Create the issue movement before recording its provisional cost.';
  END IF;
  NEW.subsidiary_id := owner;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inv_provisional_owner_fill ON public.inventory_provisional_costs;
CREATE TRIGGER inv_provisional_owner_fill
  BEFORE INSERT ON public.inventory_provisional_costs
  FOR EACH ROW EXECUTE FUNCTION public.inv_provisional_fill_subsidiary();
