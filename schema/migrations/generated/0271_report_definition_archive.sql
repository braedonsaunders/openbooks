-- OpenBooks forward migration 0271_report_definition_archive.
--
-- Deleting a saved report definition destroyed its history: report_runs
-- references report_definitions ON DELETE CASCADE, and report_run_artifacts
-- (plus the delivery outbox) cascade off report_runs — so one DELETE wiped
-- every scheduled materialization, its CSV evidence and its immutable PDF
-- artifacts, leaving only an audit row holding counts of what was lost.
-- History must survive the definition: deletion becomes an archive
-- (archived_at/archived_by), lists and execution paths ignore archived rows,
-- schedules stop, and the foreign keys move off CASCADE to RESTRICT so no
-- future hard delete can silently cascade again.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- The archive stamp. NULL = live; set = hidden from lists, unrunnable, and
-- unschedulable, while runs and artifacts keep their parent row.
ALTER TABLE public.report_definitions
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;
ALTER TABLE public.report_definitions
  ADD COLUMN IF NOT EXISTS archived_by uuid;

COMMENT ON COLUMN public.report_definitions.archived_at IS
  'Soft-delete: set when the definition was archived. Archived definitions are hidden from lists, refuse execution and scheduling, and stop their schedules — but their runs and artifacts are retained.';
COMMENT ON COLUMN public.report_definitions.archived_by IS
  'User who archived the definition.';

-- Runs reference a NOT NULL definition: RESTRICT keeps the detach
-- explicit — a hard delete with surviving runs fails instead of cascading.
ALTER TABLE public.report_runs
  DROP CONSTRAINT IF EXISTS report_runs_definition_id_fkey;
ALTER TABLE public.report_runs
  ADD CONSTRAINT report_runs_definition_id_fkey
  FOREIGN KEY (definition_id) REFERENCES public.report_definitions(id)
  ON DELETE RESTRICT DEFERRABLE;

-- Schedules reference a NOT NULL definition: same treatment. Archiving
-- itself deactivates the schedules; this only backstops a hard delete.
ALTER TABLE public.report_schedules
  DROP CONSTRAINT IF EXISTS report_schedules_definition_id_fkey;
ALTER TABLE public.report_schedules
  ADD CONSTRAINT report_schedules_definition_id_fkey
  FOREIGN KEY (definition_id) REFERENCES public.report_definitions(id)
  ON DELETE RESTRICT DEFERRABLE;

-- Live-list index: the catalog and execution paths read "mine and not
-- archived" on every call.
CREATE INDEX IF NOT EXISTS report_definitions_org_live
  ON public.report_definitions (org_id) WHERE archived_at IS NULL;
