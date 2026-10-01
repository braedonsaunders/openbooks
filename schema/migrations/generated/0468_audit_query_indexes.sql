-- Deterministic event windows and a compact metadata scan for exact facets.
-- Build concurrently so audit writers remain available during rollout.
-- openbooks: no-transaction
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- An interrupted concurrent build leaves an unusable index with its name
-- reserved. Remove only this migration's invalid indexes before resuming.
DO $migration$
DECLARE
  index_name text;
BEGIN
  FOR index_name IN
    SELECT c.relname
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT i.indisvalid
       AND c.relname IN ('audit_log_org_at_id', 'audit_log_org_metadata')
  LOOP
    EXECUTE pg_catalog.format('DROP INDEX public.%I', index_name);
  END LOOP;
END
$migration$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_org_at_id ON public.audit_log (org_id, at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_org_metadata ON public.audit_log (org_id, table_name, row_id)
  INCLUDE (id, action, actor_id, at);
