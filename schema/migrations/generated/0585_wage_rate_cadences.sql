-- OpenBooks forward migration 0585_wage_rate_cadences.
-- Wage rates may be quoted per hour, week, two weeks, half-month, month or
-- year; every existing row is hourly or yearly and satisfies the wider check.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.labor_cost_rates
  DROP CONSTRAINT labor_cost_rates_basis,
  ADD CONSTRAINT labor_cost_rates_basis
    CHECK (basis = ANY (ARRAY['hour'::text, 'week'::text, 'biweekly'::text, 'semimonth'::text, 'month'::text, 'year'::text]));
