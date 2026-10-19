-- Voiding an information return filing releases its year/form/entity identity
-- so a replacement can be opened while the void record remains auditable.
-- Active filings remain unique for both organization-root and subsidiary
-- scopes, and their existing contents and lifecycle evidence are preserved.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DROP INDEX IF EXISTS public.information_return_filings_unique_root;
DROP INDEX IF EXISTS public.information_return_filings_unique_sub;

CREATE UNIQUE INDEX information_return_filings_unique_root
  ON public.information_return_filings USING btree (org_id, tax_year, form_type)
  WHERE subsidiary_id IS NULL AND status <> 'void';

CREATE UNIQUE INDEX information_return_filings_unique_sub
  ON public.information_return_filings USING btree (org_id, tax_year, form_type, subsidiary_id)
  WHERE subsidiary_id IS NOT NULL AND status <> 'void';

COMMENT ON INDEX public.information_return_filings_unique_root IS
  'openbooks:information_return_root_uniqueness:v2 - exactly one active organization-root information return per tax year and form type';

COMMENT ON INDEX public.information_return_filings_unique_sub IS
  'openbooks:information_return_root_uniqueness:v2 - exactly one active subsidiary information return per tax year, form type, and subsidiary';
