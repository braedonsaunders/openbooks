-- OpenBooks forward migration 0645_reconciliation_journal_clearing_groups.
--
-- GL-only zero-sum clearing groups: journal lines with no bank counterpart
-- (a voided deposit and its correcting journal netting to zero) clear
-- against each other in one audited group. Match rows of such a group carry
-- no statement line, so statement_line_id turns nullable; the match guard
-- keeps every journal-side check and requires the statement side only when
-- one is named. Existing rows keep their statement lines; nothing backfills.
--
-- No data or backfill: nullability only widens, the guard replacement is a
-- definition change, and no row is rewritten, so there is nothing to probe
-- before install.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.reconciliation_matches ALTER COLUMN statement_line_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.openbooks_reconciliation_match_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_reconciliation_id uuid := coalesce(new.reconciliation_id, old.reconciliation_id);
  target_org_id uuid := coalesce(new.org_id, old.org_id);
  parent_status text;
  cloning_match boolean := TG_OP = 'INSERT' AND public.openbooks_clone_authority();
BEGIN
  IF tg_op = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(old.org_id) THEN
    RETURN old;
  END IF;
  SELECT status
    INTO parent_status
    FROM public.reconciliations
   WHERE id = target_reconciliation_id
     AND org_id = target_org_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'reconciliation match parent must belong to the tenant';
  END IF;
  IF parent_status = 'signed_off' AND NOT cloning_match THEN
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
        FROM public.reconciliations r
        -- GL-only clearing rows name no statement line: the statement side
        -- is optional, the journal side is not.
        LEFT JOIN public.bank_statement_lines l
          ON l.id = new.statement_line_id
         AND l.org_id = r.org_id
         AND l.account_id = r.account_id
         AND l.currency = r.currency
         AND l.posted_on <= r.through_date
        JOIN public.journal_lines jl
          ON jl.id = new.journal_line_id
         AND jl.org_id = r.org_id
         AND jl.account_id = r.account_id
         AND jl.currency = r.currency
        JOIN public.journal_entries je
          ON je.id = jl.entry_id
         AND je.org_id = r.org_id
         AND je.status IN ('posted', 'reversed')
         AND je.posting_date <= r.through_date
       WHERE r.id = new.reconciliation_id
         AND r.org_id = new.org_id
         AND (new.statement_line_id IS NULL OR l.id IS NOT NULL)
         AND (
           (r.status <> 'signed_off' AND jl.reconciled_at IS NULL)
           OR (cloning_match AND r.status = 'signed_off'
               AND jl.reconciled_at IS NOT NULL
               AND jl.reconciliation_id = r.id)
         )
    ) THEN
      RAISE EXCEPTION 'reconciliation match violates tenant, account, currency, cutoff, or journal availability';
    END IF;
  END IF;
  RETURN coalesce(new, old);
END;
$$;
