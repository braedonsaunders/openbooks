-- OpenBooks forward migration 0338_posting_guards_and_summary_heals.
--
-- Audit wave G (database layer), posting-guard and derived-summary
-- sections (0334 carried the RLS section). Sections land in this file under
-- successive commits; the header names only landed sections. Each section
-- names its finding and stays re-runnable: every statement tolerates
-- re-execution.
--
-- Section G4: refuse posted -> draft on documents in storage.
-- The documents_posted_financial_guard trigger fires only on financial
-- columns, never status, so UPDATE documents SET status='draft' WHERE
-- status='posted' rewrote posted history with no amend flag: posted-only
-- readers (statements, registers, aging) silently lost the document while
-- its journal entry stayed posted. The only sanctioned exits from posted
-- are the controlled void (posted -> voided with void evidence in the same
-- write, engine/src/ledger/document-void.ts) and the governed amend path.
-- A sandbox wipe passes only through openbooks_sandbox_wipe_allowed(org_id),
-- never a raw session GUC any session could SET.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Section G4: a posted document leaves posted only by void or amend.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.posted_document_status_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Only the hardened per-org check admits a sandbox wipe; a raw session
  -- GUC is settable by any session and would reopen posted -> draft.
  if public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return new;
  end if;
  -- The controlled void writes its evidence (voided_at, voided_by,
  -- void_reason) in the same statement that flips the status; the row CHECK
  -- documents_void_reason_required enforces the same triple at commit.
  if new.status = 'voided'
     and new.voided_at is not null
     and new.voided_by is not null
     and new.void_reason is not null then
    return new;
  end if;
  if coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    return new;
  end if;
  raise exception 'document % is posted and immutable — void it through the controlled void path instead of changing its status to %', old.id, new.status;
end $$;

DROP TRIGGER IF EXISTS documents_posted_status_guard ON public.documents;
CREATE TRIGGER documents_posted_status_guard BEFORE UPDATE OF status ON public.documents
FOR EACH ROW WHEN (old.status = 'posted' AND new.status IS DISTINCT FROM old.status)
EXECUTE FUNCTION public.posted_document_status_guard();

-- ---------------------------------------------------------------------------
-- Section G5: amend-deletes fence like amend-updates (soft close counts).
-- ---------------------------------------------------------------------------
-- 0168's je_guard DELETE branch used period_module_is_closed (true only for
-- state = 'closed') while the sibling amend-UPDATE branch uses the
-- soft-close-aware period_module_blocks_write, contradicting 0246's rule
-- that a soft close must fence posting the same way a hard close does: an
-- amend-delete in a soft_closed period went through. v6 below is 0168's v5
-- byte-identical except the delete predicate (plus this version comment);
-- every Branch marker the guard suites pin is preserved.
CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_module text;
begin
  -- Branch: journal-entry-delete (sandbox-wipe passthrough, posted/reversed delete fence).
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    if old.status <> 'draft' then
      perform period_posting_fence(old.org_id, old.period_id, old.book_id);
      if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
           nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
        raise exception 'period is closed for GL posting';
      end if;
    end if;
    return old;
  end if;

  -- Branch: same-status-amend (engine-only trusted replay of posted history).
  if old.status in ('posted', 'reversed') and new.status = old.status
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
      raise exception 'period is closed for GL posting';
    end if;
    return new;
  end if;

  -- Branch: posted-immutability (the only exits from posted are the amend
  -- path above and the evidenced reversal below).
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  -- A posted entry may only leave posted status through controlled reversal
  -- (posted -> reversed). Any other regression — in particular posted ->
  -- draft, which would silently suppress posted history from every
  -- posted-only reader — raises here. No product flow writes posted -> draft.
  if old.status = 'posted' and new.status <> 'reversed' then
    raise exception 'journal entry % is posted and can only be reversed, not set to %', old.id, new.status;
  end if;
  -- Branch: reversal-evidence (0166). posted -> reversed retires history, so
  -- the economics must already be offset: no economic header change may
  -- accompany the flip (only the lifecycle stamp and row-audit columns may
  -- differ), and a posted mirror reversal must exist in the same org and
  -- book referencing this entry. Existence, not uniqueness: reversal of a
  -- reversal and re-correction generations stay legal.
  if old.status = 'posted' and new.status = 'reversed' then
    if to_jsonb(old) - 'status' - 'updated_at' - 'updated_by'
       is distinct from
       to_jsonb(new) - 'status' - 'updated_at' - 'updated_by' then
      raise exception 'journal entry % is posted and can only be reversed without other changes', old.id;
    end if;
    if not exists (
      select 1
        from journal_entries reversal
       where reversal.org_id = old.org_id
         and reversal.book_id = old.book_id
         and reversal.reverses_entry_id = old.id
         and reversal.status = 'posted'
         and public.openbooks_reversal_mirrors(old.org_id, old.id, reversal.id)
    ) then
      raise exception 'journal entry % cannot be reversed without a posted mirror reversal in the same book', old.id;
    end if;
    return new;
  end if;
  -- Branch: reversed-immutable.
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  -- Branch: draft-post (f2/0168 owns the source-module recheck inside this block).
  if old.status = 'draft' and new.status = 'posted' then
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and l.org_id = new.org_id
            and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl',
              coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    -- Module recheck (0168): the app boundary validates the source
    -- document's own close module, but a module-only close can commit
    -- between that check and this flip while the GL predicate above stays
    -- open. Re-derive the module from the sourced document kind and recheck
    -- it here, under the shared fence taken above, so the flip is atomic
    -- with the complete module set. Sourceless journals and unmapped kinds
    -- resolve to GL/null and skip: GL was already checked above.
    if new.source_document_id is not null then
      select public.document_close_module(d.kind) into v_module
        from public.documents d
       where d.id = new.source_document_id;
      if v_module is not null and v_module <> 'gl'
         and (period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, v_module,
                coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              or exists (
                select 1 from journal_lines l
                 where l.entry_id = new.id
                   and l.org_id = new.org_id
                   and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                     nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, v_module,
                     coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              )) then
        raise exception 'period is closed for % posting', upper(v_module);
      end if;
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.je_guard() IS
  'openbooks:je_guard:v6 - kernel guard for journal entry mutations; v6 (0338/G5) fences the delete branch with the soft-close-aware period_module_blocks_write, the same predicate as the sibling amend branch, instead of the closed-only period_module_is_closed; otherwise identical to v5';

-- ---------------------------------------------------------------------------
-- Section G6: the GL monthly aggregate follows book rehomes under amend.
-- ---------------------------------------------------------------------------
-- The entry trigger watched status and posting_date only, so an amend-path
-- book_id rehome on a posted entry (same status, same date) moved no
-- activity between book buckets: the old book kept the amounts and the new
-- book showed nothing. Amend is supposed to allow the rehome (0168's
-- same-status-amend branch fences both the old and the new org/period/book,
-- which only makes sense if the triple may change), so the aggregate
-- follows instead of the guard refusing: the trigger now also watches
-- book_id, and the month-move leg subtracts with the OLD book and adds
-- with the new one (entry_delta gains an optional book override; the
-- four-argument form keeps working through the default). Subsidiary needs
-- no entry-level handling (the aggregate keys the LINE subsidiary, and the
-- line trigger already moves those buckets) and currency is not a bucket
-- dimension. Heals only forward drift: past rehomes are undetectable
-- post-hoc, so no historical rebuild ships here.
DROP FUNCTION IF EXISTS public.openbooks_gl_activity_entry_delta(uuid, uuid, date, integer);
DROP FUNCTION IF EXISTS public.openbooks_gl_activity_entry_delta(uuid, uuid, date, integer, uuid);
CREATE FUNCTION public.openbooks_gl_activity_entry_delta(p_entry uuid, p_org uuid, p_month date, p_sign integer, p_book uuid DEFAULT NULL) RETURNS void
    LANGUAGE sql
    AS $$
  insert into gl_month_activity as g (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
  select p_org, l.account_id, coalesce(p_book, e.book_id), p_month, l.subsidiary_id,
         p_sign * coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0),
         p_sign * coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0),
         p_sign * count(*)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
   where l.entry_id = p_entry and l.org_id = p_org and e.org_id = p_org
   group by l.account_id, coalesce(p_book, e.book_id), l.subsidiary_id
   order by l.account_id, coalesce(p_book, e.book_id), l.subsidiary_id
  on conflict (org_id, account_id, book_id, month, subsidiary_id) do update
    set debit_total = g.debit_total + excluded.debit_total,
        credit_total = g.credit_total + excluded.credit_total,
        line_count = g.line_count + excluded.line_count;
$$;;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_old_in boolean;
  v_new_in boolean;
  v_old_month date;
  v_new_month date;
  v_old_book uuid;
  v_new_book uuid;
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('posted', 'reversed') then
      perform openbooks_gl_activity_entry_delta(new.id, new.org_id, date_trunc('month', new.posting_date)::date, 1);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'reversed') then
      perform openbooks_gl_activity_entry_delta(old.id, old.org_id, date_trunc('month', old.posting_date)::date, -1);
    end if;
    return null;
  end if;
  v_old_in := old.status in ('posted', 'reversed');
  v_new_in := new.status in ('posted', 'reversed');
  v_old_month := date_trunc('month', old.posting_date)::date;
  v_new_month := date_trunc('month', new.posting_date)::date;
  v_old_book := old.book_id;
  v_new_book := new.book_id;
  if v_old_in and not v_new_in then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1);
  elsif v_new_in and not v_old_in then
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  elsif v_old_in and v_new_in and (v_old_month <> v_new_month or v_old_book is distinct from v_new_book) then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1, v_old_book);
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  end if;
  return null;
end $$;
;

DROP TRIGGER IF EXISTS gl_activity_entry ON public.journal_entries;
CREATE TRIGGER gl_activity_entry AFTER INSERT OR DELETE OR UPDATE OF status, posting_date, book_id ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.openbooks_gl_activity_entry();
