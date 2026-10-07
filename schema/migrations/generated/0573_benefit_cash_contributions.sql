-- Cash contribution elections reuse the governed Benefits enrollment lifecycle.
-- The linked earning component remains authoritative for tax and posting treatment.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_contribution_rules
 DROP CONSTRAINT hrm_benefit_contribution_rules_kind_check;
ALTER TABLE public.hrm_benefit_contribution_rules
 ADD CONSTRAINT hrm_benefit_contribution_rules_kind_check
 CHECK (kind IN ('employee_deduction','employer_contribution','taxable_non_cash','cash_earning'));
