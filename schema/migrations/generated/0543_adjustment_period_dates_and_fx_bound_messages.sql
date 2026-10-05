-- OpenBooks forward migration 0543_adjustment_period_dates_and_fx_bound_messages.
--
-- Adjustment periods: an adjustment period is the close bucket of ONE fiscal
-- year. A journal entry naming it must be dated inside that fiscal year,
-- otherwise date-based reporting places the posting in a different year from
-- the period that carries it (a 2025-06-30 entry in the FY2026 adjustment
-- period lands in hard-closed FY2025 by date). The fiscal year's window is
-- the span of its regular periods in the same calendar, widened by the
-- adjustment period's own dates. accounting_period_posting_window() is the
-- single definition the posting services and the storage guard share. The
-- guard checks new and re-dated entries only; sandbox clones replaying
-- already-posted history are admitted through the existing clone authority.
--
-- FX rounding bound messages: the bound refusal told every caller to post a
-- reversal and repost, which is wrong for a posting being made now, where
-- nothing was posted yet. A new posting (an entry inserted posted with all of
-- its lines, or a draft being posted) is now told to correct its rates or
-- amounts; an amendment of posted lines keeps the reversal remedy. The
-- arithmetic of both checks is unchanged from migration 0457.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.accounting_period_posting_window(p_org_id uuid, p_period_id uuid)
  RETURNS TABLE (is_adjustment boolean, period_name text, fiscal_year integer, window_start date, window_end date)
    LANGUAGE sql STABLE
    AS $$
  select p.is_adjustment, p.name, p.fiscal_year,
         case when p.is_adjustment then least(p.starts_on, fy.starts_on) else p.starts_on end,
         case when p.is_adjustment then greatest(p.ends_on, fy.ends_on) else p.ends_on end
    from public.accounting_periods p
    left join lateral (
      select min(r.starts_on) as starts_on, max(r.ends_on) as ends_on
        from public.accounting_periods r
       where r.org_id = p.org_id
         and r.fiscal_calendar_id = p.fiscal_calendar_id
         and r.fiscal_year = p.fiscal_year
         and not r.is_adjustment
    ) fy on true
   where p.org_id = p_org_id and p.id = p_period_id
$$;

CREATE FUNCTION public.je_check_adjustment_period_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_window record;
begin
  if TG_OP = 'INSERT' and public.openbooks_clone_authority() then return new; end if;
  select * into v_window
    from public.accounting_period_posting_window(new.org_id, new.period_id);
  if not found or not v_window.is_adjustment then return new; end if;
  if new.posting_date < v_window.window_start or new.posting_date > v_window.window_end then
    raise exception 'journal entry % is dated % but names adjustment period "%" of fiscal year % (% to %): an adjustment period takes postings dated inside its own fiscal year; date the entry inside that year or post it to the period that covers %',
      new.entry_number, new.posting_date, v_window.period_name, v_window.fiscal_year,
      v_window.window_start, v_window.window_end, new.posting_date
      using errcode = '23514';
  end if;
  return new;
end $$;

CREATE TRIGGER je_adjustment_period_date
  BEFORE INSERT OR UPDATE OF posting_date, period_id ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.je_check_adjustment_period_date();

-- ---------------------------------------------------------------------------
-- FX rounding bound: one checker, told whether the touched entries are being
-- posted now or are posted history being amended.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.journal_lines_check_fx_residual_entries(p_entry_ids uuid[], p_new_posting boolean) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_bad_org uuid;
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_deviation numeric(19, 4);
  v_bad_lines integer;
  v_bad_bound numeric;
begin
  -- One re-sum per touched (org, entry, subsidiary) group, not per line.
  -- Drafts are skipped: they post through je_check_posted_balance.
  select l.org_id, l.entry_id, l.subsidiary_id,
         sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))),
         count(*), count(*) * 0.00005
    into v_bad_org, v_bad_entry, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.org_id, l.entry_id, l.subsidiary_id
  having sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))) > count(*) * 0.00005
   limit 1;
  if found and p_new_posting then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  elsif found then
    raise exception 'journal entry % in organization % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): posted lines cannot be amended; correct through the ledger API by posting a reversal and reposting instead of editing history',
      v_bad_entry, v_bad_org, v_bad_subsidiary, v_bad_deviation, v_bad_lines, v_bad_bound
      using errcode = '23514';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_entries(p_entry_ids uuid[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_fx_residual_entries(p_entry_ids, false);
end $$;

-- An insert carrying every line of its entry is that entry being posted; an
-- insert adding lines to an entry that already had lines amends it.
CREATE OR REPLACE FUNCTION public.journal_lines_check_fx_residual_stmt_ins() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform public.journal_lines_check_fx_residual_entries(
    array(select n.entry_id from new_lines n group by n.entry_id
           having count(*) = (select count(*) from public.journal_lines l where l.entry_id = n.entry_id)),
    true);
  perform public.journal_lines_check_fx_residual_entries(
    array(select n.entry_id from new_lines n group by n.entry_id
           having count(*) <> (select count(*) from public.journal_lines l where l.entry_id = n.entry_id)),
    false);
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.je_check_posted_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_sum numeric(19,4);
  v_bad record;
  v_fx record;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines
   where entry_id = new.id and org_id = new.org_id;
  if v_sum <> 0 then
    raise exception 'posted journal entry % does not balance (sum = %)', new.id, v_sum
      using errcode = '23514';
  end if;
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'posted journal entry % does not balance for subsidiary % (sum = %)',
      new.id, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  select subsidiary_id,
         sum(abs(amount - round(txn_amount * fx_rate, 4))) as deviation,
         count(*) as lines,
         count(*) * 0.00005 as bound into v_fx
    from journal_lines
   where entry_id = new.id and org_id = new.org_id
   group by subsidiary_id
  having sum(abs(amount - round(txn_amount * fx_rate, 4))) > count(*) * 0.00005 limit 1;
  -- This gate fires when an entry becomes posted: inserted posted, or a
  -- draft flipped to posted. Either way nothing has been posted yet.
  if found then
    raise exception 'posted journal entry % exceeds the per-entry FX rounding bound for subsidiary % (stored deviation % over % lines, bound %): nothing was posted; correct the line exchange rates or functional amounts so each amount is its transaction amount times its rate, then post again',
      new.id, v_fx.subsidiary_id, v_fx.deviation, v_fx.lines, v_fx.bound using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id and org_id = new.org_id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $$;
