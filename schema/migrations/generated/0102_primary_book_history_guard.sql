-- OpenBooks forward migration 0102_primary_book_history_guard.
-- Primary-book reassignment is a book conversion, not an ordinary config edit,
-- once accounting/reconciliation history exists. Preserve existing data and
-- allow descriptive edits, trusted migration, and authorized sandbox teardown.

CREATE OR REPLACE FUNCTION public.primary_book_history_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
DECLARE
  source_org uuid;
  target_org uuid;
BEGIN
  IF coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    IF tg_op = 'DELETE' THEN RETURN old; END IF;
    RETURN new;
  END IF;
  IF tg_op = 'DELETE' THEN
    IF NOT old.is_primary OR public.openbooks_sandbox_wipe_allowed(old.org_id) THEN
      RETURN old;
    END IF;
    source_org := old.org_id;
  ELSIF tg_op = 'INSERT' THEN
    IF NOT new.is_primary THEN RETURN new; END IF;
    target_org := new.org_id;
  ELSE
    -- A name, code, activation, or posting-policy edit does not change which
    -- book is authoritative. Keep those existing lifecycle controls intact.
    IF new.is_primary = old.is_primary AND new.org_id = old.org_id AND new.id = old.id THEN
      RETURN new;
    END IF;
    IF old.is_primary THEN source_org := old.org_id; END IF;
    IF new.is_primary THEN target_org := new.org_id; END IF;
  END IF;
  -- A pre-existing REPEATABLE READ snapshot could miss a first journal that
  -- committed before we acquired the book lock (SHARE did not change its row).
  -- These rare configuration writes require fresh statement snapshots.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'Primary book identity changes require READ COMMITTED isolation; retry the configuration in a new READ COMMITTED transaction'
      USING ERRCODE = '25000';
  END IF;
  -- SQL callers may already hold the target book row when this trigger runs.
  -- Never wait in the inverse target -> authority order: contention fails
  -- closed and the caller can retry the whole transaction. The setup service
  -- acquires authority first, so its ordinary wait/recheck path is unchanged.
  PERFORM id FROM public.accounting_books
    WHERE org_id IN (source_org, target_org) AND is_primary
    ORDER BY id FOR UPDATE NOWAIT;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE org_id IN (source_org, target_org))
     OR EXISTS (SELECT 1 FROM public.reconciliations WHERE org_id IN (source_org, target_org)) THEN
    RAISE EXCEPTION 'Cannot reassign the primary book while journal entries or bank reconciliation sessions/history exist; a controlled book conversion is required'
      USING ERRCODE = '23514';
  END IF;
  IF tg_op = 'DELETE' THEN RETURN old; END IF;
  RETURN new;
END;
$$;

CREATE TRIGGER primary_book_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_books
FOR EACH ROW EXECUTE FUNCTION public.primary_book_history_guard();

COMMENT ON FUNCTION public.primary_book_history_guard() IS
  'openbooks:primary_book_history_guard:v1 - primary book identity is frozen by accounting or reconciliation history; migration and controlled sandbox-delete exemptions';

-- Direct SQL journal creation and secondary-book writers must hold the same
-- authority row as the application kernel. No org lock is acquired here: an
-- INSERT may already hold a book lock, and reversing that order would create
-- a cycle with the kernel's org -> book order. Trusted historical imports keep
-- their existing exemption while assembling copied book/journal graphs.
CREATE OR REPLACE FUNCTION public.journal_primary_book_history_fence() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
DECLARE
  primary_ids uuid[];
BEGIN
  IF coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    RETURN new;
  END IF;
  SELECT array_agg(id) INTO primary_ids FROM (
    SELECT id FROM public.accounting_books WHERE org_id = new.org_id AND is_primary
      ORDER BY id FOR SHARE
  ) authority;
  -- A concurrent empty-org promotion can demote the row seen by the first
  -- statement while its lock waits. Take a fresh READ COMMITTED snapshot to
  -- resolve the successor, instead of proceeding without an authority fence.
  IF coalesce(cardinality(primary_ids), 0) = 0 THEN
    SELECT array_agg(id) INTO primary_ids FROM (
      SELECT id FROM public.accounting_books WHERE org_id = new.org_id AND is_primary
        ORDER BY id FOR SHARE
    ) authority;
  END IF;
  IF coalesce(cardinality(primary_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'accounting history creation requires exactly one primary accounting book'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END;
$$;

CREATE TRIGGER journal_primary_book_history_fence
BEFORE INSERT ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.journal_primary_book_history_fence();

COMMENT ON FUNCTION public.journal_primary_book_history_fence() IS
  'openbooks:journal_primary_book_history_fence:v1 - first journal creation retains the primary book row through commit, serializing SQL and secondary-book history with book reassignment';


-- Reconciliation sessions also freeze book authority, including direct SQL
-- writers which do not pass through the banking service's advisory fence.
CREATE TRIGGER reconciliation_primary_book_history_fence
BEFORE INSERT ON public.reconciliations
FOR EACH ROW EXECUTE FUNCTION public.journal_primary_book_history_fence();
