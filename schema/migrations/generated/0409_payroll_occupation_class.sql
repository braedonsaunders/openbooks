-- OpenBooks forward migration 0409_payroll_occupation_class.
--
-- New Brunswick ESA s. 21(2) caps a route salesperson's
-- unworked-holiday pay, so the engine must know who IS one — and
-- employee_roles.job_title is free text, not a statutory class. This column
-- is the generic capture: one nullable class per employment, validated
-- against the country pack's closed vocabulary at the profile API boundary
-- (like residence_region and labour_jurisdiction), never by a CHECK naming
-- one country's occupations.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN statutory_occupation_class text;

COMMENT ON COLUMN public.employee_payroll_profiles.statutory_occupation_class IS
  'Statutory occupation class for rules that price by occupation (New Brunswick route salesperson, ESA s. 21(2)). Null = unrecorded; validated against the country pack at the profile boundary.';
