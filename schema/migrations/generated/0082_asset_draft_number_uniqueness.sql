-- OpenBooks forward migration 0082_asset_draft_number_uniqueness.
--
-- Draft fixed-asset creation previously read max(asset_number)+1 in one
-- autocommit statement and inserted the candidate in another. Concurrent
-- requests could therefore commit the same FA-#### identity. First-use
-- category creation had the same select-then-insert race. The API now takes
-- an org-wide transaction advisory fence, while these unique constraints are
-- the storage boundary for every writer (imports, scripts, and direct SQL).
--
-- Migration 0068 also installs fixed_assets_org_asset_number_unique for the
-- equipment-capitalization path. The guarded installation below is
-- deliberately idempotent so either migration order leaves one invariant.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Preserve every legacy fixed-asset row while making its natural number
-- unique. The first row in deterministic UUID order keeps the historical
-- number; subsequent rows receive the first free -R suffix. No fixed-asset
-- primary key or depreciation history is merged or deleted.
DO $asset_draft_number_repair$
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
        'migration', '0082_asset_draft_number_uniqueness',
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
$asset_draft_number_repair$;

DO $asset_draft_number_constraint$
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
$asset_draft_number_constraint$;

COMMENT ON CONSTRAINT fixed_assets_org_asset_number_unique
  ON public.fixed_assets IS
  'openbooks:asset_draft_number_uniqueness:v1 - fixed-asset numbers are unique within an organization; legacy collisions were suffix-repaired without merging or deleting history';

-- Category names are an org-level identity. Rename legacy duplicates rather
-- than deleting a category that may still be referenced by fixed assets.
DO $asset_category_name_repair$
DECLARE
  rec record;
  v_suffix integer;
  v_candidate text;
  v_renamed integer := 0;
BEGIN
  FOR rec IN
    SELECT ac.id,
           ac.org_id,
           ac.name,
           row_number() OVER (
             PARTITION BY ac.org_id, ac.name
             ORDER BY ac.id
           ) AS duplicate_rank
      FROM public.asset_categories ac
     WHERE EXISTS (
       SELECT 1
         FROM public.asset_categories duplicate
        WHERE duplicate.org_id = ac.org_id
          AND duplicate.name = ac.name
        HAVING count(*) > 1
     )
     ORDER BY ac.org_id, ac.name, ac.id
  LOOP
    IF rec.duplicate_rank = 1 THEN
      CONTINUE;
    END IF;

    v_suffix := rec.duplicate_rank - 1;
    LOOP
      v_candidate := rec.name || '-R' || v_suffix::text;
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM public.asset_categories existing
         WHERE existing.org_id = rec.org_id
           AND existing.name = v_candidate
      );
      v_suffix := v_suffix + 1;
    END LOOP;

    UPDATE public.asset_categories
       SET name = v_candidate,
           updated_at = now()
     WHERE id = rec.id
       AND org_id = rec.org_id;

    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    VALUES (
      rec.org_id,
      'asset_categories',
      rec.id,
      'migration_repair',
      jsonb_build_object(
        'migration', '0082_asset_draft_number_uniqueness',
        'reason', 'duplicate_category_name',
        'before_name', rec.name,
        'after_name', v_candidate,
        'duplicate_rank', rec.duplicate_rank
      )
    );

    v_renamed := v_renamed + 1;
  END LOOP;

  RAISE NOTICE
    'asset_categories repair: % duplicate name(s) renamed with -R suffixes; no rows deleted',
    v_renamed;
END
$asset_category_name_repair$;

CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_org_name
  ON public.asset_categories USING btree (org_id, name);

COMMENT ON INDEX public.asset_categories_org_name IS
  'openbooks:asset_draft_number_uniqueness:v1 - category names are unique within an organization, so first-use default creation is idempotent';
