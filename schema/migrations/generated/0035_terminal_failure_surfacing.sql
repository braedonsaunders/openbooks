-- OpenBooks forward migration 0006_terminal_failure_surfacing.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The scheduler outboxes stopped retrying at their attempt ceilings but left
-- nothing that distinguished a terminally failed row from one still cycling
-- through backoff — poison work was queryable only by convention and silent
-- otherwise. These columns are stamped exactly once, by the single worker
-- attempt whose failure exhausts the ceiling:
--
--   terminal_failed_at  when the row became a permanent failure (never reset)
--   terminal_failed_by  system identity of the worker that recorded it
--
-- They are the operator alert surface; see the module headers in
-- engine/src/scheduler-outbox.ts and engine/src/report-delivery.ts for the
-- documented alert queries.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.scheduler_outbox ADD COLUMN IF NOT EXISTS terminal_failed_at timestamp with time zone;
ALTER TABLE public.scheduler_outbox ADD COLUMN IF NOT EXISTS terminal_failed_by text;
ALTER TABLE public.report_runs ADD COLUMN IF NOT EXISTS terminal_failed_at timestamp with time zone;
ALTER TABLE public.report_runs ADD COLUMN IF NOT EXISTS terminal_failed_by text;
ALTER TABLE public.report_delivery_outbox ADD COLUMN IF NOT EXISTS terminal_failed_at timestamp with time zone;
ALTER TABLE public.report_delivery_outbox ADD COLUMN IF NOT EXISTS terminal_failed_by text;

CREATE INDEX IF NOT EXISTS scheduler_outbox_terminal_failed
  ON public.scheduler_outbox USING btree (terminal_failed_at)
  WHERE terminal_failed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_runs_terminal_failed
  ON public.report_runs USING btree (terminal_failed_at)
  WHERE terminal_failed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_delivery_outbox_terminal_failed
  ON public.report_delivery_outbox USING btree (terminal_failed_at)
  WHERE terminal_failed_at IS NOT NULL;

COMMENT ON COLUMN public.scheduler_outbox.terminal_failed_at IS
  'Set once when attempt_count reaches the retry ceiling: the row will never be retried again.';
COMMENT ON COLUMN public.scheduler_outbox.terminal_failed_by IS
  'System identity of the worker attempt that recorded the terminal failure.';
COMMENT ON COLUMN public.report_runs.terminal_failed_at IS
  'Set once when attempt_count reaches the retry ceiling: the run will never be retried again.';
COMMENT ON COLUMN public.report_runs.terminal_failed_by IS
  'System identity of the worker attempt that recorded the terminal failure.';
COMMENT ON COLUMN public.report_delivery_outbox.terminal_failed_at IS
  'Set once when the queue gave up and attempt_count reached the delivery ceiling: no further sends.';
COMMENT ON COLUMN public.report_delivery_outbox.terminal_failed_by IS
  'System identity of the worker attempt that recorded the terminal failure.';
