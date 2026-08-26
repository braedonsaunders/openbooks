-- OpenBooks forward migration 0008_durable_work_lease_fencing.
--
-- A recovered stale worker may still be alive. Per-claim random lease tokens
-- let the replacement attempt fence that worker: completion is valid only for
-- the token currently stored on a running row. Existing running claims are
-- invalidated during rollout so no pre-token attempt can complete afterward.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.posting_effects
  ADD COLUMN IF NOT EXISTS lease_token uuid;

WITH invalidated AS (
  UPDATE public.posting_effects
     SET status = CASE WHEN attempt_count >= 8 THEN 'terminal_failed' ELSE 'failed' END,
         error = 'worker claim invalidated during lease-fencing rollout',
         locked_at = NULL,
         lease_token = NULL,
         finished_at = now(),
         next_attempt_at = now(),
         terminal_failure_reason = CASE WHEN attempt_count >= 8
           THEN 'worker claim invalidated at the attempt ceiling during lease-fencing rollout'
           ELSE terminal_failure_reason END,
         terminal_failed_at = CASE WHEN attempt_count >= 8
           THEN coalesce(terminal_failed_at, now()) ELSE terminal_failed_at END,
         terminal_failed_by = CASE WHEN attempt_count >= 8 AND terminal_failed_at IS NULL
           THEN 'posting-effects-migration-0008' ELSE terminal_failed_by END,
         updated_at = now()
   WHERE status = 'running'
   RETURNING id, org_id, document_id, kind, attempt_count,
             terminal_failure_reason, terminal_failed_at, terminal_failed_by
)
INSERT INTO public.audit_log
  (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
SELECT org_id,
       'posting_effects',
       id,
       'update',
       jsonb_build_object(
         'event', 'posting_effects_terminal_failure_migrated',
         'before', jsonb_build_object('status', 'running', 'attemptCount', attempt_count),
         'after', jsonb_build_object(
           'status', 'terminal_failed',
           'attemptCount', attempt_count,
           'reason', terminal_failure_reason,
           'terminalFailedAt', terminal_failed_at,
           'terminalFailedBy', terminal_failed_by
         ),
         'documentId', document_id,
         'kind', kind
       ),
       NULL,
       'posting_effects_lease_fencing_migration',
       terminal_failed_at
  FROM invalidated
 WHERE attempt_count >= 8;

ALTER TABLE public.scheduler_outbox
  ADD COLUMN IF NOT EXISTS lease_token uuid;

UPDATE public.scheduler_outbox
   SET status = 'failed',
       error = 'worker claim invalidated during lease-fencing rollout',
       locked_at = NULL,
       lease_token = NULL,
       finished_at = now(),
       next_attempt_at = now(),
       terminal_failed_at = CASE WHEN attempt_count >= 8
         THEN coalesce(terminal_failed_at, now()) ELSE terminal_failed_at END,
       terminal_failed_by = CASE WHEN attempt_count >= 8 AND terminal_failed_at IS NULL
         THEN 'scheduler-outbox-migration-0008' ELSE terminal_failed_by END,
       updated_at = now()
 WHERE status = 'running';

COMMENT ON COLUMN public.posting_effects.lease_token IS
  'Random per-claim fencing token; success/failure updates must match the active running claim.';
COMMENT ON COLUMN public.scheduler_outbox.lease_token IS
  'Random per-claim fencing token; success/failure updates must match the active running claim.';
