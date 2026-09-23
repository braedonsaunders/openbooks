-- OpenBooks forward migration 0267_dsar_export_claim_lease.
--
-- The DSAR worker drained its queue with SELECT ... FOR UPDATE SKIP LOCKED
-- inside a transaction that committed WITHOUT marking the row claimed: the
-- row stayed 'queued', so a second worker claimed the same export, both
-- built the zip, and the loser's conditional ready-UPDATE matched zero rows
-- and threw — then failExport unconditionally flipped the WINNER's ready
-- export to failed. A ready export died because a loser raced it.
--
-- This gives the claim the same lease/fencing contract as the other durable
-- queues (0052, 0057): the claim is one atomic UPDATE to status='building'
-- carrying a random per-claim owner token (claimed_by), the claim instant
-- (claimed_at), and a lease expiry (lease_expires_at, 10 minutes — well over
-- a zip build). Only the claim owner may mark ready or failed, and the fail
-- path only ever touches 'building' rows it owns, so it can never overwrite
-- a ready/delivered export. A worker that crashes mid-build leaves a
-- 'building' row whose lease lapses; the next drain reclaims expired leases
-- (requested_at order is kept, so recovery is oldest-first like the queue).
--
-- Re-runnable: only DDL plus a backfill-free column add (all existing rows
-- keep their status; only 'building' rows use the new columns, and none can
-- exist before this migration). A second run changes nothing.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.hrm_data_subject_exports
  ADD COLUMN IF NOT EXISTS claimed_by uuid;
ALTER TABLE public.hrm_data_subject_exports
  ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone;
ALTER TABLE public.hrm_data_subject_exports
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp with time zone;

-- The claim is the only writer of 'building': a building row without an
-- owner and a lease is a half-claim, refused rather than left ambiguous.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_data_subject_exports_claim') THEN
    ALTER TABLE public.hrm_data_subject_exports
      ADD CONSTRAINT hrm_data_subject_exports_claim CHECK (
        status <> 'building' OR (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
      );
  END IF;
END $$;

-- Widen the status check to the claimed state (full set restated so the
-- constraint reads standalone; 0273 restates it again with 'incomplete').
ALTER TABLE public.hrm_data_subject_exports DROP CONSTRAINT IF EXISTS hrm_data_subject_exports_status;
ALTER TABLE public.hrm_data_subject_exports
  ADD CONSTRAINT hrm_data_subject_exports_status CHECK (
    status IN ('queued', 'building', 'ready', 'delivered', 'failed')
  );

-- The drain filters (org_id, status/lease): keep the claim SELECT on an
-- index in both its shapes — queued, and building-with-lapsed-lease.
CREATE INDEX IF NOT EXISTS hrm_data_subject_exports_building_lease
  ON public.hrm_data_subject_exports (org_id, lease_expires_at)
  WHERE status = 'building';
