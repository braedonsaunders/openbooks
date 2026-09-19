-- OpenBooks forward migration 0182_pay_run_calculation_errors.
--
-- WHY THIS COLUMN EARNS ITS KEEP. A pay run that calculates one of three
-- employees and refuses the other two used to COMMIT AND POST with zero errors:
-- the two refusals lived only in the calculate response held in the operator's
-- browser memory, while the run row remembered just totals. Exceptions
-- therefore appeared only after a RE-calculate (which returned them fresh),
-- never after the first one — so an operator who calculated once and
-- committed never saw that two thirds of the payroll was missing, and the
-- posted period showed two employees unpaid with a balanced journal and a
-- clean register. Persisting the per-employee errors AT CALCULATE is what
-- fixes that timing bug: commit and the run page now read the SAME refusals
-- the calculate saw, from the same row.
--
-- The acknowledgement column is the smaller half. There are legitimate
-- partial runs (a mid-period hire, unpaid leave), so commit is refused while
-- an in-scope employee is refused UNLESS the operator explicitly acknowledges
-- exactly that refusal set — bound by digest, so acknowledging one set and
-- recalculating into another invalidates the old acknowledgement. The
-- calculation_source_* pair is deliberately NOT reused for either: that pair
-- is the staleness digest, and coupling refusals to it would make a digest
-- change look like a refusal change.
--
-- Null calculation_errors is not the empty set: runs calculated before this
-- migration recalculate first rather than commit on unknown refusal state.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_runs
  ADD COLUMN calculation_errors jsonb,
  ADD COLUMN refusal_acknowledgement jsonb;

ALTER TABLE public.pay_runs
  ADD CONSTRAINT pay_runs_calculation_errors_shape
    CHECK (
      calculation_errors IS NULL
      OR jsonb_typeof(calculation_errors) = 'array'
    ),
  ADD CONSTRAINT pay_runs_refusal_acknowledgement_shape
    CHECK (
      refusal_acknowledgement IS NULL
      OR jsonb_typeof(refusal_acknowledgement) = 'object'
    );

COMMENT ON COLUMN public.pay_runs.calculation_errors IS
  'Per-employee calculation outcomes (refusals, warnings, out-of-scope) from the latest calculate, replaced wholesale on every pass; commit gates on the in-scope refusals and the run page renders them back, so both see what the calculate saw.';
COMMENT ON COLUMN public.pay_runs.refusal_acknowledgement IS
  'Recorded operator decision to commit despite in-scope refusals: who was left out with the refusal text verbatim, who acknowledged, when, and the digest of the exact refusal set acknowledged.';

-- pay_runs is an approved governed-query relation. Rebuild its frozen SELECT
-- * view so the new refusal evidence is queryable there too.
SELECT public.openbooks_refresh_query_catalog();
