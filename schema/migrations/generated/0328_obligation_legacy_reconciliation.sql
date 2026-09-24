-- OpenBooks forward migration 0328_obligation_legacy_reconciliation.
--
-- 0297 stamped every pre-upgrade rule version 1, but the old writer edited
-- referenced rules in place — so an obligation's pinned row may be a later
-- policy, not the one the obligation was built under, and 0326 marked those
-- rules legacy-unverified. Rebuilding such an obligation would re-time its
-- existing schedule under the wrong policy while it looks version-pinned, so
-- the engine refuses destructive rebuilds of legacy-pinned obligations.
--
-- Reconciliation is per obligation, not per rule: two obligations can pin
-- the same legacy row while having been built under different policies (a
-- January straight-line schedule and a March point-in-time amendment under
-- one February edit), so clearing the rule would re-open the still-wrong
-- one. The operator verifies one obligation's existing schedule against the
-- policy actually in force when it was created, then records that
-- attestation here — actor, timestamp and reason, the audit minimum. The
-- rebuild refusal lifts for reconciled obligations only.
--
-- Staged build: adding the CHECK validated would scan every existing
-- obligation while holding the ALTER TABLE lock, blocking writers and
-- readers for the whole scan even though every old row trivially has all
-- three columns NULL (they are added by this same migration). The
-- constraint therefore arrives NOT VALID — a short lock that still
-- enforces every new write — and a later statement VALIDATEs it under
-- SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes. Both
-- steps are replay-safe: the ADD is guarded on pg_constraint and the
-- VALIDATE runs only while the constraint is unvalidated, so a retry
-- treats an already-validated guard as done. The end state is identical
-- to the validated build: the same constraint name, the same expression,
-- validated. No statement here needs CONCURRENTLY, so the file stays
-- inside the tracked transaction.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.performance_obligations
  ADD COLUMN IF NOT EXISTS legacy_reconciled_at timestamp with time zone;
ALTER TABLE public.performance_obligations
  ADD COLUMN IF NOT EXISTS legacy_reconciled_by uuid;
ALTER TABLE public.performance_obligations
  ADD COLUMN IF NOT EXISTS legacy_reconciliation_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.performance_obligations'::regclass
       AND conname = 'performance_obligations_legacy_reconciliation_shape'
  ) THEN
    ALTER TABLE public.performance_obligations
      ADD CONSTRAINT performance_obligations_legacy_reconciliation_shape
      CHECK (
        (
          legacy_reconciled_at IS NULL
          AND legacy_reconciled_by IS NULL
          AND legacy_reconciliation_reason IS NULL
        )
        OR (
          legacy_reconciled_at IS NOT NULL
          AND legacy_reconciled_by IS NOT NULL
          AND legacy_reconciliation_reason IS NOT NULL
          AND char_length(btrim(legacy_reconciliation_reason)) BETWEEN 5 AND 500
        )
      )
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.performance_obligations'::regclass
       AND conname = 'performance_obligations_legacy_reconciliation_shape'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.performance_obligations
      VALIDATE CONSTRAINT performance_obligations_legacy_reconciliation_shape;
  END IF;
END
$$;

COMMENT ON COLUMN public.performance_obligations.legacy_reconciled_at IS 'When the operator attested this obligation''s existing schedule against the policy actually in force at its creation, lifting the 0326 legacy-rebuild refusal (0328). NULL until reconciled.';
COMMENT ON COLUMN public.performance_obligations.legacy_reconciled_by IS 'Actor who recorded the legacy reconciliation (0328).';
COMMENT ON COLUMN public.performance_obligations.legacy_reconciliation_reason IS 'Why the operator trusts the existing schedule (e.g. the signed policy memo it was verified against). Required when reconciled (0328).';
