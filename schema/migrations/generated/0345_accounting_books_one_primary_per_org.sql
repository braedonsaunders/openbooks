-- OpenBooks forward migration 0345_accounting_books_one_primary_per_org.
-- Enforce the single-primary accounting-book invariant at the database boundary.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_books_one_primary_per_org
  ON public.accounting_books (org_id)
  WHERE is_primary;
