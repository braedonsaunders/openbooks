-- OpenBooks forward migration 0168_close_posting_module_recheck.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Finding 5.4: posting validates the document's close module at the app
-- boundary (engine/src/posting.ts assertPeriodModulesOpen), but a concurrent
-- module-only close can commit between that check and the journal insert
-- while je_guard's draft -> posted branch rechecks GL only — so a posting
-- can land in a closed AP/AR (or other non-GL) period. The companion engine
-- half (postDocument holds the shared 0022 fence from BEFORE its module
-- check through commit) closes the interleaving for engine postings; this
-- migration closes it in storage for every writer: the draft -> posted block
-- re-derives the close module from the sourced document kind and rechecks
-- that same complete module set under the shared fence taken above.
--
-- Sourceless manual journals skip the recheck (their module is GL, already
-- checked). An unmapped kind or a not-yet-visible source document resolves to
-- null and also skips: the kind map is total for every posting document kind,
-- and the deferrable source_document_id FK stays the backstop for corrupt
-- references. No rows are touched.
--
-- Branch markers (-- Branch: <name>) are load-bearing: the journal-status
-- guard suite pins every branch by name so no future rewrite can silently
-- drop one. This body is 0166 byte-identical except the draft-post block,
-- which gains the module recheck owned here.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Storage mirror of DOCUMENT_CLOSE_MODULES (engine/src/close.ts): document
-- kind -> close module. Unknown kinds yield null (no subledger module), which
-- the draft-post recheck below treats as "GL only, already checked". A
-- dedicated parity test (engine/src/close-posting-module-fence) asserts this
-- map agrees with the engine map for every known kind.
CREATE OR REPLACE FUNCTION public.document_close_module(p_kind text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_kind
    when 'vendor_bill' then 'ap'
    when 'vendor_credit' then 'ap'
    when 'customer_invoice' then 'ar'
    when 'customer_credit' then 'ar'
    when 'card_charge' then 'ap'
    when 'card_refund' then 'ap'
    when 'check' then 'ap'
    when 'deposit' then 'banking'
    when 'transfer' then 'banking'
    when 'project_charge' then 'gl'
    when 'pay_run' then 'gl'
    when 'customer_payment' then 'ar'
    when 'vendor_payment' then 'ap'
    when 'expense_report' then 'ap'
    when 'sales_order' then 'ar'
    when 'purchase_order' then 'ap'
    when 'quote' then 'ar'
    when 'journal' then 'gl'
    else null
  end
$$;

COMMENT ON FUNCTION public.document_close_module(text) IS
  'openbooks:document-close-module:v1 - document kind to close module, storage mirror of DOCUMENT_CLOSE_MODULES (0168); unknown kinds yield null';

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
      if period_module_is_closed(old.org_id, old.period_id, old.book_id,
           nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl') then
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
  'openbooks:je_guard:v5 - kernel guard for journal entry mutations; v5 adds the source-module recheck on draft -> posted (the sourced document kind maps to its close module, rechecked under the shared fence alongside GL); otherwise identical to v4';
