-- OpenBooks forward migration 0058_fx_provider_run_lease_fencing.
--
-- A worker whose fx_provider_runs claim is reclaimed after its lease lapses
-- may still be alive. Per-claim random lease tokens let the replacement
-- attempt fence that worker: rate application and completion/failure stamps
-- are valid only for the attempt that still holds the current running claim,
-- and a taken-over claim cannot resurrect its row or promote schedule
-- ownership. Existing running claims are invalidated during rollout so no
-- pre-token attempt can complete afterward.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.fx_provider_runs
  ADD COLUMN IF NOT EXISTS lease_token uuid;

UPDATE public.fx_provider_runs
   SET status = 'failed',
       error_message = 'run claim invalidated during lease-fencing rollout',
       finished_at = coalesce(finished_at, now()),
       lease_token = NULL
 WHERE status = 'running';

COMMENT ON COLUMN public.fx_provider_runs.lease_token IS
  'Random per-claim fencing token; rate application and success/failure updates must match the active running claim.';
