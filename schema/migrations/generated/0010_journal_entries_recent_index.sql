-- Serve the most recently recorded posted entries from an index instead of sorting every entry.
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
       AND c.relname = 'je_org_recent_posted'
       AND NOT i.indisvalid
  ) THEN
    DROP INDEX public.je_org_recent_posted;
  END IF;
END
$$;

-- The dashboard and activity surfaces list an organization's latest posted
-- entries in recording order (created_at DESC, entry_number DESC). Built
-- concurrently so journal_entries stays writable while it builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS je_org_recent_posted
  ON public.journal_entries USING btree (org_id, created_at DESC, entry_number DESC)
  WHERE status IN ('posted', 'reversed');
