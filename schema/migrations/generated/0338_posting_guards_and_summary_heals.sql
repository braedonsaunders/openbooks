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
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return new;
  end if;
  if openbooks_sandbox_wipe_allowed(old.org_id) then
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
