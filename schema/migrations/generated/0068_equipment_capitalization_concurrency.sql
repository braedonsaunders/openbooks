-- OpenBooks forward migration 0068_equipment_capitalization_concurrency.
--
-- Equipment capitalization used to read the source link and next fixed-asset
-- number before opening its write transaction.  Two requests could therefore
-- both mint an asset and race to overwrite equipment_units.fixed_asset_id;
-- without storage invariants one of those assets became an orphan and the
-- fixed-asset register was overstated.
--
-- This migration closes both races at the database boundary:
--
--   * legacy duplicate asset numbers are renamed deterministically with -R
--     suffixes.  Every fixed_assets row, its id, and all id-based lifecycle
--     history remain intact; each rename gets an append-only audit_log record.
--   * fixed_assets asset numbers become unique per organization, so concurrent
--     allocators cannot commit the same number.
--   * an equipment unit may acquire its first fixed-asset link, but an
--     existing non-null link cannot be replaced or cleared.  There is no
--     repository-controlled de-capitalization/reversal lifecycle today, so
--     replacement fails closed instead of disconnecting audited history.
--
-- Every statement is safe to replay after a successful application.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Preserve every legacy asset row while making the natural number unique.
-- The first row in deterministic UUID order keeps the historical number;
-- subsequent rows receive the first free -R suffix.  A candidate is checked
-- against all rows (including prior repairs), so pre-existing suffixed names
-- cannot collide.  No fixed-asset or depreciation history is merged/deleted.
DO $equipment_fixed_asset_number_repair$
DECLARE
  rec record;
  v_suffix integer;
  v_candidate text;
  v_renamed integer := 0;
BEGIN
  FOR rec IN
    SELECT fa.id,
           fa.org_id,
           fa.asset_number,
           row_number() OVER (
             PARTITION BY fa.org_id, fa.asset_number
             ORDER BY fa.id
           ) AS duplicate_rank
      FROM public.fixed_assets fa
     WHERE EXISTS (
       SELECT 1
         FROM public.fixed_assets duplicate
        WHERE duplicate.org_id = fa.org_id
          AND duplicate.asset_number = fa.asset_number
        HAVING count(*) > 1
     )
     ORDER BY fa.org_id, fa.asset_number, fa.id
  LOOP
    IF rec.duplicate_rank = 1 THEN
      CONTINUE;
    END IF;

    v_suffix := rec.duplicate_rank - 1;
    LOOP
      v_candidate := rec.asset_number || '-R' || v_suffix::text;
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM public.fixed_assets existing
         WHERE existing.org_id = rec.org_id
           AND existing.asset_number = v_candidate
      );
      v_suffix := v_suffix + 1;
    END LOOP;

    UPDATE public.fixed_assets
       SET asset_number = v_candidate,
           updated_at = now()
     WHERE id = rec.id
       AND org_id = rec.org_id;

    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    VALUES (
      rec.org_id,
      'fixed_assets',
      rec.id,
      'migration_repair',
      jsonb_build_object(
        'migration', '0068_equipment_capitalization_concurrency',
        'reason', 'duplicate_asset_number',
        'before_asset_number', rec.asset_number,
        'after_asset_number', v_candidate,
        'duplicate_rank', rec.duplicate_rank
      )
    );

    v_renamed := v_renamed + 1;
  END LOOP;

  RAISE NOTICE
    'fixed_assets repair: % duplicate asset number(s) renamed with -R suffixes; no rows or history deleted',
    v_renamed;
END
$equipment_fixed_asset_number_repair$;

-- Idempotent constraint installation.  A UNIQUE constraint (rather than an
-- allocator convention) is the final authority for every API/import/direct
-- SQL writer.  The repair above guarantees this DDL sees a representable
-- legacy state while preserving every fixed_assets primary key.
DO $equipment_fixed_asset_number_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.fixed_assets'::pg_catalog.regclass
       AND conname = 'fixed_assets_org_asset_number_unique'
  ) THEN
    ALTER TABLE public.fixed_assets
      ADD CONSTRAINT fixed_assets_org_asset_number_unique
      UNIQUE (org_id, asset_number);
  END IF;
END
$equipment_fixed_asset_number_constraint$;

COMMENT ON CONSTRAINT fixed_assets_org_asset_number_unique
  ON public.fixed_assets IS
  'openbooks:equipment_capitalization_concurrency:v1 - asset numbers are unique within an organization; legacy collisions were suffix-repaired without merging or deleting fixed-asset history';

CREATE OR REPLACE FUNCTION public.equipment_fixed_asset_link_immutability_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $equipment_fixed_asset_link_immutability_guard$
BEGIN
  -- Initial capitalization is NULL -> asset and remains allowed.  Repeating
  -- the same value is a no-op.  Since no controlled reversal/de-capitalization
  -- path exists, every other change would disconnect audited asset history and
  -- is rejected at the storage boundary for all writers.  The repository's
  -- explicit sandbox teardown is the one controlled exception: it removes the
  -- whole tenant and its evidence under openbooks.sandbox_wipe.
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN NEW;
  END IF;
  IF OLD.fixed_asset_id IS NOT NULL
     AND NEW.fixed_asset_id IS DISTINCT FROM OLD.fixed_asset_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'equipment unit fixed-asset link is immutable after capitalization',
      HINT = 'A controlled de-capitalization/reversal lifecycle must be recorded before replacing or clearing this link.';
  END IF;

  RETURN NEW;
END
$equipment_fixed_asset_link_immutability_guard$;

COMMENT ON FUNCTION public.equipment_fixed_asset_link_immutability_guard() IS
  'openbooks:equipment_capitalization_concurrency:v1 - permits the first NULL-to-asset link and rejects replacement/clearing until a controlled reversal lifecycle exists';

DROP TRIGGER IF EXISTS equipment_fixed_asset_link_immutability
  ON public.equipment_units;

CREATE TRIGGER equipment_fixed_asset_link_immutability
  BEFORE UPDATE OF fixed_asset_id ON public.equipment_units
  FOR EACH ROW
  EXECUTE FUNCTION public.equipment_fixed_asset_link_immutability_guard();
