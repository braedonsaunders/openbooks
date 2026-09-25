-- OpenBooks forward migration 0389_br_salario_familia_filhos.
-- Carry the eSocial qualifying-children count for salário-família on the payroll profile.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN br_salario_familia_filhos integer;

ALTER TABLE public.employee_payroll_profiles
  ADD CONSTRAINT employee_payroll_profiles_br_salario_familia
    CHECK (br_salario_familia_filhos IS NULL OR br_salario_familia_filhos >= 0);

COMMENT ON COLUMN public.employee_payroll_profiles.br_salario_familia_filhos IS
  'Qualifying children for salário-família (<14 or disabled), from the eSocial cadastro (0389); null = none declared, never defaulted.';
