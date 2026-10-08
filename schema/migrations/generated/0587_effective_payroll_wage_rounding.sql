-- Payroll rate precision and monetary rounding belong to the dated wage.
-- Existing wages retain four-place multiplied rates and dimension-group totals.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.labor_cost_rates
  ADD COLUMN payroll_rate_scale integer NOT NULL DEFAULT 4,
  ADD COLUMN payroll_amount_rounding text NOT NULL DEFAULT 'dimension_group',
  ADD CONSTRAINT labor_cost_rates_payroll_rate_scale CHECK (payroll_rate_scale BETWEEN 0 AND 4),
  ADD CONSTRAINT labor_cost_rates_payroll_amount_rounding CHECK (payroll_amount_rounding IN ('dimension_group', 'time_entry'));
