-- OpenBooks forward migration 0335_bank_statement_line_possible_duplicate.
--
-- ID-less statement lines used to import with a null bank_transaction_id
-- (the partial unique index never sees nulls), and briefly with a
-- deterministic content fingerprint whose per-batch occurrence ordinal made
-- a genuinely new same-day twin in a later file collide with an earlier
-- line and vanish. A content tuple is evidence of POSSIBLE overlap, not
-- identity: imports now auto-skip ID-less lines only on proven replay
-- evidence (same source hash, an overlapping statement window with matching
-- opening/closing balances, or a provider FITID) and otherwise import both
-- lines, flagging the later one as a possible duplicate of the earlier one
-- for review. The flag is a nullable self-reference carrying the evidence
-- (WHICH earlier line it may duplicate); flagged lines keep match_status
-- 'unmatched' so every existing review, match and sign-off surface keeps
-- seeing them, while auto-match and manual matching refuse them until the
-- reviewer clears the flag or excludes the line.
--
-- Staged build: bank_statement_lines is hot, so everything structural builds
-- concurrently. The tenant-coherent self-reference follows the
-- journal_entries_reverses_entry_id_fkey pattern: a backing
-- UNIQUE (org_id, id), the flag column, a sparse composite index for the
-- flag, and the foreign key arriving NOT VALID with a separate guarded
-- VALIDATE. CREATE INDEX CONCURRENTLY is refused inside a transaction
-- block, so this file declares `-- openbooks: no-transaction` and the
-- runner executes it statement by statement with a bounded session
-- lock_timeout. The contract that makes a mid-file failure retry-safe:
-- every statement is idempotent (IF NOT EXISTS throughout, the ADD
-- CONSTRAINT and VALIDATE guarded on pg_constraint), and the DO block up
-- front drops this file's own INVALID indexes — a failed CONCURRENTLY
-- build leaves one behind, and IF NOT EXISTS would otherwise skip the name
-- forever, silently keeping the missing index. Existing deterministic
-- synth-v1 fingerprints from the previous import policy are retained
-- as-is: they stay valid unique keys and scoped content matching reads
-- statement columns either way, so no backfill or repair runs here.

-- openbooks: no-transaction

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Retry safety: drop our own INVALID indexes before rebuilding.
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
         'bank_statement_lines_org_id_id_unique',
         'bsl_org_possible_duplicate'
       )
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', idx);
  END LOOP;
END
$$;

-- Backing key for the tenant-coherent self-reference.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS bank_statement_lines_org_id_id_unique
  ON public.bank_statement_lines USING btree (org_id, id);

ALTER TABLE public.bank_statement_lines
  ADD COLUMN IF NOT EXISTS possible_duplicate_of uuid;

-- The flag is review state, not imported content: the statement-line
-- immutability guard keeps refusing content edits while letting the review
-- lifecycle (set at import, cleared or kept through exclude/restore) move
-- this one column, exactly as it already does for match_status and the
-- exclusion evidence columns.
CREATE OR REPLACE FUNCTION public.openbooks_bank_statement_line_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(old.org_id) THEN
      RETURN old;
    END IF;
    RAISE EXCEPTION 'imported bank statement lines are immutable';
  END IF;
  IF tg_op = 'INSERT' THEN
    RETURN new;
  END IF;
  IF to_jsonb(new)
       - 'match_status' - 'exclusion_reason' - 'excluded_at' - 'excluded_by'
       - 'possible_duplicate_of'
       - 'updated_at' - 'updated_by'
     <> to_jsonb(old)
       - 'match_status' - 'exclusion_reason' - 'excluded_at' - 'excluded_by'
       - 'possible_duplicate_of'
       - 'updated_at' - 'updated_by' THEN
    RAISE EXCEPTION 'imported bank statement content is immutable';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM reconciliation_matches m
      JOIN reconciliations r ON r.id = m.reconciliation_id
     WHERE m.statement_line_id = old.id
       AND m.org_id = old.org_id
       AND r.status = 'signed_off'
  ) OR EXISTS (
    SELECT 1
      FROM reconciliations r
     WHERE r.org_id = old.org_id
       AND r.account_id = old.account_id
       AND r.currency = old.currency
       AND r.status = 'signed_off'
       AND r.through_date >= old.posted_on
       AND old.match_status = 'excluded'
  ) THEN
    RAISE EXCEPTION 'signed-off bank statement evidence is immutable';
  END IF;
  IF new.match_status = 'matched'
     AND NOT EXISTS (
       SELECT 1 FROM reconciliation_matches m
        WHERE m.statement_line_id = new.id AND m.org_id = new.org_id
     ) THEN
    RAISE EXCEPTION 'matched bank statement line requires reconciliation-match evidence';
  END IF;
  IF new.match_status <> 'matched'
     AND EXISTS (
       SELECT 1 FROM reconciliation_matches m
        WHERE m.statement_line_id = new.id AND m.org_id = new.org_id
     ) THEN
    RAISE EXCEPTION 'bank statement line with match evidence must remain matched';
  END IF;
  RETURN new;
END;
$$;

-- Sparse pointer: NULL-heavy tenants skip indexing their NULLs entirely.
CREATE INDEX CONCURRENTLY IF NOT EXISTS bsl_org_possible_duplicate
  ON public.bank_statement_lines USING btree (org_id, possible_duplicate_of)
  WHERE (possible_duplicate_of IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bank_statement_lines'::regclass
       AND conname = 'bank_statement_lines_possible_duplicate_of_fkey'
  ) THEN
    ALTER TABLE public.bank_statement_lines
      ADD CONSTRAINT bank_statement_lines_possible_duplicate_of_fkey
      FOREIGN KEY (org_id, possible_duplicate_of)
      REFERENCES public.bank_statement_lines (org_id, id)
      ON DELETE SET NULL
      DEFERRABLE
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bank_statement_lines'::regclass
       AND conname = 'bank_statement_lines_possible_duplicate_of_fkey'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.bank_statement_lines
      VALIDATE CONSTRAINT bank_statement_lines_possible_duplicate_of_fkey;
  END IF;
END
$$;
