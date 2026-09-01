-- OpenBooks forward migration 0080_payment_instruction_claim_fence_bundle_guard.
--
-- Migration 0015 is published and immutable. Its settlement-style carve-out
-- accepts any UPDATE that changes status to settled, returned, or rejected,
-- which lets a writer without the live posting claim bundle a status retreat
-- with changes to the amount, run, bank account, payment document, or any
-- other protected instruction field. Replace only the trigger function here:
-- a claim-less lifecycle retreat is valid only when status and the normal audit
-- stamps changed; every other field must remain byte-for-byte equivalent in
-- PostgreSQL's row JSON representation.
--
-- CREATE OR REPLACE plus DROP/CREATE keeps this forward migration safe to replay
-- inside a bootstrap transaction while preserving the published 0015 body.

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
  -- must remain able to remove rows regardless of leftover claim state. The
  -- canonical helper checks both the caller's teardown GUC and the tenant's
  -- sandbox classification; a raw session setting is never authority, and
  -- INSERT/UPDATE must continue through the claim fence.
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
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

  -- Without the live claim, only a settlement-style retreat may move a row,
  -- and it may change only status plus the normal audit stamps. This comparison
  -- deliberately covers every other current and future instruction column,
  -- including amount, payment_run_id, payee_bank_account_id, and
  -- payment_document_id.
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IN ('settled', 'returned', 'rejected')
     AND (to_jsonb(NEW) - 'status' - 'updated_at' - 'updated_by')
         = (to_jsonb(OLD) - 'status' - 'updated_at' - 'updated_by') THEN
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
  'Rejects payment-instruction mutations on a processing run unless the writing transaction presents that run''s current posting-claim token via openbooks.payment_run_claim; settlement-style lifecycle retreats (settled/returned/rejected) remain open to the bank-outcome writer only when every other instruction field is unchanged.';
COMMENT ON TRIGGER payment_instructions_posting_claim_fence ON public.payment_instructions IS
  'Storage-enforced half of the posting-claim fence: a superseded posting worker cannot mutate instructions after losing authority (see migrations 0012 and 0080).';
