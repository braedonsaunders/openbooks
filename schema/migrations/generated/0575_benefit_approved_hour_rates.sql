-- Approved-hour incentives use the existing dated program and award lifecycle.
-- A unit price is multiplied by each member's approved hours, not a shared pool.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT hrm_benefit_programs_transaction_shape;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_transaction_shape CHECK(
 (coalesce(metric='transactions',false) AND valuation IN ('percent','per_unit') AND allocation='responsibility' AND metric_scope='company'
  AND family IN ('incentive','custom') AND delivery_method='payroll'
  AND cap_amount IS NULL AND threshold_amount IS NULL AND budget_amount IS NULL
  AND ((valuation='percent' AND percent_rate IS NOT NULL AND percent_rate>0) OR (valuation='per_unit' AND fixed_amount IS NOT NULL AND fixed_amount>0)))
 OR ((metric IS NULL OR metric<>'transactions') AND valuation<>'per_unit' AND allocation<>'responsibility')
 OR (coalesce(metric='approved_hours',false) AND valuation='per_unit' AND allocation='hours'
  AND family='incentive' AND delivery_method='payroll' AND percent_rate IS NULL
  AND fixed_amount IS NOT NULL AND fixed_amount>0));
