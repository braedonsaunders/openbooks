-- OpenBooks forward migration 0015_payment_instruction_posting_claim_fence.
--
-- The posting claim on payment_runs fenced the worker that held it, but only
-- by convention: every downstream instruction write had to remember to check
-- the token itself, and a superseded posting worker (its claim recovered or
-- retired by another lifecycle path) could still mutate instructions after
-- losing authority. Instructions now enforce the claim at the storage layer —
-- while their run is `processing`, a writer must present the run's CURRENT
-- lease via the transaction-local `openbooks.payment_run_claim` setting
-- (`<runId>:<postingClaimToken>`) or its mutation is rejected, with one
-- carve-out: settlement-style lifecycle retreats (`settled`, `returned`,
-- `rejected`) stay available to the bank-outcome writer, which serializes on
-- the run row in the same lock order as posting.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.enforce_payment_instruction_posting_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_token uuid;
  subject_id uuid;
BEGIN
  subject_id := COALESCE(NEW.id, OLD.id);

  -- Sandbox teardown destroys scratch data wholesale; it never posts, and it
  -- must remain able to remove rows regardless of leftover claim state.
  IF COALESCE(current_setting('openbooks.sandbox_wipe', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT r.status, r.posting_claim_token
    INTO run_status, run_token
    FROM public.payment_runs r
   WHERE r.id = COALESCE(NEW.payment_run_id, OLD.payment_run_id)
     AND r.org_id = COALESCE(NEW.org_id, OLD.org_id);
  IF NOT FOUND THEN
    -- Orphaned rows are the foreign key's problem, not ours.
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Only a claimed (`processing`) run restricts writers: creation, cancellation,
  -- and terminal-state settlement mutate instructions of unclaimed runs freely.
  IF run_status <> 'processing' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The live claim holder presents the run's current token for this transaction.
  IF run_token IS NOT NULL
     AND current_setting('openbooks.payment_run_claim', true)
         = COALESCE(NEW.payment_run_id, OLD.payment_run_id)::text || ':' || run_token::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Without the live claim, only a settlement-style retreat may move a row.
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IN ('settled', 'returned', 'rejected') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'payment instruction ' || subject_id::text ||
              ' belongs to a processing payment run; only the current posting claim may mutate it',
    DETAIL = 'Present the live lease as openbooks.payment_run_claim = <runId>:<postingClaimToken> '
             || 'inside the writing transaction.',
    HINT = 'The claim was recovered, retired, or never taken; re-claim the run before writing its instructions.';
END;
$$;

DROP TRIGGER IF EXISTS payment_instructions_posting_claim_fence ON public.payment_instructions;
CREATE TRIGGER payment_instructions_posting_claim_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.payment_instructions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_instruction_posting_claim();

COMMENT ON FUNCTION public.enforce_payment_instruction_posting_claim() IS
  'Rejects payment-instruction mutations on a processing run unless the writing transaction presents that run''s current posting-claim token via openbooks.payment_run_claim; settlement-style lifecycle retreats (settled/returned/rejected) remain open to the bank-outcome writer.';
COMMENT ON TRIGGER payment_instructions_posting_claim_fence ON public.payment_instructions IS
  'Storage-enforced half of the posting-claim fence: a superseded posting worker cannot mutate instructions after losing authority (see migration 0012, which introduced the lease).';
