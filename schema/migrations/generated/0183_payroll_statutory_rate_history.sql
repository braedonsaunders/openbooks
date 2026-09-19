-- OpenBooks forward migration 0183_payroll_statutory_rate_history.
--
-- WHY THIS COLUMN EARNS ITS KEEP. `deleteStatutoryRate` refused EVERY stored
-- rate row with "statutory rate rows cannot be deleted; save a replacement
-- rate for the tax year instead", and its doc comment said the rows are
-- effective-dated inputs for payroll reproduction, "leaving the original row
-- available to prior-period reads". There was no replacement row:
-- `upsertStatutoryRate` did an in-place UPDATE of `rate_values` on the same
-- row id for the same scope point, destroying the prior value exactly as a
-- delete would have. The product refused DELETE while permitting a
-- destructive in-place UPDATE — the refusal protected no reproduction at
-- all, only looked like immutability. Only `audit_log` carried a
-- before-image, and no money-path read ever consulted it.
--
-- The fix delivers what the refusal already claimed. `superseded_on` (a date
-- the row stopped being current, null while it is current) turns the table
-- into a genuine history, following the proven `employee_tax_certificates`
-- shape: one open row per scope point, every superseded row retained, the
-- resolver answering the row in force on the PAY DATE rather than "the
-- current row". A re-save supersedes the open row and inserts its successor
-- in one transaction; a remove retires the open row with no successor, so
-- prior periods still resolve while the current setup reads unconfigured.
--
-- The old unconditional unique index made this history IMPOSSIBLE: a
-- superseded row and its replacement share the same scope point AND the same
-- tax year, so the second insert violated it. It is dropped and recreated as
-- the PARTIAL index with WHERE superseded_on IS NULL — the COALESCE
-- treatment survives, because NULLs do not collide in a unique index and a
-- naive index over the nullable scope columns would permit two current rows
-- for one point. Existing rows backfill as current (superseded_on null), so
-- no prior period changes its answer.
--
-- NEVER edit schema/migrations/generated/0001_baseline.sql. This ships as a
-- centrally-allocated forward migration.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.payroll_statutory_rates
  ADD COLUMN superseded_on date;

COMMENT ON COLUMN public.payroll_statutory_rates.superseded_on IS
  'The date this row stopped being the current rate for its scope point (org, country, rate key, tax year, region, sub-region, filing account). Null while the row is current. A re-save stamps the open row and inserts its successor in one transaction; a remove stamps it with no successor. Prior-period reads resolve the row in force on the pay date, so history is never rewritten (see migration 0183).';

-- The unconditional point index forbids a superseded row and its successor
-- coexisting (same scope point, same tax year). Drop it and recreate it as
-- the CURRENT-row index; the advisory lock plus FOR UPDATE row lock in the
-- writer remain the first line of defence against concurrent forks, this
-- index the second.
DROP INDEX public.payroll_statutory_rates_org_point;

CREATE UNIQUE INDEX payroll_statutory_rates_org_point ON public.payroll_statutory_rates USING btree (org_id, country, rate_key, tax_year, COALESCE(region, ''::text), COALESCE(sub_region, ''::text), COALESCE(filing_account_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (superseded_on IS NULL);
