BEGIN;

-- A reversed original remains part of posted ledger history. Permit the same
-- tightly scoped engine amendment path used for a posted entry, but only when
-- the lifecycle status is unchanged and both the old and new GL periods are
-- open. Application services remain responsible for complete before/after
-- audit evidence and for preserving reversal-pair symmetry.
CREATE OR REPLACE FUNCTION je_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' THEN
    IF tg_op = 'DELETE' THEN RETURN old; END IF;
    RETURN new;
  END IF;
  IF tg_op = 'DELETE' THEN
    IF openbooks_sandbox_wipe_allowed(old.org_id) THEN RETURN old; END IF;
    IF old.status <> 'draft'
       AND coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' THEN
      RAISE EXCEPTION 'journal entry % is % and cannot be deleted', old.id, old.status;
    END IF;
    IF old.status <> 'draft'
       AND period_module_is_closed(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl') THEN
      RAISE EXCEPTION 'period is closed for GL posting';
    END IF;
    RETURN old;
  END IF;

  IF old.status IN ('posted', 'reversed') AND new.status = old.status
     AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    IF period_module_is_closed(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl')
       OR period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl') THEN
      RAISE EXCEPTION 'period is closed for GL posting';
    END IF;
    RETURN new;
  END IF;

  IF old.status = 'posted' AND new.status = 'posted' THEN
    RAISE EXCEPTION 'journal entry % is posted and immutable', old.id;
  END IF;
  IF old.status = 'reversed' THEN
    RAISE EXCEPTION 'journal entry % is reversed and immutable', old.id;
  END IF;

  IF old.status = 'draft' AND new.status = 'posted' THEN
    IF period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl')
       OR EXISTS (
         SELECT 1 FROM journal_lines l
          WHERE l.entry_id = new.id
            AND period_module_is_closed(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl')
       ) THEN
      RAISE EXCEPTION 'period is closed for GL posting';
    END IF;
    new.posted_at := now();
  END IF;
  RETURN new;
END $$;

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
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id'
    THEN
      RETURN new;
    END IF;
    IF v_status IN ('posted', 'reversed')
       AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
      IF period_module_is_closed(v_org, v_period, v_book,
           nullif(coalesce(to_jsonb(new), to_jsonb(old))->>'subsidiary_id', '')::uuid, 'gl') THEN
        RAISE EXCEPTION 'period is closed for GL posting';
      END IF;
      RETURN coalesce(new, old);
    END IF;
    RAISE EXCEPTION 'lines of a % journal entry are immutable', v_status;
  END IF;
  RETURN coalesce(new, old);
END $$;

COMMIT;
