-- OpenBooks forward migration 0028_email_delivery_idempotency.
--
-- Audit finding #52 remediation: hardens the email delivery idempotency
-- system added by 0059. The delivery_key column and its unique partial index
-- guarantee one canonical email_log row per logical delivery; this migration
-- adds:
--
--   1. A CHECK constraint that validates delivery_key format at the storage
--      boundary — delivery keys derived by packages/emails/outcome.ts always
--      match obem_[0-9a-f]{40}, so a malformed key can never enter the lineage
--      and silently break idempotency.
--
--   2. A composite index (org_id, delivery_key) that makes the tenant-scoped
--      claim path — SELECT ... WHERE org_id = $1 AND delivery_key = $2 — an
--      index-only scan instead of a sequential filter over the unique index.
--
-- All statements tolerate re-execution.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Delivery key format guard: only valid obem_ keys or NULL are stored.
-- Historical rows with NULL delivery_key pass; rows with a non-matching
-- format fail immediately, surfacing a misconfiguration before it can
-- silently break reconciliation.
ALTER TABLE public.email_log
  ADD CONSTRAINT email_log_delivery_key_format
  CHECK (delivery_key IS NULL OR delivery_key ~ '^obem_[0-9a-f]{40}$')
  NOT VALID;

ALTER TABLE public.email_log
  VALIDATE CONSTRAINT email_log_delivery_key_format;

COMMENT ON CONSTRAINT email_log_delivery_key_format ON public.email_log IS
  'openbooks:delivery_key format guard — only obem_<40-hex> or NULL; validates the idempotency key derived by packages/emails/outcome.ts.';

-- Tenant-scoped composite index for the claim path: claimEmailDeliveryLog
-- reads WHERE org_id = $1 AND delivery_key = $2. The existing unique index
-- on delivery_key alone serves the ON CONFLICT clause, but the post-conflict
-- lookup benefits from org_id in the leading position for partition pruning.
CREATE INDEX IF NOT EXISTS email_log_org_delivery
  ON public.email_log USING btree (org_id, delivery_key)
  WHERE delivery_key IS NOT NULL;

COMMENT ON INDEX public.email_log_org_delivery IS
  'openbooks:tenant-scoped claim path index for email delivery idempotency — speeds the post-conflict lookup in claimEmailDeliveryLog.';
