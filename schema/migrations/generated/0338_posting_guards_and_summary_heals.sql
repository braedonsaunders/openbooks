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

-- ---------------------------------------------------------------------------
-- Section G8: open_balance is computed on INSERT, and NULL caches are healed.
-- ---------------------------------------------------------------------------
-- The open-balance trigger watched UPDATE OF posted_entry_id, status only,
-- and open_balance is nullable with no default, so a direct INSERT of a
-- posted document (a backfill or migration) left open_balance NULL and
-- AR/AP aging read an unknown balance. The trigger below computes it on
-- INSERT too, through the same recompute the UPDATE path uses.
--
-- Backfill (UPG-0265 pattern): the UPDATE touches open_balance only, which
-- sits outside every document guard's column list (financial guard watches
-- financial columns, status guard watches status, period guard watches
-- status/entry/period, tieout re-asserts totals which the heal does not
-- move), so no trigger is suspended — and the populated-fixture test proves
-- the backfill passes them. Mixed-currency open lines would raise the
-- currency guard instead of guessing: the 0338 preflight refuses those
-- installs before this migration applies.
DROP TRIGGER IF EXISTS document_open_balance_insert ON public.documents;
CREATE TRIGGER document_open_balance_insert AFTER INSERT ON public.documents
FOR EACH ROW WHEN (new.status = 'posted' AND new.posted_entry_id IS NOT NULL)
EXECUTE FUNCTION public.trg_document_open_balance();

UPDATE public.documents d
   SET open_balance = public.document_open_balance_amount(d.org_id, d.posted_entry_id, d.currency, d.status::text)
 WHERE d.status = 'posted'
   AND d.posted_entry_id IS NOT NULL
   AND d.open_balance IS NULL;

-- ---------------------------------------------------------------------------
-- Section G10: line edits recompute the document cache.
-- ---------------------------------------------------------------------------
-- The amend branch of the journal-line guard fences only the period, with
-- no column allowlist, so an amend-path edit can flip is_open_item (or
-- amount, or the account) on a posted line while documents.open_balance
-- keeps the old projection — the recompute fired only on application
-- changes and document status/entry moves. The trigger below recomputes
-- every posted document whose entry gains, loses, or economically changes
-- a line, through the same locked recompute the other paths use.
-- UPDATEs that touch none of the balance inputs (evidence stamps) never
-- fire: the trigger watches only the entry key and the three balance
-- columns, following the gl_activity_line precedent on this table.
CREATE OR REPLACE FUNCTION public.trg_journal_line_open_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entries uuid[];
  v_entry uuid;
  v_doc uuid;
  v_org uuid;
begin
  if tg_op = 'DELETE' then
    v_entries := array[old.entry_id];
    v_org := old.org_id;
  elsif tg_op = 'INSERT' then
    v_entries := array[new.entry_id];
    v_org := new.org_id;
  elsif new.entry_id is distinct from old.entry_id
     or new.account_id is distinct from old.account_id
     or new.amount is distinct from old.amount
     or new.is_open_item is distinct from old.is_open_item then
    v_entries := array[old.entry_id, new.entry_id];
    v_org := new.org_id;
  else
    return new;
  end if;
  for v_entry in select distinct e from unnest(v_entries) as e loop
    for v_doc in select d.id from public.documents d
                  where d.org_id = v_org and d.posted_entry_id = v_entry loop
      perform public.recompute_document_open_balance(v_doc);
    end loop;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

DROP TRIGGER IF EXISTS journal_line_open_balance ON public.journal_lines;
CREATE TRIGGER journal_line_open_balance AFTER INSERT OR DELETE OR UPDATE OF entry_id, account_id, amount, is_open_item ON public.journal_lines
FOR EACH ROW EXECUTE FUNCTION public.trg_journal_line_open_balance();

-- ---------------------------------------------------------------------------
-- Section G9: the inactive-account refusal names the remedy.
-- ---------------------------------------------------------------------------
-- True-up residuals are ordinary postings, so they no longer run under the
-- migration flag that waived this check — and the refusal they now meet
-- named only the account, never what to do about it. The guard below is
-- otherwise identical to the 0236 body: the only change is the refusal
-- text, which now tells the operator to reactivate the account or map the
-- posting to an active one.
CREATE OR REPLACE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
  -- Evidence-only stamps (0236) are not postings. The line satisfied the
  -- posting rules below when it was posted; recording cleared/reconciled
  -- evidence changes no posting-relevant field, so the question is not
  -- re-opened. The column set matches jl_guard() exactly: any UPDATE that
  -- touches anything else falls through to the full checks. Whether the
  -- stamp itself is a legal append-only transition stays jl_guard's call.
  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
       = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
  then
    return new;
  end if;
  select is_summary, is_active, currency_restriction
    into v_summary, v_active, v_ccy
   from accounts
   where id = new.account_id and org_id = new.org_id
     for share;
  if not found then
    raise exception 'account % does not exist in organization %', new.account_id, new.org_id
      using errcode = '23503';
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive — reactivate the account or map the posting to an active account instead of posting to a deactivated one', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.jl_check_account() IS
  'openbooks:jl_check_account:v5 - locks the tenant-coherent account row before validating a direct journal-line write; evidence-only stamps (0236) are not re-validated as postings; the inactive-account refusal (0338/G9) names the remedy';

-- ---------------------------------------------------------------------------
-- Section G11: payment stats follow posting-date moves.
-- ---------------------------------------------------------------------------
-- party_payment_stats_maintain watches applications only and snapshots each
-- line's posting_date at apply time, so a later amend-path posting_date
-- change — direct, or fanned out by the je_cascade_posting_date header
-- change — left the settled_on bucket and day counts drifting behind the
-- rows they summarize. The trigger below moves every live application on
-- a re-dated line between buckets: the old leg with the previous date,
-- the new leg with the current one. Row-by-row cascade updates stay
-- consistent because each firing moves its own application from its own
-- before-image to its own after-image. Heals only forward drift (G6
-- precedent): past rehomes are detectable through the sanctioned
-- openbooks_party_payment_stats_verify(org) and repairable through
-- openbooks_party_payment_stats_rebuild(org), so no bulk rebuild ships
-- here. The delta's new optional date overrides default to the live row,
-- so the existing application-leg callers are byte-identical in behavior.
-- The 3-argument body lives in the baseline (immutable): drop that
-- signature first, or the defaulted replacement would stand beside it as
-- a second overload and every existing 3-argument call would go ambiguous.
DROP FUNCTION IF EXISTS public.openbooks_party_payment_stats_delta(uuid, uuid, integer);
CREATE OR REPLACE FUNCTION public.openbooks_party_payment_stats_delta(
  p_from_line uuid, p_to_line uuid, p_sign integer,
  p_settled date DEFAULT NULL, p_paid date DEFAULT NULL) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_org uuid; v_party uuid; v_type text; v_settled date; v_paid date; v_days numeric;
begin
  select bl.org_id, bl.party_id, a.type, bl.posting_date, pl.posting_date
    into v_org, v_party, v_type, v_settled, v_paid
    from journal_lines bl
    join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
    join journal_lines pl on pl.id = p_from_line
   where bl.id = p_to_line;
  -- A bulk copy can insert an application before its lines; the rebuild
  -- function is the repair path for that (clones copy lines first).
  if v_party is null or v_settled is null or v_paid is null then return; end if;
  if v_type not in ('asset_receivable', 'liability_payable') then return; end if;
  -- A date move passes explicit before/after images; ordinary legs keep
  -- reading the live rows exactly as before.
  v_settled := coalesce(p_settled, v_settled);
  v_paid := coalesce(p_paid, v_paid);
  v_days := (v_paid - v_settled)::numeric;
  insert into party_payment_stats as s (org_id, party_id, account_type, settled_on, n, sum_days, sum_days_sq)
  values (v_org, v_party, v_type, v_paid,
          p_sign, p_sign * v_days, p_sign * v_days * v_days)
  on conflict (org_id, account_type, settled_on, party_id) do update
    set n = s.n + excluded.n,
        sum_days = s.sum_days + excluded.sum_days,
        sum_days_sq = s.sum_days_sq + excluded.sum_days_sq;
end $$;

CREATE OR REPLACE FUNCTION public.trg_party_payment_stats_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_app record;
  v_bill_now date;
  v_pay_now date;
begin
  -- Only the re-dated line's image differs; the other leg still reads its
  -- live row. Each firing moves its own applications from its own
  -- before-image to its own after-image, so multi-row cascades converge.
  for v_app in select x.from_line_id as f, x.to_line_id as t
                 from public.applications x
                where x.org_id = new.org_id and x.unapplied_at is null
                  and (x.from_line_id = new.id or x.to_line_id = new.id) loop
    select bl.posting_date, pl.posting_date
      into v_bill_now, v_pay_now
      from public.journal_lines bl
      join public.journal_lines pl on pl.id = v_app.f and pl.org_id = new.org_id
     where bl.id = v_app.t and bl.org_id = new.org_id;
    perform public.openbooks_party_payment_stats_delta(
      v_app.f, v_app.t, -1,
      case when v_app.t = old.id then old.posting_date else v_bill_now end,
      case when v_app.f = old.id then old.posting_date else v_pay_now end);
    perform public.openbooks_party_payment_stats_delta(
      v_app.f, v_app.t, 1,
      case when v_app.t = new.id then new.posting_date else v_bill_now end,
      case when v_app.f = new.id then new.posting_date else v_pay_now end);
  end loop;
  return new;
end $$;

DROP TRIGGER IF EXISTS party_payment_stats_date ON public.journal_lines;
CREATE TRIGGER party_payment_stats_date AFTER UPDATE OF posting_date ON public.journal_lines
FOR EACH ROW WHEN (old.posting_date IS DISTINCT FROM new.posting_date)
EXECUTE FUNCTION public.trg_party_payment_stats_date();

-- ---------------------------------------------------------------------------
-- Section G12: reportable org tables join the governed query catalog.
-- ---------------------------------------------------------------------------
-- Eight org_id tables were invisible to the governed query console, so
-- reports built on them silently omitted rows (they failed closed, never
-- leaked): recognition events, payment schedule occurrences, the sync
-- reconciliation state, the party payment aggregates, inventory
-- writedowns, and lease agreements with their schedule lines. They join
-- safe_relations here, each with enforced RLS underneath and the console's
-- org filter on top. payment_pending_clawbacks joins too, but through a
-- curated view: its provider webhook payload can carry instrument
-- details, so the payload column stays out of the governed schema while
-- status and references stay queryable (the parties/sin_last3 precedent).
-- The function below is the 0161 body verbatim except the array and the
-- one curated block; the refresh at the end rebuilds every console view.
CREATE OR REPLACE FUNCTION public.openbooks_refresh_query_catalog() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
declare
  relation_name text;
  has_org_id boolean;
  global_relations constant text[] := array['currencies'];
  safe_relations constant text[] := array[
    'account_group_members', 'account_groups', 'accounting_books',
    'accounting_periods', 'accounts', 'addresses', 'allocation_driver_values',
    'allocation_drivers', 'allocation_lineage', 'allocation_rule_targets',
    'allocation_rule_versions', 'allocation_rules', 'allocation_runs', 'applications', 'asset_categories',
    'asset_events', 'bank_match_rules', 'bank_statement_lines', 'bank_statements',
    'billing_request_field_tickets', 'billing_requests', 'billing_schedules',
    'bom_components', 'budget_lines', 'budget_scenarios', 'cam_allocations',
    'cam_pools', 'change_orders',
    'charge_rate_components', 'classes', 'close_automation_executions',
    'close_events', 'close_exceptions', 'close_reopen_requests',
    'close_reporting_packages', 'close_run_tasks', 'close_runs', 'close_signoffs',
    'close_task_evidence', 'compliance_classes', 'compliance_records',
    'compliance_release_checks', 'compliance_requirements', 'compliance_waivers',
    'consolidated_fx_rates', 'contacts', 'cost_layer_consumptions',
    'cost_layer_weights', 'cost_layers', 'crm_account_assignment_events',
    'crm_account_profiles', 'crm_account_stage_events', 'crm_account_statuses',
    'crm_activity_links', 'crm_activity_participants',
    'crm_forecast_snapshots', 'crm_lead_sources', 'crm_opportunities',
    'crm_opportunity_documents', 'crm_opportunity_lines',
    'crm_opportunity_stage_events', 'crm_opportunity_statuses',
    'crm_opportunity_team_members', 'crm_sales_quotas', 'crm_sales_team_members',
    'crm_sales_teams', 'crm_sales_territories', 'currencies', 'departments',
    'depreciation_book_policies', 'depreciation_inputs', 'depreciation_methods',
    'depreciation_schedule_lines', 'depreciation_schedules',
    'document_line_tax_components', 'document_lines', 'document_links', 'documents',
    'dunning_log', 'entitlement_ledger',
    'entitlement_plan_limits', 'entitlement_plans', 'entitlement_service_tiers',
    'equipment_units', 'fair_value_prices',
    'field_ticket_labor_lines', 'field_ticket_labor_snapshots',
    'field_ticket_signatures', 'field_tickets', 'fiscal_calendars', 'fixed_assets',
    'fx_rates', 'gl_month_activity', 'income_tax_rates', 'intercompany_pairs',
    'inventory_movements',
    'inventory_provisional_costs', 'inventory_provisional_settlements',
    'inventory_writedowns',
    'invoice_backups', 'item_inventory_profiles', 'item_rate_book_assignments',
    'item_rate_books', 'item_rate_lines', 'item_rate_profiles', 'item_rate_versions',
    'items', 'journal_entries', 'journal_lines', 'labor_cost_rates',
    'labor_rate_adjustment_targets', 'labor_rate_adjustments', 'labor_rate_terms',
    'labor_rate_version_policies', 'labor_rate_version_scopes',
    'landed_cost_allocations', 'landed_cost_voucher_targets', 'landed_cost_vouchers',
    'lease_agreement_schedule_lines', 'lease_agreements',
    'lease_charges', 'lease_escalations', 'lease_schedule_lines', 'lien_waivers',
    'locations', 'lots', 'managed_properties', 'overhead_rates',
    'ownership_consolidation_entries', 'ownership_consolidation_runs',
    'party_payment_stats',
    'party_subsidiaries', 'pay_application_lines', 'pay_applications',
    'payment_events', 'payment_remittances', 'payment_run_items', 'payment_runs',
    'payment_schedule_occurrences', 'payment_schedules', 'payment_settlements', 'payment_surcharge_rules',
    'payment_terms', 'performance_obligations', 'period_locks',
    'project_financial_adjustments', 'project_financial_profile_versions',
    'project_overhead_adjustments', 'project_tasks', 'project_types', 'projects',
    'property_leases', 'property_units',
    'recognition_events', 'recognition_rules', 'recognition_schedule_lines', 'recognition_schedules',
    'reconciliation_matches', 'reconciliations', 'recurring_schedules',
    'revenue_contracts', 'schedule_baseline_tasks', 'schedule_baselines',
    'schedule_calendars', 'schedule_dependencies', 'schedule_resources',
    'schedule_task_assignments', 'security_deposit_transactions',
    'segment_definitions', 'segment_values', 'serials',
    'source_reconciliation_state', 'sov_lines', 'stock_count_lines', 'stock_counts', 'stock_locations',
    'subcontract_change_orders', 'subcontract_payment_controls',
    'subcontract_sov_lines', 'subcontracts', 'subscription_amendments',
    'subscription_components', 'subscription_events', 'subscription_lifecycles',
    'subscription_period_invoices', 'subscription_plan_version_components',
    'subscription_plan_versions', 'subscription_plans', 'subscriptions',
    'subsidiary_ownership_interests', 'tax_codes', 'tax_country_pack_installations',
    'tax_depreciation_pools', 'tax_filings', 'tax_first_year_rules',
    'tax_groups', 'tax_jurisdictions', 'tax_locale_pack_meta',
    'tax_pool_classes', 'tax_pool_periods', 'tax_provision_runs', 'tax_rates',
    'tax_regimes', 'tax_registrations', 'tax_report_lines', 'tax_return_forms',
    'temporary_differences', 'time_types', 'timesheet_weeks',
    'trades',
    'transfer_order_lines', 'transfer_orders', 'vendor_pay_application_lines',
    'vendor_pay_applications', 'vendor_retainage_releases', 'wip_holds',
    'wip_prebill_events', 'wip_prebill_lines', 'wip_prebills', 'worker_comp_groups',
    'employee_pay_components',
    'pay_components', 'pay_derived_rules', 'pay_run_adjustments', 'pay_runs',
    'pay_schedules', 'pay_stub_lines', 'pay_stubs',
    'payroll_filing_accounts', 'payroll_holidays',
    'payroll_opening_balance_components', 'payroll_opening_balances',
    'union_agreements', 'union_classifications',
    'union_fringes'
  ];
begin
  -- Public base tables are never query-console surfaces. Revoke both current
  -- and future access before rebuilding the reviewed view catalog.
  revoke all privileges on all tables in schema public from openbooks_read;
  alter default privileges in schema public revoke select on tables from openbooks_read;

  drop schema if exists openbooks_query cascade;
  create schema openbooks_query;
  revoke all on schema openbooks_query from public;
  grant usage on schema openbooks_query to openbooks_read;

  foreach relation_name in array safe_relations loop
    if to_regclass(format('public.%I', relation_name)) is null then
      raise exception 'governed query relation is missing: %', relation_name;
    end if;
    -- SELECT * is expanded and frozen when the view is created, so a column
    -- added later is not queryable until this function runs again.
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = relation_name and column_name = 'org_id'
    ) into has_org_id;
    if has_org_id then
      execute format(
        'create view openbooks_query.%1$I with (security_barrier=true) as '
        'select * from public.%1$I '
        'where org_id = public.openbooks_query_org_id()',
        relation_name
      );
    elsif relation_name = any(global_relations) then
      execute format(
        'create view openbooks_query.%1$I with (security_barrier=true) as select * from public.%1$I',
        relation_name
      );
    else
      raise exception
        'governed query relation % has no org_id and is not an explicitly reviewed global relation',
        relation_name;
    end if;
    execute format('grant select on openbooks_query.%I to openbooks_read', relation_name);
  end loop;

  -- Clawback tracking is reportable, but the provider webhook payload is
  -- not: event_payload carries the raw provider event, which can include
  -- instrument details. Status and references stay queryable.
  create view openbooks_query.payment_pending_clawbacks with (security_barrier=true) as
    select id, org_id, provider, intent_ref, event_status,
           created_at, last_seen_at, consumed_at, consumed_attempt_id
      from public.payment_pending_clawbacks
     where org_id = public.openbooks_query_org_id();
  -- Party dimensions are reportable, but full tax identifiers, sealed bank
  -- details and arbitrary source-system custom payloads are not.
  create view openbooks_query.parties with (security_barrier=true) as
    select id, org_id, kind, display_name, legal_name, short_code, email, phone,
           website, subsidiary_id, is_active, invoicing_preference,
           invoicing_profile, created_at, created_by, updated_at, updated_by
      from public.parties
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.customer_roles with (security_barrier=true) as
    select id, org_id, party_id, ar_account_id, payment_terms_id, credit_limit,
           currency, sales_rep_id, tax_code_id, is_on_hold, hold_reason, held_at,
           held_by, is_active, created_at, created_by, updated_at, updated_by
      from public.customer_roles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.vendor_roles with (security_barrier=true) as
    select id, org_id, party_id, ap_account_id, payment_terms_id,
           default_expense_account_id, payment_method, eft_notification_email,
           currency, tax_code_id, is_t4a, compliance_class_id,
           information_return_form, information_return_box, tax_classification,
           tin_last4, tin_type, backup_withholding, is_on_hold, hold_reason,
           held_at, held_by, is_active, created_at, created_by, updated_at, updated_by
      from public.vendor_roles
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.party_bank_accounts with (security_barrier=true) as
    select id, org_id, party_id, bank_name, country, currency, account_last_four,
           approved_at, approved_by, approval_status, submitted_by, submitted_at,
           retired_at, retired_by, retirement_reason, is_active,
           created_at, created_by, updated_at, updated_by
      from public.party_bank_accounts
     where org_id = public.openbooks_query_org_id();
  create view openbooks_query.subsidiaries with (security_barrier=true) as
    select id, org_id, parent_id, name, legal_name, base_currency, country,
           is_elimination, is_active, created_at, created_by, updated_at, updated_by
      from public.subsidiaries
     where org_id = public.openbooks_query_org_id();
  -- Payroll profiles are reportable, but the sealed national identifier is not:
  -- sin_encrypted is envelope-encrypted SIN/SSN ciphertext and never leaves the
  -- payroll engine. sin_last3 is the identify-without-reveal substitute.
  create view openbooks_query.employee_payroll_profiles with (security_barrier=true) as
    select id, org_id, employee_party_id, pay_schedule_id, province,
           pay_basis, federal_claim_code, federal_claim_amount,
           provincial_claim_code, provincial_claim_amount,
           additional_tax_per_period, prescribed_zone_deduction,
           authorized_annual_deductions, authorized_federal_credits,
           authorized_provincial_credits, cpp_exempt, ei_exempt,
           tax_exempt, vacation_percent, vacation_method, is_active,
           created_at, created_by, updated_at, updated_by,
           union_agreement_id, union_classification_id, country,
           filing_status, multiple_jobs, dependent_credits,
           other_income_annual, deductions_annual, w4_pre_2020,
           w4_allowances, fica_exempt, futa_exempt, sin_last3,
           filing_account_id, stub_delivery, payment_method,
           labour_jurisdiction
      from public.employee_payroll_profiles
     where org_id = public.openbooks_query_org_id();
  -- Employment records are reportable; date of birth is not. It exists for ROE
  -- demographics and the stub-password policy, and the schema comment on
  -- employee_roles.birth_date already states it stays out of these views.
  create view openbooks_query.employee_roles with (security_barrier=true) as
    select id, org_id, party_id, employee_number, department_id,
           supervisor_id, trade_id, worker_comp_group_id, hired_on,
           terminated_on, has_benefits, vacation_days_per_year,
           billable_utilization_target, expense_account_id,
           external_payroll_id, is_active, custom, created_at, created_by,
           updated_at, updated_by, job_title
      from public.employee_roles
     where org_id = public.openbooks_query_org_id();
  -- CRM activity rows remain reportable, but private notes never cross the
  -- governed-query boundary. The flag is retained so reports can count or
  -- filter private rows without seeing their body.
  create view openbooks_query.crm_activities with (security_barrier=true) as
    select id, org_id, kind, status, subject,
           case when is_private then null else body end as body,
           priority, owner_user_id, assigned_user_id, starts_at, ends_at,
           due_at, completed_at, reminder_at, duration_minutes, recurrence,
           is_private, custom, created_at, created_by, updated_at, updated_by
      from public.crm_activities
     where org_id = public.openbooks_query_org_id();
  -- Time rows remain available for hours, rates, billing, and payroll
  -- reporting, but private memo text is redacted in the governed catalog.
  create view openbooks_query.time_entries with (security_barrier=true) as
    select id, org_id, employee_party_id, worked_on, hours, time_type_id,
           item_id, project_id, project_task_id, department_id,
           case when memo_is_private then null else memo end as memo,
           memo_is_private, is_billable, cost_rate, bill_rate, status,
           approved_by, approved_at, cost_journal_entry_id, invoiced_by_line_id,
           payroll_batch_ref, created_at, created_by, updated_at, updated_by,
           custom, overhead_journal_entry_id, field_ticket_id,
           labor_cost_rate_id, wage_rate, wage_currency, wage_fx_rate,
           cost_rate_currency, cost_rate_subsidiary_id, bill_rate_source_rate,
           bill_rate_source_currency, bill_rate_fx_rate, bill_rate_currency,
           bill_rate_book_id, bill_rate_version_id, bill_rate_line_id,
           billing_status, costing_basis, started_at, rejection_reason,
           amends_entry_id
      from public.time_entries
     where org_id = public.openbooks_query_org_id();
  -- Membership rows inherit tenancy through their owning tax group. They
  -- deliberately cannot use the generic catalog path because the base table
  -- has no org_id of its own.
  create view openbooks_query.tax_group_members with (security_barrier=true) as
    select member.id, member.tax_group_id, member.tax_code_id, member.sequence
      from public.tax_group_members member
      join public.tax_groups tax_group on tax_group.id = member.tax_group_id
     where tax_group.org_id = public.openbooks_query_org_id();

  foreach relation_name in array array[
    'parties', 'customer_roles', 'vendor_roles', 'party_bank_accounts',
    'subsidiaries', 'employee_payroll_profiles', 'employee_roles',
    'crm_activities', 'time_entries', 'tax_group_members'
  ] loop
    execute format('grant select on openbooks_query.%I to openbooks_read', relation_name);
  end loop;
end;
$_$;

SELECT public.openbooks_refresh_query_catalog();
