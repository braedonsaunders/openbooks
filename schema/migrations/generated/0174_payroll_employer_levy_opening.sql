-- OpenBooks forward migration 0174_payroll_employer_levy_opening.
--
-- F-f10: employer-aggregate levies price room against the employer's total
-- base to date (total payroll in scope, not one stub's earnings), and that
-- total has three parts: committed stub factors, the run being calculated,
-- and — for a mid-year adopter — payroll from before the adoption date.
-- Committed stubs are already queryable and the run carries its own rows,
-- but the pre-adoption total had nowhere to live: payroll_opening_balances
-- is keyed (org, employee, year), and an employer total is not an
-- employee's. Without a home for it, a mid-year adopter's first stub would
-- price the full annual allowance as unused room and under-accrue every
-- threshold levy until the employer's real total caught up — silent wrong
-- money for the rest of the year.
--
-- This table is that home: one carry-in row per (org, tax year, levy,
-- region). Per-employee caps do NOT live here — a personal cap's carry-in
-- rides the pack's own per-employee opening field, the same registry every
-- other personal year-to-date reads through.
--
-- WHY A TABLE AND NOT A RATE SLOT. payroll_statutory_rates holds numbers
-- the OPERATOR configures (a rate, an exemption share, a spend). A carry-in
-- is history copied out of the prior provider's final report — the same
-- distinction payroll_opening_balances already draws for personal history,
-- kept here at employer scope so the two never share a key.
--
-- WHY NO BACKFILL. No pack declares an aggregate levy yet, so there is no
-- history to carry: every row this table will ever hold is written by a
-- future carry-in save, under the levy fence, before the first stub that
-- needs it. Existing installs behave exactly as today.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.payroll_employer_levy_opening (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  tax_year integer NOT NULL,
  country text NOT NULL,
  levy_key text NOT NULL,
  region text,
  base_ytd numeric(19, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_employer_levy_opening_nonnegative CHECK (base_ytd >= 0)
);

-- One carry-in per scope point. Two rows for the same point would make the
-- room computation ambiguous, and an ambiguous annual allowance is wrong
-- money that changes answer between queries. Region is nullable (org-wide
-- levies carry none), so the point coalesces it like payroll_statutory_rates
-- does for its own nullable scope columns.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_employer_levy_opening_org_point
  ON public.payroll_employer_levy_opening
  (org_id, tax_year, country, levy_key, (coalesce(region, '')));

CREATE INDEX IF NOT EXISTS payroll_employer_levy_opening_org_year
  ON public.payroll_employer_levy_opening (org_id, country, tax_year);

COMMENT ON TABLE public.payroll_employer_levy_opening IS
  'Employer-scope payroll carry-ins (0174, F-f10): pre-adoption employer base per (org, tax year, levy, region) for pack-declared aggregate levies. Read with committed stub factors to form the annual room; written by the carry-in save under the levy fence. RLS follows the org_id policy like every tenant table.';
COMMENT ON COLUMN public.payroll_employer_levy_opening.base_ytd IS
  'Employer base earned before the adoption date in this levy scope, copied from the prior provider final report. Never negative: a negative YTD is a sign-flipped export, not history.';
