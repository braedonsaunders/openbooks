-- OpenBooks forward migration 0074_recognition_event_idempotency.
--
-- Recognition events are financial subledger inputs.  A source retry must
-- address the same (organization, obligation, source) identity rather than
-- append another event and rebuild the obligation twice.  Keep the source
-- reference nullable for historical rows created before this contract; the
-- engine requires a non-blank value for every new event.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- New event writers must provide a meaningful source identity.  NOT VALID
-- preserves legacy rows that predate this invariant while still enforcing the
-- check for every INSERT and UPDATE after the migration.
ALTER TABLE public.recognition_events
  DROP CONSTRAINT IF EXISTS recognition_events_source_reference_nonblank;

ALTER TABLE public.recognition_events
  ADD CONSTRAINT recognition_events_source_reference_nonblank
  CHECK (
    source_reference IS NOT NULL
    AND length(btrim(source_reference)) BETWEEN 1 AND 500
  )
  NOT VALID;

-- PostgreSQL is the final concurrency authority.  The partial identity keeps
-- historical NULL references independent while ensuring one event per source
-- reference within an organization and obligation.
CREATE UNIQUE INDEX IF NOT EXISTS recognition_events_org_obligation_source
  ON public.recognition_events USING btree (org_id, obligation_id, source_reference)
  WHERE source_reference IS NOT NULL;

COMMENT ON CONSTRAINT recognition_events_source_reference_nonblank
  ON public.recognition_events IS
  'openbooks:recognition_events.source_reference:v2 - every new event write requires a non-blank source reference; legacy NULL rows remain readable';

COMMENT ON INDEX public.recognition_events_org_obligation_source IS
  'openbooks:recognition_events.idempotency:v1 - one source event per organization and obligation';
