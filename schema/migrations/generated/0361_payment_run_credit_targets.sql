-- OpenBooks forward migration 0361_payment_run_credit_targets.
-- Preserve every credit source/target/amount in the approved payment-run plan.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.payment_run_items
  ADD COLUMN credit_target_allocations jsonb;

ALTER TABLE public.payment_run_items
  ADD CONSTRAINT payment_run_items_credit_targets_array
  CHECK (credit_target_allocations IS NULL OR jsonb_typeof(credit_target_allocations) = 'array');

COMMENT ON COLUMN public.payment_run_items.credit_target_allocations IS
  'For credit items, the exact target open-line IDs and amounts committed when the run was planned; null on non-credit and pre-migration items.';

SELECT public.openbooks_refresh_query_catalog();
