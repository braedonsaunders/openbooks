-- Autopay setup links: a public token per pending method plus the provider
-- setup URL the customer continues to. Both columns are nullable and
-- additive: existing method rows predate setup links and never need them.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- token_hash is the sha256 of the Bearer [REDACTED] (same handling as payment link
-- tokens): many rows share NULL, each issued token hashes uniquely.
ALTER TABLE public.customer_payment_methods
 ADD COLUMN token_hash text,
 ADD COLUMN setup_redirect_url text;
ALTER TABLE public.customer_payment_methods
 ADD CONSTRAINT customer_payment_methods_token_hash_uniq UNIQUE (token_hash);
