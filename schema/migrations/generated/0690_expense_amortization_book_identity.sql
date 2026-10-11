-- OpenBooks forward migration 0690_expense_amortization_book_identity.
-- A source line has one immutable amortization schedule in each accounting
-- book that carries its deferral. Widen the source identity to include the
-- book, retaining every existing schedule, plan line and event.
-- Backfill: none. Existing schedule identities already satisfy the wider key.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX public.expense_amortization_schedules_source_line;
CREATE UNIQUE INDEX expense_amortization_schedules_source_line
  ON public.expense_amortization_schedules (org_id, source_line_id, book_id)
  WHERE source_line_id IS NOT NULL;
