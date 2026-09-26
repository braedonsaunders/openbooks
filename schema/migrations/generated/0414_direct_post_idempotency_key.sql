-- OpenBooks forward migration 0414_direct_post_idempotency_key.
--
-- postEntry stamps its idempotencyKey into journal_entries.custom and used
-- to arbitrate retries with an organization row lock plus check-then-insert.
-- That lock serialized every idempotent post onto one row, and it still
-- raced: two identical keys slipping past the read together posted twice.
-- A partial unique index on (org_id, custom->>'idempotencyKey') makes the
-- key itself the arbiter — a conflicting retry reads back the winner —
-- so the lock can go and concurrent retries converge on exactly one entry.
--
-- Partial (only rows carrying a key are indexed), so non-keyed postings are
-- untouched: no backfill, no behavior change for existing entries.
--
-- Staged build (U-staging): journal_entries is a hot transactional table,
-- so this file declares `-- openbooks: no-transaction` and the runner
-- executes it statement by statement with a bounded session lock_timeout.
-- The contract that makes a mid-file failure retry-safe: the duplicate
-- precheck below refuses before anything is built, the DO block drops this
-- file's own INVALID index — a failed CONCURRENTLY build leaves one behind,
-- and IF NOT EXISTS below would then skip the name forever, silently
-- keeping the missing index — and the index build itself is idempotent
-- (IF NOT EXISTS).
--
-- This file carries no lock_timeout of its own (refused for ordinals above
-- 0251 by check-migration-headers); the runner's bound governs.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Refuse the upgrade while duplicate keys exist: the index build below
-- would fail on them with a raw driver error, so name them here instead.
DO $precheck$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(format('org %s key %s (x%s)', org_id, k, n), '; ') INTO dupes
    FROM (
      SELECT org_id, custom->>'idempotencyKey' AS k, count(*) AS n
        FROM public.journal_entries
       WHERE custom ? 'idempotencyKey'
       GROUP BY org_id, custom->>'idempotencyKey'
      HAVING count(*) > 1
       LIMIT 5
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION '0414 refused: journal_entries holds duplicate direct-post idempotency keys: %; give each entry its own key before this index can be installed', dupes;
  END IF;
END;
$precheck$;

-- Retry safety: drop our own INVALID index before rebuilding. A failed
-- CONCURRENTLY build leaves the name present but unusable, and IF NOT
-- EXISTS below would then skip it forever. Plain (non-concurrent) DROP
-- inside the DO block is safe: an INVALID index answers no query, so its
-- brief exclusive lock contends with nothing.
DO $$
DECLARE
  idx text;
BEGIN
  FOR idx IN
    SELECT c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid
       AND c.relname IN (
         'journal_entries_org_idempotency_key'
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

-- The key lives in custom (stamped by postEntry), so the index is an
-- expression index; the predicate keeps every non-keyed entry out of it.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS journal_entries_org_idempotency_key
  ON public.journal_entries (org_id, (custom->>'idempotencyKey'))
  WHERE custom ? 'idempotencyKey';
