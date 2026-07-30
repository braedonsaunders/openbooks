BEGIN;

-- Replace the legacy metadata carve-out with a one-way evidence transition.
-- The same definition lives in kernel-constraints.sql for zero-state
-- bootstrap; this migration upgrades already-running databases immediately.
CREATE OR REPLACE FUNCTION jl_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_org uuid;
  v_period uuid;
  v_book uuid;
BEGIN
  IF tg_op = 'DELETE' AND openbooks_sandbox_wipe_allowed(old.org_id) THEN
    RETURN old;
  END IF;
  SELECT status, org_id, period_id, book_id
    INTO v_status, v_org, v_period, v_book
    FROM journal_entries
   WHERE id = coalesce(new.entry_id, old.entry_id);
  IF v_status IS DISTINCT FROM 'draft' THEN
    IF tg_op = 'UPDATE'
       AND to_jsonb(new) - 'reconciled_at' - 'reconciliation_id'
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id' THEN
      IF new.reconciled_at IS NOT DISTINCT FROM old.reconciled_at
         AND new.reconciliation_id IS NOT DISTINCT FROM old.reconciliation_id THEN
        RETURN new;
      END IF;
      IF old.reconciled_at IS NULL
         AND old.reconciliation_id IS NULL
         AND new.reconciled_at IS NOT NULL
         AND new.reconciliation_id IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM reconciliations r
            WHERE r.id = new.reconciliation_id
              AND r.org_id = new.org_id
              AND r.status <> 'signed_off'
         )
         AND EXISTS (
           SELECT 1
             FROM reconciliation_matches m
            WHERE m.reconciliation_id = new.reconciliation_id
              AND m.journal_line_id = new.id
              AND m.org_id = new.org_id
         ) THEN
        RETURN new;
      END IF;
      RAISE EXCEPTION 'journal-line reconciliation evidence is append-only';
    END IF;
    IF v_status IN ('posted', 'reversed')
       AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
      IF period_module_blocks_write(
           v_org, v_period, v_book,
           nullif(coalesce(to_jsonb(new), to_jsonb(old))->>'subsidiary_id', '')::uuid,
           'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
         ) THEN
        RAISE EXCEPTION 'period is closed for GL posting';
      END IF;
      RETURN coalesce(new, old);
    END IF;
    RAISE EXCEPTION 'lines of a % journal entry are immutable', v_status;
  END IF;
  RETURN coalesce(new, old);
END;
$$;

CREATE OR REPLACE FUNCTION openbooks_reconciliation_match_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_reconciliation_id uuid := coalesce(new.reconciliation_id, old.reconciliation_id);
  target_org_id uuid := coalesce(new.org_id, old.org_id);
  parent_status text;
BEGIN
  IF tg_op = 'DELETE' AND openbooks_sandbox_wipe_allowed(old.org_id) THEN
    RETURN old;
  END IF;
  SELECT status
    INTO parent_status
    FROM reconciliations
   WHERE id = target_reconciliation_id
     AND org_id = target_org_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'reconciliation match parent must belong to the tenant';
  END IF;
  IF parent_status = 'signed_off' THEN
    RAISE EXCEPTION 'signed-off reconciliation matches are immutable';
  END IF;
  IF tg_op = 'UPDATE'
     AND (
       new.org_id IS DISTINCT FROM old.org_id
       OR new.reconciliation_id IS DISTINCT FROM old.reconciliation_id
       OR new.statement_line_id IS DISTINCT FROM old.statement_line_id
       OR new.journal_line_id IS DISTINCT FROM old.journal_line_id
       OR new.created_at IS DISTINCT FROM old.created_at
       OR new.created_by IS DISTINCT FROM old.created_by
     ) THEN
    RAISE EXCEPTION 'reconciliation match identity is immutable';
  END IF;
  IF tg_op <> 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM reconciliations r
        JOIN bank_statement_lines l
          ON l.id = new.statement_line_id
         AND l.org_id = r.org_id
         AND l.account_id = r.account_id
         AND l.currency = r.currency
         AND l.posted_on <= r.through_date
        JOIN journal_lines jl
          ON jl.id = new.journal_line_id
         AND jl.org_id = r.org_id
         AND jl.account_id = r.account_id
         AND jl.currency = r.currency
        JOIN journal_entries je
          ON je.id = jl.entry_id
         AND je.status IN ('posted', 'reversed')
         AND je.posting_date <= r.through_date
       WHERE r.id = new.reconciliation_id
         AND r.org_id = new.org_id
         AND r.status <> 'signed_off'
         AND jl.reconciled_at IS NULL
    ) THEN
      RAISE EXCEPTION 'reconciliation match violates tenant, account, currency, cutoff, or journal availability';
    END IF;
  END IF;
  RETURN coalesce(new, old);
END;
$$;

DROP TRIGGER IF EXISTS reconciliation_match_guard ON reconciliation_matches;
CREATE TRIGGER reconciliation_match_guard
BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_matches
FOR EACH ROW EXECUTE FUNCTION openbooks_reconciliation_match_guard();

CREATE OR REPLACE FUNCTION openbooks_bank_statement_line_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
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
       - 'updated_at' - 'updated_by'
     <> to_jsonb(old)
       - 'match_status' - 'exclusion_reason' - 'excluded_at' - 'excluded_by'
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

DROP TRIGGER IF EXISTS bank_statement_line_guard ON bank_statement_lines;
CREATE TRIGGER bank_statement_line_guard
BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_lines
FOR EACH ROW EXECUTE FUNCTION openbooks_bank_statement_line_guard();

COMMIT;
