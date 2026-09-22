-- OpenBooks forward migration 0263_automation_event_queue_retry.
--
-- The automations tick consumed trigger events even when every firing
-- failed: drainEventQueue marked the queue row done and counted it
-- drained, so a poison event vanished with no retry and no operator
-- signal. The durable run row kept the error, but the queue — the
-- trigger's own staging log — forgot it.
--
-- This carries the retry accounting the drain now enforces:
--
--   attempt_count   — firings attempted so far for this staged event.
--   next_attempt_at — the drain claims only due rows, so a failure backs
--     off instead of hot-looping every 60-second tick.
--   'dead' status   — attempts exhausted (or no enabled automation left
--     after a previous failure): terminal, operator-visible, never
--     silently done.
--
-- Additive only. No backfill: existing rows read as attempt 0, due
-- immediately, exactly as the old drain treated them.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE IF EXISTS public.automation_event_queue
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_attempt_floor') THEN
    ALTER TABLE public.automation_event_queue
      ADD CONSTRAINT automation_event_queue_attempt_floor CHECK (attempt_count >= 0);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_status') THEN
    ALTER TABLE public.automation_event_queue DROP CONSTRAINT automation_event_queue_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'automation_event_queue_status') THEN
    ALTER TABLE public.automation_event_queue
      ADD CONSTRAINT automation_event_queue_status CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'dead'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automation_event_queue_pending_due
  ON public.automation_event_queue (next_attempt_at, created_at) WHERE status = 'pending';

COMMENT ON COLUMN public.automation_event_queue.attempt_count IS
  'Automation trigger staging (0263): firing attempts so far; the drain backs off and parks the row dead at the ceiling instead of consuming failures.';
COMMENT ON COLUMN public.automation_event_queue.next_attempt_at IS
  'Automation trigger staging (0263): the drain claims only rows due at or before now, so a failed firing retries on backoff rather than every tick.';
