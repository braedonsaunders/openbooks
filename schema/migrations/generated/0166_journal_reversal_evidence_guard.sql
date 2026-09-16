-- OpenBooks forward migration 0166_journal_reversal_evidence_guard.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Finding 5.2: je_guard() let posted -> reversed through with no supporting
-- reversal evidence and no freeze on accompanying economic changes, while
-- the shared reversal helper (engine/src/reversal-journal-lines.ts)
-- preserves dimensions and negates amounts. The flip must retire history,
-- never restate it.
--
-- This migration adds the reversal-evidence branch: posted -> reversed now
-- requires (a) no economic header change — only status/updated_at/updated_by
-- may differ — and (b) a posted reversal entry in the same org and book that
-- references the original and whose lines mirror-negate it. Existence, not
-- uniqueness, is required, so reversal-of-reversal chains and re-correction
-- generations stay legal. Every engine void/correction/reversal flow posts
-- the mirror reversal BEFORE flipping the original, so all product paths
-- already satisfy the check synchronously. No data is touched.
--
-- Branch markers (-- Branch: <name>) are load-bearing: the journal-status
-- guard suite pins every branch by name so no future rewrite can silently
-- drop one (the fleet lost the tenant lookup once). The draft -> posted
-- block is byte-identical to 0146; f2/0168 owns the source-module recheck
-- inside it.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Mirror-negation predicate shared by the reversal-evidence branch: every
-- original line has an exact mirror (same line number, account, subsidiary,
-- currency, rate and attribution dimensions; amounts, tax amounts and
-- quantity negated) and vice versa, and the reversal is non-empty. Memo,
-- due dates, open-item flags, custom payloads and contributor stamps are
-- bookkeeping metadata the engine flows legitimately vary, so they are not
-- part of the economic mirror.
CREATE OR REPLACE FUNCTION public.openbooks_reversal_mirrors(
  p_org_id uuid, p_original_id uuid, p_reversal_id uuid
) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select exists (
           select 1
             from public.journal_lines v
            where v.org_id = p_org_id and v.entry_id = p_reversal_id
         )
     and not exists (
           select 1
             from public.journal_lines o
            where o.org_id = p_org_id and o.entry_id = p_original_id
              and not exists (
                    select 1
                      from public.journal_lines v
                     where v.org_id = p_org_id and v.entry_id = p_reversal_id
                       and v.line_number = o.line_number
                       and v.account_id is not distinct from o.account_id
                       and v.subsidiary_id is not distinct from o.subsidiary_id
                       and v.amount is not distinct from -o.amount
                       and v.currency is not distinct from o.currency
                       and v.txn_amount is not distinct from -o.txn_amount
                       and v.fx_rate is not distinct from o.fx_rate
                       and v.party_id is not distinct from o.party_id
                       and v.department_id is not distinct from o.department_id
                       and v.project_id is not distinct from o.project_id
                       and v.location_id is not distinct from o.location_id
                       and v.class_id is not distinct from o.class_id
                       and v.equipment_unit_id is not distinct from o.equipment_unit_id
                       and v.payment_card_id is not distinct from o.payment_card_id
                       and v.tax_code_id is not distinct from o.tax_code_id
                       and v.extra_dims is not distinct from o.extra_dims
                       and v.quantity is not distinct from -o.quantity
                  )
         )
     and not exists (
           select 1
             from public.journal_lines v
            where v.org_id = p_org_id and v.entry_id = p_reversal_id
              and not exists (
                    select 1
                      from public.journal_lines o
                     where o.org_id = p_org_id and o.entry_id = p_original_id
                       and v.line_number = o.line_number
                       and v.account_id is not distinct from o.account_id
                       and v.subsidiary_id is not distinct from o.subsidiary_id
                       and v.amount is not distinct from -o.amount
                       and v.currency is not distinct from o.currency
                       and v.txn_amount is not distinct from -o.txn_amount
                       and v.fx_rate is not distinct from o.fx_rate
                       and v.party_id is not distinct from o.party_id
                       and v.department_id is not distinct from o.department_id
                       and v.project_id is not distinct from o.project_id
                       and v.location_id is not distinct from o.location_id
                       and v.class_id is not distinct from o.class_id
                       and v.equipment_unit_id is not distinct from o.equipment_unit_id
                       and v.payment_card_id is not distinct from o.payment_card_id
                       and v.tax_code_id is not distinct from o.tax_code_id
                       and v.extra_dims is not distinct from o.extra_dims
                       and v.quantity is not distinct from -o.quantity
                  )
         )
$$;

COMMENT ON FUNCTION public.openbooks_reversal_mirrors(uuid, uuid, uuid) IS
  'openbooks:reversal-mirror:v1 - true when the reversal entry lines mirror-negate the original entry lines (0166); memo/due-date/custom metadata excluded';

CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    new.posted_at := now();
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.je_guard() IS
  'openbooks:je_guard:v4 - kernel guard for journal entry mutations; v4 adds the reversal-evidence branch (posted -> reversed needs a posted same-book mirror and no accompanying header change); otherwise identical to v3';
