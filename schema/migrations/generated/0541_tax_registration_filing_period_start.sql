-- OpenBooks forward migration 0541_tax_registration_filing_period_start.
-- A tax registration's filing periods need not start in January: a UK VAT
-- stagger files Feb-Apr, May-Jul, Aug-Oct and Nov-Jan, and an annual filer
-- may file on a fiscal year. The month a filing period starts is stored on
-- the registration; existing registrations keep January, the calendar-aligned
-- periods they file today.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.tax_registrations
  ADD COLUMN filing_period_start_month smallint DEFAULT 1 NOT NULL,
  ADD CONSTRAINT tax_registrations_filing_period_start_month
    CHECK (filing_period_start_month BETWEEN 1 AND 12);
