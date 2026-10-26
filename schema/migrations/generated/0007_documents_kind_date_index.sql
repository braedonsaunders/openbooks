-- Serve document lists in date order from an index instead of sorting every document of a kind.
-- openbooks: no-transaction
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- A concurrent build that fails leaves an INVALID index of the same name;
-- drop it so a retried run builds the index from scratch.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'documents_org_kind_document_date'
       AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.documents_org_kind_document_date;
  END IF;
END
$$;

-- Document lists page through one kind newest first (document_date DESC
-- NULLS LAST, id DESC), and module homes read a kind's recent date window.
-- Built concurrently so documents stays writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_org_kind_document_date
  ON public.documents USING btree (org_id, kind, document_date DESC NULLS LAST, id DESC);
