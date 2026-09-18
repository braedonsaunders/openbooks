-- OpenBooks forward migration 0177_payroll_employer_levy_opening_rls.
--
-- F-intA-001: payroll_employer_levy_opening shipped in 0174 with row-level
-- security DISABLED and no policy, while every sibling tenant table -- including
-- payroll_opening_balances, which it sits beside -- runs ENABLE + FORCE with an
-- org_isolation policy. A constrained role could therefore read another
-- tenant's employer-levy carry-in amounts.
--
-- Nothing was exposed: the table held zero rows in every environment when this
-- was found, because the carry-in save has no UI yet. That is luck, not design.
-- The gap is that the table was added without the isolation its neighbours have,
-- and neither the migration review nor my application of it to the shared
-- cluster caught that.
--
-- FORCE matters as much as ENABLE here. Without it the table owner is exempt,
-- and the owning role is exactly what CI and several tooling paths connect as --
-- which is how an unprotected table can look protected in every test.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.payroll_employer_levy_opening ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_employer_levy_opening FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON public.payroll_employer_levy_opening;
CREATE POLICY org_isolation ON public.payroll_employer_levy_opening
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );
