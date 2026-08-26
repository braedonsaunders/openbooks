-- OpenBooks forward migration 0040_payroll_commit_selection_fence.
--
-- A calculated payroll previously remembered only its stub output. Commit
-- then rediscovered approved time by employee/group and could mark a time
-- entry added after calculation as paid even though the stub and GL had never
-- priced it. Persist the canonical calculation source population and its
-- SHA-256 so commit can row-lock/recompute it and claim only the exact IDs the
-- calculation reviewed.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_runs
  ADD COLUMN calculation_source_snapshot jsonb,
  ADD COLUMN calculation_source_digest text;

ALTER TABLE public.pay_runs
  ADD CONSTRAINT pay_runs_calculation_source_pair
    CHECK (num_nonnulls(calculation_source_snapshot, calculation_source_digest) IN (0, 2)),
  ADD CONSTRAINT pay_runs_calculation_source_shape
    CHECK (
      calculation_source_snapshot IS NULL
      OR jsonb_typeof(calculation_source_snapshot) = 'object'
    ),
  ADD CONSTRAINT pay_runs_calculation_source_digest
    CHECK (
      calculation_source_digest IS NULL
      OR calculation_source_digest ~ '^[0-9a-f]{64}$'
    );

COMMENT ON COLUMN public.pay_runs.calculation_source_snapshot IS
  'Versioned canonical time-entry and effective rate inputs that produced the calculated stubs; commit must recompute an exact match.';
COMMENT ON COLUMN public.pay_runs.calculation_source_digest IS
  'SHA-256 of calculation_source_snapshot canonical JSON; missing on a calculated legacy run forces recalculation before commit.';

-- pay_runs is an approved governed-query relation. Rebuild its frozen SELECT
-- * view so the new non-secret calculation evidence is queryable there too.
SELECT public.openbooks_refresh_query_catalog();
