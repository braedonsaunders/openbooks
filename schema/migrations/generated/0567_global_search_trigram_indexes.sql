-- OpenBooks forward migration 0567_global_search_trigram_indexes.
--
-- Global search now also matches a document's line descriptions, the
-- people (contacts) of a customer or vendor by name and email, and custom
-- records by their search text and number. Each of those predicates is a
-- substring ILIKE that only a trigram index can serve; without one, every
-- keystroke in the header search would scan the tenant's document lines.
-- These are plain GIN trigram indexes, the same shape as the existing
-- party, document, account, item and project search indexes.
--
-- document_lines is one of the largest tables, so every index builds with
-- CREATE INDEX CONCURRENTLY, which PostgreSQL refuses inside a transaction
-- block: this file declares `-- openbooks: no-transaction` and the runner
-- executes it statement by statement under its bounded lock_timeout. Every
-- statement is idempotent (IF NOT EXISTS), and the DO block first drops this
-- file's own INVALID indexes, which a failed CONCURRENTLY build leaves
-- behind and IF NOT EXISTS would otherwise skip forever. The cleanup matches
-- only these index names in the public schema on their intended tables, and
-- drops them schema-qualified. A plain DROP INDEX takes an ACCESS EXCLUSIVE
-- lock on the index's table for the moment of the drop: it waits behind
-- in-flight readers and writers of that table, and blocks new ones while it
-- waits, for at most the runner's lock_timeout, after which the statement
-- fails and the migration can be retried. It runs only when an earlier
-- attempt left an invalid index, so a clean first run takes no such lock. No
-- row is read or written beyond the index builds themselves.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT i.indisvalid
       AND n.nspname = 'public'
       AND (c.relname, t.relname) IN (
         ('document_lines_description_trgm', 'document_lines'),
         ('contacts_name_trgm', 'contacts'),
         ('contacts_email_trgm', 'contacts'),
         ('custom_records_search_text_trgm', 'custom_records'),
         ('custom_records_record_number_trgm', 'custom_records')
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx);
  END LOOP;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS document_lines_description_trgm
  ON public.document_lines USING gin (description public.gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_name_trgm
  ON public.contacts USING gin (name public.gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_email_trgm
  ON public.contacts USING gin (email public.gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS custom_records_search_text_trgm
  ON public.custom_records USING gin (search_text public.gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS custom_records_record_number_trgm
  ON public.custom_records USING gin (record_number public.gin_trgm_ops);
