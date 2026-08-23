-- OpenBooks forward migration 0007_posting_effects_terminal_lifecycle.
--
-- Posting effects previously stopped being claimable at attempt eight while
-- remaining indistinguishable from a retryable failure. This migration gives
-- poison work an explicit lifecycle, durable reason/timestamps, an indexed
-- operator predicate, and append-only audit evidence for pre-existing rows.
-- Statements are defensive because bootstrap tracks immutable file digests.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.posting_effects
  ADD COLUMN IF NOT EXISTS terminal_failure_reason text,
  ADD COLUMN IF NOT EXISTS terminal_failed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS terminal_failed_by text;

ALTER TABLE public.posting_effects
  DROP CONSTRAINT IF EXISTS posting_effects_status;

ALTER TABLE public.posting_effects
  ADD CONSTRAINT posting_effects_status
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'running'::text,
    'succeeded'::text,
    'failed'::text,
    'terminal_failed'::text
  ]));

WITH terminalized AS (
  UPDATE public.posting_effects
     SET status = 'terminal_failed',
         terminal_failure_reason = coalesce(
           nullif(btrim(error), ''),
           'attempt ceiling reached before terminal lifecycle rollout'
         ),
         terminal_failed_at = coalesce(finished_at, updated_at, now()),
         terminal_failed_by = 'posting-effects-migration-0007',
         updated_at = now()
   WHERE status = 'failed'
     AND attempt_count >= 8
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
         'before', jsonb_build_object(
           'status', 'failed',
           'attemptCount', attempt_count
         ),
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
       'posting_effects_terminal_failure_migration',
       terminal_failed_at
  FROM terminalized;

ALTER TABLE public.posting_effects
  DROP CONSTRAINT IF EXISTS posting_effects_terminal_evidence;

ALTER TABLE public.posting_effects
  ADD CONSTRAINT posting_effects_terminal_evidence
  CHECK (
    (
      status = 'terminal_failed'
      AND terminal_failure_reason IS NOT NULL
      AND length(btrim(terminal_failure_reason)) > 0
      AND terminal_failed_at IS NOT NULL
      AND terminal_failed_by IS NOT NULL
    )
    OR status <> 'terminal_failed'
  );

CREATE INDEX IF NOT EXISTS posting_effects_terminal_failed
  ON public.posting_effects USING btree (terminal_failed_at)
  WHERE status = 'terminal_failed';

COMMENT ON COLUMN public.posting_effects.terminal_failure_reason IS
  'Durable final error recorded when the posting effect exhausts its attempt ceiling.';
COMMENT ON COLUMN public.posting_effects.terminal_failed_at IS
  'Timestamp of the explicit transition to terminal_failed; null while retryable.';
COMMENT ON COLUMN public.posting_effects.terminal_failed_by IS
  'Worker or migration identity that recorded the terminal transition.';
