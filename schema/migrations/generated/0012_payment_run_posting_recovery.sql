-- OpenBooks forward migration 0012_payment_run_posting_recovery.
--
-- Posting a payment run used to be indistinguishable from any other status
-- flip: a worker that died mid-run left the run in `processing` forever, and a
-- second poster could interleave instructions with the first one's retries.
-- Runs now carry an explicit per-claim posting lease — a random token plus who
-- claimed it and when they last made progress — so completion is valid only
-- for the token currently stored on the run and a stale claim can be safely
-- taken over instead of stranding the run.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.payment_runs
  ADD COLUMN IF NOT EXISTS posting_claim_token uuid,
  ADD COLUMN IF NOT EXISTS posting_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS posting_claimed_by uuid;

-- Pre-token deployments never wrote `processing` themselves, so any row found
-- here is a stranded claim with no live owner. Release it to the resumable
-- partially-failed state: sent instructions stay sent, pending instructions
-- stay pending, and the next posting attempt claims the run fresh. The event
-- carries no actor — the worker that abandoned the claim is unknown.
WITH released AS (
  UPDATE public.payment_runs
     SET status = 'partially_failed',
         posting_claim_token = null,
         posting_claimed_at = null,
         posting_claimed_by = null,
         updated_at = now()
   WHERE status = 'processing'
   RETURNING id, org_id
)
INSERT INTO public.payment_events
  (org_id, payment_run_id, event_type, from_status, to_status, details, actor_id)
SELECT org_id,
       id,
       'run_posting_recovered',
       'processing',
       'partially_failed',
       jsonb_build_object(
         'reason', 'posting claim invalidated during posting-recovery rollout'
       ),
       NULL
  FROM released;

COMMENT ON COLUMN public.payment_runs.posting_claim_token IS
  'Random per-claim posting lease; instruction and completion writes must match the token currently stored on the run.';
COMMENT ON COLUMN public.payment_runs.posting_claimed_at IS
  'When the current posting claim was taken or last made progress; a claim older than the staleness window may be recovered by a new poster.';
COMMENT ON COLUMN public.payment_runs.posting_claimed_by IS
  'User that took the current posting claim.';

-- Recovery sweeps and operational dashboards look for exactly these rows.
CREATE INDEX payment_runs_posting_claims
  ON public.payment_runs (org_id, posting_claimed_at)
  WHERE status = 'processing';
