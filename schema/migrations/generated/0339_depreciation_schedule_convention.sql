-- OpenBooks forward migration 0339_depreciation_schedule_convention.
--
-- Audit wave B (B-AST-001): the post-posting drift gate compared method,
-- method-id, life, rate and units but deliberately omitted convention,
-- because legacy schedule headers never captured one. Changing half-year
-- to mid-month after lines had posted therefore rebuilt the remaining plan
-- under new timing with no refusal, reinterpreting retained history.
--
-- This migration captures the convention on the schedule header so the gate
-- can compare it like every other policy field:
--   1. adds the nullable depreciation_schedules.convention (domain-checked;
--      NULL means unrecorded, never a fourth convention);
--   2. backfills NULL headers from the effective policy in the engine's own
--      resolution order (book policy, then asset, then category default),
--      restricted to the three known conventions — anything else stays NULL
--      rather than laundering an unknown value;
--   3. records every backfilled row in upgrade_legacy_provenance (0326):
--      the stamped value is the policy effective at upgrade time, a
--      reconstruction where the original convention was never recorded.
-- New and rebuilt schedules stamp the header in engine/src/assets
-- (depreciation.ts); the drift gate compares it from this migration on.
--
-- Re-runnable: the column add is IF NOT EXISTS, the constraint add checks
-- pg_constraint, the backfill only touches NULL headers, and provenance
-- inserts collide on the registry primary key when replayed — a conflict
-- means the row is already recorded, expected and benign, so
-- ON CONFLICT DO NOTHING carries that justification and no other.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- 1. Header column plus domain guard.
-- ---------------------------------------------------------------------------
ALTER TABLE public.depreciation_schedules
  ADD COLUMN IF NOT EXISTS convention text;

COMMENT ON COLUMN public.depreciation_schedules.convention IS
  'First-period convention the retained schedule was built under (full_month, mid_month, half_year). Compared by the post-posting drift gate like method and life; NULL means the convention was never recorded. (0339)';

DO $convention_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'depr_schedules_convention_domain'
  ) THEN
    ALTER TABLE public.depreciation_schedules
      ADD CONSTRAINT depr_schedules_convention_domain
      CHECK (convention IS NULL OR convention IN ('full_month', 'mid_month', 'half_year'));
  END IF;
END;
$convention_check$;

-- ---------------------------------------------------------------------------
-- 2 + 3. Backfill from the effective policy; record the reconstruction.
-- ---------------------------------------------------------------------------
WITH effective AS (
  SELECT s2.id,
         s2.org_id,
         COALESCE(p.convention, a.depreciation_convention, c.default_convention) AS convention
    FROM public.depreciation_schedules s2
    JOIN public.fixed_assets a
      ON a.org_id = s2.org_id AND a.id = s2.asset_id
    JOIN public.asset_categories c
      ON c.org_id = s2.org_id AND c.id = a.category_id
    LEFT JOIN public.depreciation_book_policies p
      ON p.org_id = s2.org_id AND p.book_id = s2.book_id AND p.category_id = a.category_id
   WHERE s2.convention IS NULL
),
backfilled AS (
  UPDATE public.depreciation_schedules s
     SET convention = effective.convention
    FROM effective
   WHERE s.id = effective.id
     AND effective.convention IN ('full_month', 'mid_month', 'half_year')
  RETURNING s.org_id, s.id
)
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT b.org_id,
       '0339_depreciation_schedule_convention',
       'depreciation_schedules',
       b.id,
       'convention backfilled from the effective policy at upgrade; the original convention was never recorded on the schedule header'
  FROM backfilled b
ON CONFLICT DO NOTHING;

DO $notice$
DECLARE
  stamped integer;
  unstamped integer;
BEGIN
  SELECT count(*) INTO stamped FROM public.upgrade_legacy_provenance
   WHERE migration = '0339_depreciation_schedule_convention';
  SELECT count(*) INTO unstamped FROM public.depreciation_schedules WHERE convention IS NULL;
  RAISE NOTICE '0339: % schedule header(s) carry a backfilled convention (provenance recorded); % header(s) remain unrecorded (no resolvable policy — the drift gate fails closed on rebuild until the policy is set)',
    stamped, unstamped;
END;
$notice$;
