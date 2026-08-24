-- OpenBooks forward migration 0010_bank_statement_source_idempotency.
--
-- ID-less statement lines cannot be deduplicated by their visible fields: two
-- real transactions may have the same date, amount, and description. Exact
-- source bytes, however, identify an import retry. Persist their SHA-256 per
-- account so PostgreSQL is the final authority for source-file idempotency.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.bank_statements
  ADD COLUMN IF NOT EXISTS source_file_sha256 text;

ALTER TABLE public.bank_statements
  DROP CONSTRAINT IF EXISTS bank_statements_source_file_sha256;
ALTER TABLE public.bank_statements
  ADD CONSTRAINT bank_statements_source_file_sha256
  CHECK (
    source_file_sha256 IS NULL
    OR source_file_sha256 ~ '^[0-9a-f]{64}$'
  );

-- Older imports may already contain exact retries. Claim one deterministic
-- representative for each account/hash; its presence is enough to suppress
-- future retries without deleting or rewriting historical statement lines.
WITH candidates AS (
  SELECT statement.id,
         statement.org_id,
         statement.account_id,
         substring(statement.raw_file_ref FROM '#sha256=([0-9a-f]{64})$') AS source_sha256,
         row_number() OVER (
           PARTITION BY statement.org_id,
                        statement.account_id,
                        substring(statement.raw_file_ref FROM '#sha256=([0-9a-f]{64})$')
           ORDER BY statement.imported_at, statement.id
         ) AS source_rank
    FROM public.bank_statements statement
   WHERE statement.source_file_sha256 IS NULL
     AND statement.raw_file_ref ~ '#sha256=[0-9a-f]{64}$'
)
UPDATE public.bank_statements statement
   SET source_file_sha256 = candidate.source_sha256
  FROM candidates candidate
 WHERE statement.id = candidate.id
   AND candidate.source_rank = 1
   AND NOT EXISTS (
     SELECT 1
       FROM public.bank_statements claimed
      WHERE claimed.org_id = candidate.org_id
        AND claimed.account_id = candidate.account_id
        AND claimed.source_file_sha256 = candidate.source_sha256
   );

CREATE UNIQUE INDEX IF NOT EXISTS bank_statements_org_account_source_sha256
  ON public.bank_statements USING btree (org_id, account_id, source_file_sha256)
  WHERE source_file_sha256 IS NOT NULL;

COMMENT ON COLUMN public.bank_statements.source_file_sha256 IS
  'SHA-256 of exact source bytes; unique per organization and bank account when known.';

-- bank_statements is an approved governed-query relation. Rebuild its frozen
-- SELECT * view so the new non-secret source identity is available there too.
SELECT public.openbooks_refresh_query_catalog();
