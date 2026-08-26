-- OpenBooks forward migration 0057_close_automation_claim_lease.
--
-- runCloseAutomations claimed a unique (rule_id, event_key) execution row with
-- status='running' and only marked it completed (or failed) after all of the
-- rule's effects had been produced by later independent statements. A crash
-- after that claim left the row running forever: every future firing of the
-- same event hit ON CONFLICT DO NOTHING, treated the permanent 'running' row
-- as already done, and skipped — so one crash froze partial effects (half-sent
-- notifications, orphaned evidence rows) for good, with no lease, no stale
-- recovery, and no per-effect idempotency.
--
-- This gives the close-automation claim the same lease/fencing contract as the
-- scheduler outbox and posting effects (migration 0052), plus per-effect stage
-- checkpoints so a recovered attempt finishes exactly once:
--
--   lease_token   — random per-claim fencing token. Takeover reclaims a row
--                   with compare-and-set over the stored token, so two
--                   recovering workers race cleanly; every effect checkpoint
--                   and terminal transition must match the active token, so an
--                   abandoned attempt cannot corrupt the outcome taken over by
--                   its replacement.
--   locked_at     — when the active claim took the row. Claims older than the
--                   runner's staleness window are takeover-eligible; NULL means
--                   pre-migration (immediately eligible).
--   attempt_count — how many claims this execution has served (initial plus
--                   recoveries). Observability for crash loops; not a ceiling,
--                   because unlike retryable queue work this row is once-ever
--                   per event: ceiling-stamping it terminal would freeze the
--                   automation forever, which is exactly the defect this fixes.
--   stages        — per-effect completion checkpoints. Each non-idempotent unit
--                   effect (one notification insert, one evidence insert)
--                   commits IN THE SAME TRANSACTION as its stage key, so a
--                   resumed attempt skips effects the crashed attempt already
--                   committed instead of duplicating them — storage-enforced
--                   exactly-once across crashes.
--
-- Legacy stuck 'running' rows keep their status (NULL token/lock): they stop
-- blocking future runs immediately, because the takeover path reclaims them on
-- the next firing of their event and their recovered effects converge on once.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.close_automation_executions
  ADD COLUMN IF NOT EXISTS lease_token uuid;

ALTER TABLE public.close_automation_executions
  ADD COLUMN IF NOT EXISTS locked_at timestamp with time zone;

ALTER TABLE public.close_automation_executions
  ADD COLUMN IF NOT EXISTS attempt_count integer DEFAULT 0 NOT NULL;

ALTER TABLE public.close_automation_executions
  ADD COLUMN IF NOT EXISTS stages jsonb DEFAULT '{}'::jsonb NOT NULL;

CREATE INDEX IF NOT EXISTS close_automation_executions_stale_claims
  ON public.close_automation_executions USING btree (org_id, locked_at)
 WHERE status = 'running';

COMMENT ON COLUMN public.close_automation_executions.lease_token IS
  'Random per-claim fencing token; effect checkpoints and terminal transitions must match the active running claim.';
COMMENT ON COLUMN public.close_automation_executions.locked_at IS
  'When the active claim took the execution row; claims older than the stale window are reclaimed by the next firing.';
COMMENT ON COLUMN public.close_automation_executions.attempt_count IS
  'Number of claims this execution has served (initial attempt plus crash recoveries); observability, not a retry ceiling.';
COMMENT ON COLUMN public.close_automation_executions.stages IS
  'Per-effect completion checkpoints; each non-idempotent unit effect commits in the same transaction as its stage key so a resumed attempt converges on exactly once.';
