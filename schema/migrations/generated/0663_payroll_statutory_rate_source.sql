-- OpenBooks forward migration 0663_payroll_statutory_rate_source.
--
-- Hand-entered statutory rates are financial policy: every row must carry
-- the published source it was taken from and the reason it was entered.
-- Both columns stay nullable so rows recorded before this change keep
-- their shape, and each named check admits NULL while refusing a blank
-- string, so a blank can never satisfy the traceability the write
-- boundary enforces on every new or changed row.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.payroll_statutory_rates ADD COLUMN IF NOT EXISTS source_citation text;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_statutory_rates_source_citation_nonblank') THEN
  ALTER TABLE ONLY public.payroll_statutory_rates ADD CONSTRAINT payroll_statutory_rates_source_citation_nonblank
    CHECK (source_citation IS NULL OR btrim(source_citation) <> ''); END IF; END $$;

ALTER TABLE public.payroll_statutory_rates ADD COLUMN IF NOT EXISTS reason text;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_statutory_rates_reason_nonblank') THEN
  ALTER TABLE ONLY public.payroll_statutory_rates ADD CONSTRAINT payroll_statutory_rates_reason_nonblank
    CHECK (reason IS NULL OR btrim(reason) <> ''); END IF; END $$;

COMMENT ON COLUMN public.payroll_statutory_rates.source_citation IS
  'The published source the entered figures were taken from (for example the ESD premium announcement for the year). Null for rows recorded before this change; required by the write boundary on every new or changed row (see migration 0663).';
COMMENT ON COLUMN public.payroll_statutory_rates.reason IS
  'Why the row was entered or changed, in the operator''s own words. Null for rows recorded before this change; required by the write boundary on every new or changed row (see migration 0663).';
