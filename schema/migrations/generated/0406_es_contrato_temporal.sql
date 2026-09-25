-- OpenBooks forward migration 0406_es_contrato_temporal.
-- Store the ES contract type (temporal vs indefinido) on the payroll
-- profile: it selects the Seguridad Social desempleo rate split (Orden
-- PJC/297/2026 art. 33.2.a: 7,05% indefinite vs 8,30% temporary), so an
-- undeclared contract must refuse rather than price as indefinite.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN es_contrato_temporal text;

ALTER TABLE public.employee_payroll_profiles
  ADD CONSTRAINT employee_payroll_profiles_es_contrato
    CHECK (es_contrato_temporal IS NULL OR es_contrato_temporal IN ('true', 'false'));

COMMENT ON COLUMN public.employee_payroll_profiles.es_contrato_temporal IS
  'ES contract type for the Seguridad Social desempleo split: "true" prices the temporary-contract 8,30% rate, "false" the indefinite 7,05% (Orden PJC/297/2026 art. 33.2.a) (0406); null = undeclared, never indefinite by fallthrough.';
