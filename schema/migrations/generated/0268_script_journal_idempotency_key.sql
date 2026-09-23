-- OpenBooks forward migration 0268_script_journal_idempotency_key.
--
-- A script host write that outlives its run deadline could commit after the
-- host already reported a timeout, and a retry then posted a second numbered
-- journal: user scripting had no idempotency key. documents gains a nullable
-- idempotency_key carrying the script run's stable write identity
-- (run namespace + journal.create call ordinal); the ledger write inserts
-- with ON CONFLICT DO NOTHING on this key and returns the existing row, so a
-- retry observes the first execution's document instead of posting a duplicate.
--
-- The key is NULL for every non-script write path, and the unique index is
-- partial (key IS NOT NULL) so those rows are unaffected: no backfill, no
-- behavioral change for existing documents.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Partial: only script writes carry a key. Concurrent identical retries
-- serialize here; the loser reads the winner's row (see
-- engine/src/ledger/journal-writes.ts).
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_idempotency_key
  ON documents (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
