-- OpenBooks forward migration 0175_payroll_country_pack_open.
--
-- WHY THE CONSTRAINT IS WIDENING. Packs declare which countries exist; the
-- database does not. The payroll country pack registry
-- (engine/src/payroll/packs.ts PAYROLL_COUNTRY_PACKS) is the authority for
-- which country codes can run payroll, and a CHECK enumerating 'CA' and 'US'
-- is the storage-layer version of the closed `PayrollCountry` union: every
-- new pack would need a schema change to store its own profiles and seeded
-- components. The replacement shape check (`^[A-Z]{2}$`) is deliberately
-- permissive — it rejects only malformed codes, never an unlisted country —
-- because the registry (and the API-boundary validators in front of it:
-- payrollPack, filingAccountProblem, labourJurisdictionProblem) is what
-- refuses an unknown pack, by name. The pay_stubs country evidence CHECK
-- (0091) already uses exactly this shape for the same reason.
--
-- IDENTICAL BEHAVIOUR FOR EXISTING ROWS. Both columns only ever hold 'CA'
-- or 'US' today (the old CHECKs enforced it), and both match `^[A-Z]{2}$`,
-- so the new constraints accept every existing row: no backfill, no data
-- rewrite, no payroll number moves. The employee_payroll_profiles default
-- ('CA') and NOT NULL are untouched — this changes which countries are
-- storable, not what an unset profile means.
-- A malformed code ('gb', '', 'CAN') is still rejected at the storage
-- layer; only the closed country enumeration is gone.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  DROP CONSTRAINT employee_payroll_profiles_country;
ALTER TABLE public.employee_payroll_profiles
  ADD CONSTRAINT employee_payroll_profiles_country CHECK ((country ~ '^[A-Z]{2}$'::text));

ALTER TABLE public.pay_components
  DROP CONSTRAINT pay_components_country;
ALTER TABLE public.pay_components
  ADD CONSTRAINT pay_components_country CHECK (((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text)));

COMMENT ON CONSTRAINT employee_payroll_profiles_country ON public.employee_payroll_profiles IS
  'Pack-country shape check (0175): two uppercase letters. Deliberately NOT an enumeration — packs declare which countries exist (engine/src/payroll/packs.ts), the database only rejects malformed codes.';
COMMENT ON CONSTRAINT pay_components_country ON public.pay_components IS
  'Pack-country shape check (0175): NULL (shared component) or two uppercase letters. Deliberately NOT an enumeration — packs declare which countries exist (engine/src/payroll/packs.ts), the database only rejects malformed codes.';
