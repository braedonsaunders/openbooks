-- OpenBooks forward migration 0365_payroll_sui_exemption_flag.
-- Store state unemployment coverage independently from federal FUTA exemption.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN sui_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.employee_payroll_profiles.sui_exempt IS
  'State unemployment insurance exemption for this employment; independent of federal FUTA exemption.';
