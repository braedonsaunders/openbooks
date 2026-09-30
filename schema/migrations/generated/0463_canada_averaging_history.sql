-- OpenBooks forward migration 0463_canada_averaging_history.
-- Preserve imported averaging-window inputs independently of calendar-year contribution ceilings.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
ALTER TABLE public.payroll_opening_balances
  ADD COLUMN non_periodic_pension_deductions_ytd numeric(19,4) NOT NULL DEFAULT 0 CHECK (non_periodic_pension_deductions_ytd>=0),
  ADD COLUMN ca_avg_income numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_income>=0),
  ADD COLUMN ca_avg_pension_f numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_pension_f>=0),
  ADD COLUMN ca_avg_alimony numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_alimony>=0),
  ADD COLUMN ca_avg_union_dues numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_union_dues>=0),
  ADD COLUMN ca_avg_f5_a numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_f5_a>=0),
  ADD COLUMN ca_avg_pe numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_pe>=0),
  ADD COLUMN ca_avg_ie numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_ie>=0),
  ADD COLUMN ca_avg_qpip numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_qpip>=0),
  ADD COLUMN ca_avg_bonus_pe numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_bonus_pe>=0),
  ADD COLUMN ca_avg_bonus_ie numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_bonus_ie>=0),
  ADD COLUMN ca_avg_bonus_qpip numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_bonus_qpip>=0),
  ADD COLUMN ca_avg_tax_m numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_tax_m>=0),
  ADD COLUMN ca_avg_tax_m1 numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_tax_m1>=0),
  ADD COLUMN ca_avg_bonus numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_bonus>=0),
  ADD COLUMN ca_avg_f4 numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_f4>=0),
  ADD COLUMN ca_avg_f5_b numeric(19,4) NOT NULL DEFAULT 0 CHECK (ca_avg_f5_b>=0);
SELECT public.openbooks_refresh_query_catalog();
