-- OpenBooks forward migration 0072_payroll_parallel_unattributed_uniqueness.
--
-- payroll_parallel_findings_cell was published as a unique index over
-- (comparison_id, employee_party_id, kind, slot). The employee is nullable
-- for population-level `unattributed` totals, and PostgreSQL's ordinary
-- unique semantics treat every NULL as a different value. Two writes for the
-- same unattributed cell could therefore both commit and double-count the
-- difference.
--
-- This migration first repairs rows written under that old rule, retaining
-- the earliest row for each NULL-employee cell (created_at/id is a stable
-- tiebreak) and removing only the extra materialized finding rows. It then
-- replaces the old index with a NULLS NOT DISTINCT table constraint. The
-- repair is inside the same transaction as enforcement and is guarded by the
-- constraint check, so replay after a successful application is a no-op.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $payroll_parallel_findings_cell_repair$
DECLARE
  deleted_count integer := 0;
BEGIN
  -- A prior application already installed the NULLS NOT DISTINCT constraint;
  -- leave its index and every surviving finding untouched on replay.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
     WHERE c.conname = 'payroll_parallel_findings_cell'
       AND r.relname = 'payroll_parallel_findings'
       AND n.nspname = 'public'
  ) THEN
    -- The baseline object is an ordinary unique index with this same name.
    -- Drop it before deleting NULL-key duplicates so the replacement
    -- constraint can reuse the published identity without a name collision.
    DROP INDEX IF EXISTS public.payroll_parallel_findings_cell;

    -- PostgreSQL groups NULLs together for this partitioning expression. Keep
    -- one canonical row per run/employee/kind/slot and remove only legacy
    -- duplicate NULL-employee rows; attributed findings are never touched.
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY comparison_id, employee_party_id, kind, slot
               ORDER BY created_at, id
             ) AS row_number
        FROM public.payroll_parallel_findings
       WHERE employee_party_id IS NULL
    )
    DELETE FROM public.payroll_parallel_findings finding
     USING ranked
     WHERE finding.id = ranked.id
       AND ranked.row_number > 1;
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    ALTER TABLE ONLY public.payroll_parallel_findings
      ADD CONSTRAINT payroll_parallel_findings_cell
      UNIQUE NULLS NOT DISTINCT (comparison_id, employee_party_id, kind, slot);

    RAISE NOTICE
      'payroll_parallel_findings repair: % duplicate NULL-employee cell(s) removed before enforcing uniqueness',
      deleted_count;
  END IF;
END
$payroll_parallel_findings_cell_repair$;

COMMENT ON CONSTRAINT payroll_parallel_findings_cell
  ON public.payroll_parallel_findings IS
  'openbooks:payroll_parallel_unattributed_uniqueness:v1 - one finding row per comparison, employee (including one NULL bucket), kind, and slot';
