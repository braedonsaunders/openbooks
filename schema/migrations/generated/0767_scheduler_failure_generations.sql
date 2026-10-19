-- Retain one immutable failure and authorization pair for each recovery generation.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.scheduler_outbox_terminal_audit
  ADD COLUMN failure_generation integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT scheduler_outbox_terminal_audit_generation_nonnegative
    CHECK (failure_generation >= 0);

DROP INDEX public.scheduler_outbox_terminal_audit_one_failure;
DROP INDEX public.scheduler_outbox_terminal_audit_one_replay;
CREATE UNIQUE INDEX scheduler_outbox_terminal_audit_one_failure
  ON public.scheduler_outbox_terminal_audit (outbox_row_id, failure_generation)
  WHERE event <> 'replay_authorized';
CREATE UNIQUE INDEX scheduler_outbox_terminal_audit_one_replay
  ON public.scheduler_outbox_terminal_audit (outbox_row_id, failure_generation)
  WHERE event = 'replay_authorized';

COMMENT ON TABLE public.scheduler_outbox_terminal_audit IS
  'Append-only scheduler delivery evidence, with one terminal failure and one authorized replay for each recovery generation.';

COMMENT ON COLUMN public.scheduler_outbox_terminal_audit.failure_generation IS
  'Failure/replay pair ordinal. The first retained failure is generation zero; the next generation follows the latest immutable replay authorization.';

CREATE OR REPLACE FUNCTION public.scheduler_outbox_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_generation integer;
BEGIN
  IF OLD.terminal_failed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.occurrence_key IS DISTINCT FROM OLD.occurrence_key
     OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'scheduler_outbox terminal-failure evidence is immutable; authorize a replay to reset it';
  END IF;
  IF NEW.terminal_failed_at IS NOT DISTINCT FROM OLD.terminal_failed_at
     AND NEW.terminal_failed_by IS NOT DISTINCT FROM OLD.terminal_failed_by THEN
    IF NEW.status <> 'failed' THEN
      RAISE EXCEPTION 'terminal scheduler delivery requires an authorized replay';
    END IF;
    RETURN NEW;
  END IF;
  SELECT failure.failure_generation INTO v_generation
    FROM public.scheduler_outbox_terminal_audit failure
   WHERE failure.outbox_row_id = OLD.id AND failure.event <> 'replay_authorized'
     AND failure.at = OLD.terminal_failed_at AND failure.marked_by = OLD.terminal_failed_by
   ORDER BY failure.failure_generation DESC LIMIT 1;
  IF v_generation IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.scheduler_outbox_terminal_audit replay
     WHERE replay.outbox_row_id = OLD.id AND replay.event = 'replay_authorized'
       AND replay.failure_generation = v_generation
  ) THEN
    RAISE EXCEPTION 'a scheduler_outbox replay reset requires its replay_authorized audit evidence first';
  END IF;
  IF public.openbooks_scheduler_outbox_replay_allowed(OLD.org_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'a scheduler_outbox replay reset requires its organization''s authorization pin';
  END IF;
  IF NEW.terminal_failed_at IS NOT NULL OR NEW.terminal_failed_by IS NOT NULL
     OR NEW.status <> 'pending' OR NEW.attempt_count <> 0
     OR NEW.locked_at IS NOT NULL OR NEW.lease_token IS NOT NULL THEN
    RAISE EXCEPTION 'an authorized scheduler replay must reset the current failure to pending delivery';
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.scheduler_outbox_terminal_guard() IS
  'Freezes terminal identity and requires authorization evidence for the matching failure generation before a transaction-pinned replay reset.';
