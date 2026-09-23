-- OpenBooks forward migration 0290_payment_file_delivery_claim.
--
-- SFTP delivery published a bank payment file before the authoritative
-- approval gate: deliverRunToSftp checked payment_files.status with a plain
-- SELECT, exposed the bytes on the SFTP endpoint, and only then recorded
-- the delivery in a transaction that re-checked approval. An approver
-- voiding, superseding, or rejecting the file (or a run rollback) between
-- the first SELECT and the write published a now-disallowed file while the
-- record call refused — no delivery evidence for bytes the bank could fetch.
--
-- The delivery claim this migration carries makes the publish safe:
-- payment_files gains a delivery lease (claim token, owner, expiry) plus
-- two lifecycle states. A delivery first claims the row (approved or a
-- live re-delivery from delivered) into 'delivering' under its row lock;
-- void, supersede, and reject paths lock the same row and refuse while a
-- claim is held. The bytes publish only under a valid claim and the record
-- step completes 'delivering' to 'delivered' conditional on the claim
-- token. A failed write releases the claim back to 'approved'; a failed
-- record after a successful write parks the file in 'delivery_uncertain'
-- (published bytes unconfirmed — re-delivery blocked, operator-visible),
-- never as undelivered. Expired leases are recoverable through the same
-- uncertain state by an explicit reclaim, never by silent re-publish.
-- Re-runnable: every statement is guarded by IF NOT EXISTS.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- delivery_claim_token is uuid (not text) like payment_runs.posting_claim_token
-- (0012): a fixed-shape random value the sandbox PII inventory does not
-- have to classify. delivery_claim_owner names the delivery attempt
-- ('sftp:<serverId>') and is allow-listed there as non-personal.
ALTER TABLE ONLY public.payment_files
  ADD COLUMN IF NOT EXISTS delivery_claim_token uuid,
  ADD COLUMN IF NOT EXISTS delivery_claim_owner text,
  ADD COLUMN IF NOT EXISTS delivery_claim_expires_at timestamp with time zone;

-- Reclaim scan: expired 'delivering' leases per org. Partial, so steady
-- state (no in-flight delivery) keeps the index empty.
CREATE INDEX IF NOT EXISTS payment_files_delivery_claim_expiry
  ON public.payment_files USING btree (org_id, delivery_claim_expires_at)
  WHERE status = 'delivering';
