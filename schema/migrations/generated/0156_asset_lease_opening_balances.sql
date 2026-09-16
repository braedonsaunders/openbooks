-- OpenBooks forward migration 0156_asset_lease_opening_balances.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Mid-life onboarding ("continue from accumulated"): a tenant arriving with
-- years of history in a legacy system onboards a mid-life fixed asset at its
-- original cost plus the accumulated depreciation already recognised before
-- cutover (with the as-of date that figure is measured through), and a
-- mid-life lessee lease at its opening liability and right-of-use carrying
-- amounts (with their as-of date). The engine continues both schedules from
-- those figures — pre-as-of months are never caught up and never double
-- counted — and every carrying-amount reader (disposal, remeasurement,
-- register, drawer) folds the opening figure in. See
-- engine/src/depreciation.ts (buildScheduleWithRunner) and
-- engine/src/leases.ts (commenceLease).
--
-- The opening figures are MEMO carry-in balances, not postings: the tenant's
-- opening trial-balance import carries the GL balances, and these columns let
-- the subledgers tie to them. They default to NULL (no onboarding — today's
-- full-life-from-in-service behaviour is unchanged).
--
-- Additive, ledger-tracked, no history reinterpretation: nullable columns
-- plus all-or-none and bounds checks only. No row, trigger, or view changes.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.fixed_assets
  ADD COLUMN IF NOT EXISTS opening_accumulated_depreciation numeric(19,4),
  ADD COLUMN IF NOT EXISTS opening_accumulated_as_of date;

ALTER TABLE public.lease_agreements
  ADD COLUMN IF NOT EXISTS opening_liability numeric(19,4),
  ADD COLUMN IF NOT EXISTS opening_rou_carrying numeric(19,4),
  ADD COLUMN IF NOT EXISTS opening_balances_as_of date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fixed_assets_opening_balances_check'
  ) THEN
    ALTER TABLE ONLY public.fixed_assets
      ADD CONSTRAINT fixed_assets_opening_balances_check CHECK (
        (
          opening_accumulated_depreciation IS NULL
          AND opening_accumulated_as_of IS NULL
        )
        OR (
          opening_accumulated_depreciation IS NOT NULL
          AND opening_accumulated_as_of IS NOT NULL
          AND opening_accumulated_depreciation >= (0)::numeric
          AND opening_accumulated_depreciation <= (acquisition_cost - salvage_value)
        )
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lease_agreements_opening_balances_check'
  ) THEN
    ALTER TABLE ONLY public.lease_agreements
      ADD CONSTRAINT lease_agreements_opening_balances_check CHECK (
        (
          opening_liability IS NULL
          AND opening_rou_carrying IS NULL
          AND opening_balances_as_of IS NULL
        )
        OR (
          opening_liability IS NOT NULL
          AND opening_rou_carrying IS NOT NULL
          AND opening_balances_as_of IS NOT NULL
          AND opening_liability >= (0)::numeric
          AND opening_rou_carrying >= (0)::numeric
        )
      );
  END IF;
END
$$;
