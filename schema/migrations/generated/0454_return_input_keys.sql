-- OpenBooks forward migration 0454_return_input_keys.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.tax_report_lines
  ADD COLUMN input_key text,
  ADD CONSTRAINT tax_report_lines_input_source_check
    CHECK (
      input_key IS NULL OR (
        btrim(input_key) <> ''
        AND formula IS NULL
        AND tax_code_id IS NULL
        AND basis IS NULL
      )
    );

SELECT openbooks_refresh_query_catalog();
