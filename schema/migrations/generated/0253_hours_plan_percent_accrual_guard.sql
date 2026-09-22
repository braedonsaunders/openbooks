-- OpenBooks forward migration 0253_hours_plan_percent_accrual_guard.
--
-- An hours-denominated entitlement plan that accrues a percent of earnings
-- stores DOLLARS as HOURS: a 4% accrual on $2,000 of earnings banks "80.00"
-- hours nobody worked, and every later payout values those phantom hours at
-- the wage. The engine refuses the combination at calculation
-- (engine/src/payroll/entitlements-movement-kernel.ts); only storage can
-- refuse it at save time, which is why this guard lives here rather than in
-- the Setup drawer alone.
--
-- Hours plans that accrue per hour worked or a fixed amount per period, and
-- pay out through payout/accrual components, are unaffected: those shapes
-- are coherent, and the pay run values their lines at the wage.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $precheck$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(code, ', ') INTO offending
    FROM public.entitlement_plans
   WHERE unit = 'hours' AND accrual_method = 'percent_of_earnings';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'entitlement plan(s) % bank hours but accrue a percent of earnings; change them to per_hour_worked or fixed_per_period, or change their unit to money, before applying 0253', offending;
  END IF;
END;
$precheck$;

-- Dropped first so a runner retry after a lock-timeout does not fail on an
-- already-installed constraint.
ALTER TABLE public.entitlement_plans
  DROP CONSTRAINT IF EXISTS entitlement_plans_hours_no_percent_accrual;
ALTER TABLE public.entitlement_plans
  ADD CONSTRAINT entitlement_plans_hours_no_percent_accrual
  CHECK (unit <> 'hours' OR accrual_method <> 'percent_of_earnings');

COMMENT ON CONSTRAINT entitlement_plans_hours_no_percent_accrual ON public.entitlement_plans IS
  'An hours-denominated plan cannot accrue a percent of (money) earnings: the dollars would be stored as hours. Accrue per_hour_worked or fixed_per_period, or bank money (0253).';
