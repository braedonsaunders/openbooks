-- Let a sandbox clone refresh planner statistics for the tables it has just copied.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Rows a clone copies are unknown to the planner's statistics until the
-- tables are analyzed, so the verification and rebuild statements that follow
-- the copy in the same transaction are planned for an empty organization and
-- rescan the whole copy per row. ANALYZE counts the transaction's own
-- uncommitted rows, but only a table's owner may run it, so this function
-- runs it as the owner for the clone transaction alone. It changes no rows.
CREATE OR REPLACE FUNCTION public.openbooks_clone_analyze(relations text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  relation_name text;
  relation regclass;
BEGIN
  IF NOT public.openbooks_clone_authority() THEN
    RAISE EXCEPTION 'Clone statistics may be refreshed only inside a sandbox clone transaction.'
      USING ERRCODE = '42501';
  END IF;
  FOREACH relation_name IN ARRAY coalesce(relations, ARRAY[]::text[]) LOOP
    SELECT c.oid INTO relation
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = relation_name AND c.relkind = 'r';
    IF relation IS NULL THEN
      RAISE EXCEPTION 'Clone statistics cannot refresh %: not an application table.', relation_name
        USING ERRCODE = '42P01';
    END IF;
    EXECUTE format('ANALYZE %s', relation);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.openbooks_clone_analyze(text[]) FROM PUBLIC;
