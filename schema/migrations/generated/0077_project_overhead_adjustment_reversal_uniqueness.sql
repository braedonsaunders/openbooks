-- OpenBooks forward migration 0077_project_overhead_adjustment_reversal_uniqueness.
--
-- A project overhead adjustment is immutable evidence. Its reversal lineage is
-- therefore one-to-one: retrying the reversal of one source adjustment must
-- never append a second negation. The engine serializes normal retries on the
-- source row, while this partial unique index remains the storage boundary for
-- direct SQL and races that bypass the service.
--
-- Existing duplicate lineages are not repaired heuristically. They represent
-- contradictory financial evidence, so the migration fails closed and reports
-- the source adjustment plus its deterministically ordered conflicting row IDs.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $project_overhead_adjustment_reversal_preflight$
DECLARE
  v_duplicate record;
BEGIN
  SELECT org_id, reverses_adjustment_id,
         string_agg(id::text, ', ' ORDER BY id) AS row_ids
    INTO v_duplicate
    FROM public.project_overhead_adjustments
   WHERE reverses_adjustment_id IS NOT NULL
   GROUP BY org_id, reverses_adjustment_id
  HAVING count(*) > 1
   ORDER BY org_id, reverses_adjustment_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'organization % project overhead adjustment % has multiple reversal rows: %',
      v_duplicate.org_id,
      v_duplicate.reverses_adjustment_id,
      v_duplicate.row_ids
      USING ERRCODE = '23505',
            DETAIL = 'Resolve duplicate project overhead reversal evidence before applying 0077_project_overhead_adjustment_reversal_uniqueness.sql.';
  END IF;
END;
$project_overhead_adjustment_reversal_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS project_overhead_adjustments_one_reversal
  ON public.project_overhead_adjustments USING btree
     (org_id, reverses_adjustment_id)
 WHERE reverses_adjustment_id IS NOT NULL;

COMMENT ON INDEX public.project_overhead_adjustments_one_reversal IS
  'openbooks: one reversal row per tenant/source project overhead adjustment; NULL lineage rows are not constrained';
