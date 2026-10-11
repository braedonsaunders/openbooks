-- OpenBooks forward migration 0672_subscription_plan_change_amendment.
--
-- A contract subscription can switch to a published version of another plan.
-- The amendment ledger admits that amendment type. The check is widened only:
-- every existing amendment row already satisfies the wider check.
--
-- Backfill: none.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.subscription_amendments DROP CONSTRAINT IF EXISTS subscription_amendments_type_chk;
ALTER TABLE public.subscription_amendments ADD CONSTRAINT subscription_amendments_type_chk
  CHECK (amendment_type = ANY (ARRAY['add_component'::text, 'remove_component'::text, 'change_component'::text, 'change_term'::text, 'change_timing'::text, 'renew'::text, 'coterm'::text, 'change_plan'::text]));
