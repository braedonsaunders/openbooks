-- OpenBooks forward migration 0144_psp_settlement_adjustments.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- PSP settlement batches had no representation for provider adjustments. The
-- Chargebee adapter validated amount_adjusted for exactness and then dropped
-- it, so a partially-collected invoice booked its full billed total as
-- received; folding adjustments into the refund leg instead would pollute
-- refund metrics with write-offs and credit-note applications, which are
-- distinct business events with distinct audit needs. This migration gives
-- adjustments their own leg kind and their own batch total:
--
--   psp_settlement_lines.kind  gains 'adjustment' (widening accepts every row
--     the table can already contain, so validation is a no-op scan)
--   psp_settlement_batches.adjustment_amount  provider adjustments in
--     settlement currency, deducted from net like refunds (DEFAULT 0, so
--     existing batches read back exactly as before)
--
-- Additive, ledger-tracked, no history reinterpretation. See the settlement
-- contract in engine/src/psp-settlement.ts.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.psp_settlement_batches
  ADD COLUMN IF NOT EXISTS adjustment_amount numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.psp_settlement_batches.adjustment_amount IS
  'Provider adjustments (e.g. Chargebee amount_adjusted) in settlement currency. Deducted from net like refunds but tracked separately so write-offs and credit-note applications never pollute refund metrics; zero on every batch imported before migration 0144.';

ALTER TABLE public.psp_settlement_lines
  DROP CONSTRAINT IF EXISTS psp_settlement_lines_kind_chk;
ALTER TABLE public.psp_settlement_lines
  ADD CONSTRAINT psp_settlement_lines_kind_chk
  CHECK (kind = ANY (ARRAY['charge'::text, 'refund'::text, 'fee'::text, 'dispute'::text, 'dispute_reversal'::text, 'adjustment'::text, 'fx_adjustment'::text, 'transfer'::text, 'other'::text])) NOT VALID;
ALTER TABLE public.psp_settlement_lines
  VALIDATE CONSTRAINT psp_settlement_lines_kind_chk;
