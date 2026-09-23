-- OpenBooks forward migration 0281_hrm_exit_record_revision_and_audit.
--
-- Exit corrections rewrote the one row per employment with no revision and
-- no audit event, so two concurrent corrections silently lost one and no
-- reader could tell what changed, when, or why. This adds the optimistic
-- revision the correction path now requires (starting at 1 for existing
-- rows) and the append-only correction evidence table the service writes
-- in the same transaction as the row it corrects: actor, time, before and
-- after images, and the correction reason. Event rows are immutable
-- history (update/delete refused by trigger, same openbooks.amend escape
-- hatch as the other HRM evidence guards). Re-runnable: every statement
-- is guarded by IF NOT EXISTS.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE ONLY public.hrm_exit_records
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_records_revision') THEN
  ALTER TABLE ONLY public.hrm_exit_records ADD CONSTRAINT hrm_exit_records_revision
    CHECK (revision >= 1); END IF; END $$;

CREATE TABLE IF NOT EXISTS public.hrm_exit_record_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    exit_record_id uuid NOT NULL,
    kind text NOT NULL,
    actor_user_id uuid,
    reason text,
    before_snapshot jsonb,
    after_snapshot jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hrm_exit_record_events_kind
      CHECK (kind IN ('recorded', 'corrected'))
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_record_events_pkey') THEN
  ALTER TABLE ONLY public.hrm_exit_record_events ADD CONSTRAINT hrm_exit_record_events_pkey PRIMARY KEY (id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_record_events_org_id_id_unique') THEN
  ALTER TABLE ONLY public.hrm_exit_record_events ADD CONSTRAINT hrm_exit_record_events_org_id_id_unique UNIQUE (org_id, id); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_record_events_org_id_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_record_events ADD CONSTRAINT hrm_exit_record_events_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_record_events_exit_tenant_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_record_events ADD CONSTRAINT hrm_exit_record_events_exit_tenant_fkey
    FOREIGN KEY (org_id, exit_record_id) REFERENCES public.hrm_exit_records(org_id, id) ON DELETE CASCADE DEFERRABLE; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_exit_record_events_actor_fkey') THEN
  ALTER TABLE ONLY public.hrm_exit_record_events ADD CONSTRAINT hrm_exit_record_events_actor_fkey
    FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE; END IF; END $$;

CREATE INDEX IF NOT EXISTS hrm_exit_record_events_exit
  ON public.hrm_exit_record_events USING btree (org_id, exit_record_id, recorded_at);

CREATE OR REPLACE FUNCTION public.hrm_exit_record_event_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'HRM exit record event % is append-only evidence — correct the exit record with a new correction instead of updating it.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_exit_record_event_immutable_trigger ON public.hrm_exit_record_events;
CREATE TRIGGER hrm_exit_record_event_immutable_trigger
  BEFORE UPDATE ON public.hrm_exit_record_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_exit_record_event_immutable_guard();

CREATE OR REPLACE FUNCTION public.hrm_exit_record_event_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'HRM exit record event % is retained as history and cannot be deleted.', OLD.id;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_exit_record_event_no_delete_trigger ON public.hrm_exit_record_events;
CREATE TRIGGER hrm_exit_record_event_no_delete_trigger
  BEFORE DELETE ON public.hrm_exit_record_events
  FOR EACH ROW EXECUTE FUNCTION public.hrm_exit_record_event_no_delete();
