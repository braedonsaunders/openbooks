-- OpenBooks forward migration 0013_document_revision_monotonic.
--
-- Document optimistic-concurrency tokens could collapse distinct
-- sub-millisecond revisions into one identical `updated_at`: JavaScript Date
-- writers truncate PostgreSQL's six fractional digits to milliseconds, and a
-- second `updated_at = now()` inside one transaction repeats the transaction
-- start time, so two successive writes could store byte-identical revisions.
-- Every OCC holder of the earlier token then compared equal strings against
-- the later revision and a stale write sailed through. Reads and locks already
-- project the exact six-digit canonical token (documentRevisionSql); what
-- storage never guaranteed is that a new revision ADVANCES past the stored
-- one. This trigger closes exactly that gap: an UPDATE that would leave
-- `updated_at` unchanged is bumped at least one microsecond forward, so two
-- committed document revisions can never share a token — whichever driver or
-- writer path produced them. Writes that deliberately advance or backdate the
-- column explicitly are untouched; only the exact repeat, the shape that
-- defeats stale-write detection, is rewritten.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.documents_revision_monotonic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.updated_at = OLD.updated_at THEN
    -- A write that leaves the revision byte-identical is indistinguishable
    -- from "nothing happened" to every optimistic-concurrency holder of the
    -- previous token. Force strictly-forward motion: prefer the wall clock,
    -- falling back to one microsecond past the stored revision when several
    -- writes land inside the same microsecond or the clock stalls.
    NEW.updated_at := greatest(
      clock_timestamp(),
      OLD.updated_at + interval '1 microsecond'
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.documents_revision_monotonic() IS
  'openbooks:document_revision_monotonic:v1 - advances documents.updated_at whenever an update would repeat the stored revision, keeping optimistic-concurrency tokens unique across sub-millisecond writes';

-- Installed through a catalog check rather than bare CREATE TRIGGER so a
-- re-run of this file is a no-op instead of an error.
DO $documents_revision_monotonic_install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'documents'
       AND t.tgname = 'documents_revision_monotonic'
       AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER documents_revision_monotonic
      BEFORE UPDATE ON public.documents
      FOR EACH ROW EXECUTE FUNCTION public.documents_revision_monotonic();
  END IF;
END
$documents_revision_monotonic_install$;

-- The application-level write paths in web/lib/documents.ts keep their own
-- greatest(clock_timestamp(), updated_at + interval '1 microsecond') bump:
-- this trigger makes non-advancing writes impossible everywhere else, while
-- their explicit bump keeps each edit's revision honest even when many rows
-- share one statement timestamp.
