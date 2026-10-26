-- Let a connector decide how a source transaction dated outside its source posting period is mirrored.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Some sources accept a transaction whose date lies outside the posting
-- period it names; the period alone decides where its ledger impact lands.
-- 'refuse' keeps such a transaction out of the mirror until the source
-- corrects it. 'period_boundary' posts it on the period date nearest the
-- source date, keeps the source date as the document date and records both.
-- Every existing connection refuses, so no mirrored posting changes meaning.
ALTER TABLE public.connections
  ADD COLUMN out_of_period_date_policy text NOT NULL DEFAULT 'refuse';

ALTER TABLE public.connections
  ADD CONSTRAINT connections_out_of_period_date_policy_check
  CHECK (out_of_period_date_policy IN ('refuse', 'period_boundary'));

COMMENT ON COLUMN public.connections.out_of_period_date_policy IS 'How a source transaction dated outside its source posting period is mirrored: refuse it, or post it on the nearest date of that period with the source date kept as the document date.';
