-- OpenBooks forward migration 0647_bank_statement_governed_correction.
--
-- Unmatched statement lines correct amount, sign, date and description
-- through the match workspace, and untouched imports delete from the import
-- history for an honest re-import; both verbs hold their locks, recheck
-- their fences, and write before/after audit rows in one transaction. The
-- statement-line guard below predates those verbs and refuses every content
-- edit and delete unconditionally, so neither verb can run. This narrows
-- the two refusals to ungoverned writes: a transaction-scoped setting names
-- the line under correction or the import under deletion, set by the engine
-- inside the same transaction. The signed-off-evidence and match-evidence
-- checks further down still apply to governed writes.
--
-- Backfill: none. CREATE OR REPLACE on the guard function only — no schema,
-- data, or privilege change — so every existing row behaves as before until
-- a governed verb sets its marker.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.openbooks_bank_statement_line_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF tg_op = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(old.org_id) THEN
      RETURN old;
    END IF;
    -- Governed import deletion: the engine holds the account lock, rechecks
    -- the untouched-import fence, and writes the per-row and header audit in
    -- this same transaction.
    IF current_setting('app.statement_import_delete', true) = old.statement_id::text THEN
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
    -- Governed line correction: the engine holds the line lock, rechecks
    -- unmatched state and the signed-off cutoff, and writes the before/after
    -- audit row in this same transaction.
    IF current_setting('app.statement_correction_line', true) IS DISTINCT FROM old.id::text THEN
      RAISE EXCEPTION 'imported bank statement content is immutable';
    END IF;
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
