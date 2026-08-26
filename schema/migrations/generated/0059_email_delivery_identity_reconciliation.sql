-- OpenBooks forward migration 0059_email_delivery_identity_reconciliation.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Audit finding #52: a BullMQ jobId alone cannot prevent a duplicate email.
-- Once a provider has accepted a message, the queue retry caused by a client
-- timeout / crash / failed DB mark used to hand the identical message to the
-- provider again, because nothing linked the attempts of one logical delivery.
--
-- This migration gives email_log that link:
--
--   delivery_key — one stable identity per LOGICAL delivery (org + durable
--     job/scope + recipient mailbox), derived deterministically by
--     packages/emails so every attempt recomputes the same value after any
--     crash. It is what provider idempotency keys (Resend), SMTP Message-IDs,
--     and audit headers are built from. Unique when present: concurrent
--     attempts claim exactly one canonical row (INSERT ... ON CONFLICT).
--
--     Historical rows keep delivery_key NULL and stay outside the lineage
--     system; this migration never guesses an identity for mail it cannot
--     prove anything about.
--
--   status 'uncertain' — parking state for an attempt that ended without
--     provable acceptance (timeout mid-flight, confirmation lost). The worker
--     refuses to transmit again while any attempt of a delivery is uncertain;
--     `sent`, `failed`, `suppressed`, and now `uncertain` therefore describe
--     everything an operator needs to reconcile without re-sending.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.email_log
  ADD COLUMN IF NOT EXISTS delivery_key text;

CREATE UNIQUE INDEX IF NOT EXISTS email_log_delivery_key
  ON public.email_log USING btree (delivery_key)
  WHERE delivery_key IS NOT NULL;

COMMENT ON COLUMN public.email_log.delivery_key IS
  'Stable identity shared by every attempt of one logical email delivery (obem_<sha256>); unique when known so retries claim one canonical row.';
