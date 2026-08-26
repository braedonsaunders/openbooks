-- OpenBooks forward migration 0041_subscription_configuration_invariants.
--
-- Base subscription plans and subscriptions predate the stricter advanced
-- contract model. Their API accepted signed prices, nonpositive quantities,
-- coercive cadence counts, and contradictory billing windows; the scheduler
-- then silently substituted a one-period cadence. These checks make those
-- configurations unrepresentable for API and direct writers alike.
--
-- Financial intent is never guessed during rollout. The preflight identifies
-- one legacy row and aborts before DDL when repair is required. An accountant
-- or operator must decide the intended price, quantity, cadence, or dates and
-- then rerun the migration.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $subscription_configuration_preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT 'subscription_plans.amount'::text AS invariant,
             p.id AS row_id,
             p.org_id,
             jsonb_build_object('amount', p.amount) AS configuration
        FROM public.subscription_plans p
       WHERE p.amount < 0
      UNION ALL
      SELECT 'subscription_plans.cadence',
             p.id,
             p.org_id,
             jsonb_build_object('interval', p.interval, 'interval_count', p.interval_count)
        FROM public.subscription_plans p
       WHERE p.interval NOT IN ('weekly', 'monthly', 'quarterly', 'annually')
          OR p.interval_count <= 0
      UNION ALL
      SELECT 'subscriptions.pricing',
             s.id,
             s.org_id,
             jsonb_build_object('quantity', s.quantity, 'price_override', s.price_override)
        FROM public.subscriptions s
       WHERE s.quantity <= 0
          OR s.price_override < 0
      UNION ALL
      SELECT 'subscriptions.period',
             s.id,
             s.org_id,
             jsonb_build_object(
               'start_on', s.start_on,
               'current_period_start', s.current_period_start,
               'next_bill_on', s.next_bill_on
             )
        FROM public.subscriptions s
       WHERE s.start_on > s.next_bill_on
          OR (
            s.current_period_start IS NOT NULL
            AND (
              s.current_period_start < s.start_on
              OR s.current_period_start > s.next_bill_on
            )
          )
    ) violations
   ORDER BY invariant, row_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('legacy data violates subscription configuration invariant: %s', violation.invariant),
      DETAIL = jsonb_build_object(
        'invariant', violation.invariant,
        'row_id', violation.row_id,
        'org_id', violation.org_id,
        'configuration', violation.configuration
      )::text,
      HINT = 'Review the identified subscription configuration and record an approved correction, then retry migration 0041. This migration never rewrites financial intent.';
  END IF;
END
$subscription_configuration_preflight$;

ALTER TABLE public.subscription_plans
  ADD CONSTRAINT subscription_plans_amount_nonnegative
    CHECK (amount >= 0) NOT VALID,
  ADD CONSTRAINT subscription_plans_cadence_valid
    CHECK (
      interval IN ('weekly', 'monthly', 'quarterly', 'annually')
      AND interval_count > 0
    ) NOT VALID;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_pricing_valid
    CHECK (quantity > 0 AND (price_override IS NULL OR price_override >= 0)) NOT VALID,
  ADD CONSTRAINT subscriptions_period_valid
    CHECK (
      start_on <= next_bill_on
      AND (
        current_period_start IS NULL
        OR (current_period_start >= start_on AND current_period_start <= next_bill_on)
      )
    ) NOT VALID;

ALTER TABLE public.subscription_plans
  VALIDATE CONSTRAINT subscription_plans_amount_nonnegative,
  VALIDATE CONSTRAINT subscription_plans_cadence_valid;

ALTER TABLE public.subscriptions
  VALIDATE CONSTRAINT subscriptions_pricing_valid,
  VALIDATE CONSTRAINT subscriptions_period_valid;

COMMENT ON CONSTRAINT subscription_plans_amount_nonnegative
  ON public.subscription_plans IS
  'openbooks:subscription_configuration_invariants:v1 - base plan amount is a nonnegative exact numeric(19,4) value';
COMMENT ON CONSTRAINT subscription_plans_cadence_valid
  ON public.subscription_plans IS
  'openbooks:subscription_configuration_invariants:v1 - base plan cadence uses a supported interval and positive integer count';
COMMENT ON CONSTRAINT subscriptions_pricing_valid
  ON public.subscriptions IS
  'openbooks:subscription_configuration_invariants:v1 - base quantity is positive and negotiated price is null or nonnegative';
COMMENT ON CONSTRAINT subscriptions_period_valid
  ON public.subscriptions IS
  'openbooks:subscription_configuration_invariants:v1 - base billing dates form one ordered subscription period';
