-- OpenBooks forward migration 0483_pay_runs_supplemental_type.
--
-- A pay office routinely processes a second run inside an already-open pay
-- period: a vacation or banked-time payout ahead of the main weekly run, or a
-- late-hours correction after it. The regular-run overlap guard exists so one
-- period is never paid twice, so a second REGULAR run stays refused — but the
-- only off-cycle types (bonus, termination, retro) are taxed with the
-- non-periodic method, which mis-taxes ordinary periodic wages. The
-- supplemental run type closes that gap: it may overlap a regular run of the
-- same schedule and period, pays the same periodic wages a regular run pays,
-- and its statutory share is computed on the period-to-date total (see the
-- payroll engine's period-prior treatment), so per-period exemptions apply
-- once per period rather than once per run.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_runs
  DROP CONSTRAINT pay_runs_run_type;

ALTER TABLE public.pay_runs
  ADD CONSTRAINT pay_runs_run_type
  CHECK (run_type = ANY (ARRAY['regular'::text, 'bonus'::text, 'termination'::text, 'retro'::text, 'supplemental'::text]));

COMMENT ON CONSTRAINT pay_runs_regular_schedule_no_overlap ON public.pay_runs IS
  'Only one live regular run may cover each day for an organization and schedule; bonus, supplemental, termination, retro, and voided runs are not constrained.';
