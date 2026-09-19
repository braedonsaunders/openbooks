-- OpenBooks forward migration 0190_payroll_profile_country_no_default.
--
-- WHY THE DEFAULT GOES. `employee_payroll_profiles.country` has carried
-- `DEFAULT 'CA' NOT NULL` since the 0001 baseline: Canada as a fallthrough
-- at the storage layer. The standing directive gives no country built-in,
-- default or fallthrough treatment, and a silent default destroys the
-- evidence of its own application — a row carrying 'CA' BY DEFAULT is
-- indistinguishable from a row where someone genuinely chose Canada, and no
-- later migration can separate them. 0175 deliberately deferred this ("this
-- changes which countries are storable, not what an unset profile means");
-- this migration is that deferred half: what an unset profile means is now
-- "refused", not "Canadian".
--
-- WHY NOT NULL STAYS. Removing the default is not removing the constraint.
-- A future writer that omits `country` must get a NOT NULL violation,
-- loudly, rather than a silently Canadian employee. Fail closed, not
-- fallthrough.
--
-- WHY HISTORICAL ROWS ARE UNTOUCHED. Reconciling each profile against its
-- employment's country would look like diligence and would destroy the only
-- evidence that a disagreement existed: a guessed row can never again say
-- "I was defaulted". Existing rows keep whatever they carry; only NEW
-- inserts face the closed gate.
--
-- SAFETY ARGUMENT: NO EXISTING ROW CAN BE HARMED. Dropping a DEFAULT
-- changes nothing about rows already stored — their values are untouched —
-- and nothing about any current writer, because every insert path supplies
-- `country` in its column list: the profile upsert
-- (web/app/api/payroll/profiles/route.ts) names `country` explicitly, the
-- filing fixtures (engine/src/payroll-filing-test-fixtures.ts) name it
-- explicitly, and there are no Drizzle-query-builder inserts on this table
-- for the type-level default to reach. The change is inert for existing
-- callers and fails closed only for a future path that omits the column —
-- which is the entire purpose.

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
  ALTER COLUMN country DROP DEFAULT;

COMMENT ON COLUMN public.employee_payroll_profiles.country IS
  'Statutory country pack this employee runs under (0190): no default — an unset country is refused by NOT NULL rather than silently becoming Canada. Historical rows carrying ''CA'' may have been defaulted; they are left untouched because a defaulted row is indistinguishable from a chosen one.';
