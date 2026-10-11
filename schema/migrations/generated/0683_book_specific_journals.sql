-- OpenBooks forward migration 0683_book_specific_journals.
--
-- A manual journal may target one accounting book. documents gains
-- accounting_book_id: null keeps the standard behaviour (the journal posts
-- to the primary book and replicates into every full book); a book id posts
-- the journal to that book only. Only journals carry a book, and a posted or
-- reversed journal keeps the book it posted to, through the same guard
-- function that freezes the other posted financial columns.
--
-- Backfill: none. Existing documents keep a null book, which is their
-- current behaviour.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS accounting_book_id uuid;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_accounting_book_fk
    FOREIGN KEY (org_id, accounting_book_id) REFERENCES public.accounting_books(org_id, id),
  ADD CONSTRAINT documents_accounting_book_journal_only
    CHECK (accounting_book_id IS NULL OR kind = 'journal');

CREATE INDEX IF NOT EXISTS documents_accounting_book
  ON public.documents USING btree (org_id, accounting_book_id)
  WHERE accounting_book_id IS NOT NULL;

COMMENT ON COLUMN public.documents.accounting_book_id IS
  'Book-specific journal target. Null: the journal posts to the primary book and replicates into full books. Set: the journal posts to that book only.';

DROP TRIGGER IF EXISTS documents_posted_book_guard ON public.documents;
CREATE TRIGGER documents_posted_book_guard
  BEFORE UPDATE OF accounting_book_id ON public.documents
  FOR EACH ROW
  WHEN (old.status = ANY (ARRAY['posted'::text, 'reversed'::text])
        AND new.accounting_book_id IS DISTINCT FROM old.accounting_book_id)
  EXECUTE FUNCTION public.posted_document_financial_guard();

SELECT public.openbooks_refresh_query_catalog();
