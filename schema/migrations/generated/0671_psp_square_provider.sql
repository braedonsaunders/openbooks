-- OpenBooks forward migration 0671_psp_square_provider.
--
-- Square joins the payment-provider settlement set, so its payouts, fees and
-- refunds import as provider settlements like the other processors. Both
-- provider checks are widened only: every existing row satisfies the new
-- check exactly as it satisfied the old one.
--
-- Backfill: none.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.psp_provider_configs DROP CONSTRAINT IF EXISTS psp_provider_configs_provider_chk;
ALTER TABLE public.psp_provider_configs ADD CONSTRAINT psp_provider_configs_provider_chk
  CHECK (provider = ANY (ARRAY['stripe'::text, 'adyen'::text, 'gocardless'::text, 'recurly'::text, 'chargebee'::text, 'shopify_payments'::text, 'paypal'::text, 'square'::text]));

ALTER TABLE public.psp_settlement_batches DROP CONSTRAINT IF EXISTS psp_settlement_batches_provider_chk;
ALTER TABLE public.psp_settlement_batches ADD CONSTRAINT psp_settlement_batches_provider_chk
  CHECK (provider = ANY (ARRAY['stripe'::text, 'adyen'::text, 'gocardless'::text, 'recurly'::text, 'chargebee'::text, 'shopify_payments'::text, 'paypal'::text, 'square'::text]));
