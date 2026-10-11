-- OpenBooks forward migration 0662_payroll_wcb_exemption.
--
-- Workers' compensation coverage was decided by the absence of a value:
-- employee_roles.worker_comp_group_id NULL meant both "not yet assigned"
-- and "genuinely excluded", so a missing rate class silently accrued no
-- premium. The rate class stays where it is; the exclusion gets its own
-- explicit, reasoned status on the payroll profile beside the CPP/EI
-- exemptions. The run refuses an employee who has neither, naming them and
-- both remedies, instead of paying them uncovered.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN IF NOT EXISTS wcb_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN IF NOT EXISTS wcb_exempt_reason text;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_payroll_profiles_wcb_exempt_reason') THEN
  ALTER TABLE public.employee_payroll_profiles ADD CONSTRAINT employee_payroll_profiles_wcb_exempt_reason CHECK (
    wcb_exempt = false OR (wcb_exempt_reason IS NOT NULL AND btrim(wcb_exempt_reason) <> '')); END IF; END $$;

COMMENT ON COLUMN public.employee_payroll_profiles.wcb_exempt IS
  'True when this employment is genuinely excluded from workers-compensation coverage (for example an owner or director the employer account does not cover). False means covered by a rate class, or uncovered and refused at calculate time.';
COMMENT ON COLUMN public.employee_payroll_profiles.wcb_exempt_reason IS
  'Reason for the workers-compensation exclusion, required whenever wcb_exempt is true.';
