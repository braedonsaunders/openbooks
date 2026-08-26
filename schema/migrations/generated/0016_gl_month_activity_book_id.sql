-- OpenBooks forward migration 0016_gl_month_activity_book_id.
--
-- journal_entries.book_id is mandatory, but gl_month_activity keyed only
-- (org_id, account_id, month, subsidiary_id), so the derived summary fused
-- parallel accounting books: identical -100 revenue posted to a primary and a
-- secondary book aggregated into one -200 row and every summary-fed statement
-- (P&L, balance sheet, trial balance) silently double counted as soon as an
-- alternate book held activity. This migration adds book_id to the key and to
-- the openbooks_gl_activity_* trigger maintenance, and rebuilds the summary
-- from the lines per book.
--
-- The whole migration runs inside bootstrap's single transaction: any failure
-- rolls back the column, the constraint swap, and the function bodies
-- together, leaving the prior (old-shape) summary exactly as it was — the
-- table is fully derived, so repopulating it from journal_lines ×
-- journal_entries loses nothing even though pre-migration rows had already
-- fused books together. Statements are defensive because bootstrap tracks
-- immutable file digests.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Widen the table first: PostgreSQL validates SQL-language function bodies at
-- CREATE OR REPLACE time, and those bodies reference gl_month_activity.book_id.
ALTER TABLE public.gl_month_activity ADD COLUMN IF NOT EXISTS book_id uuid;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_apply(p_org uuid, p_account uuid, p_book uuid, p_month date, p_subsidiary uuid, p_debit numeric, p_credit numeric, p_count bigint) RETURNS void
    LANGUAGE sql
    AS $$
  insert into gl_month_activity as g (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
  values (p_org, p_account, p_book, p_month, p_subsidiary, p_debit, p_credit, p_count)
  on conflict (org_id, account_id, book_id, month, subsidiary_id) do update
    set debit_total = g.debit_total + excluded.debit_total,
        credit_total = g.credit_total + excluded.credit_total,
        line_count = g.line_count + excluded.line_count;
$$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_entry_delta(p_entry uuid, p_org uuid, p_month date, p_sign integer) RETURNS void
    LANGUAGE sql
    AS $$
  insert into gl_month_activity as g (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
  select p_org, l.account_id, e.book_id, p_month, l.subsidiary_id,
         p_sign * coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0),
         p_sign * coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0),
         p_sign * count(*)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
   where l.entry_id = p_entry
   group by l.account_id, e.book_id, l.subsidiary_id
   order by l.account_id, e.book_id, l.subsidiary_id
  on conflict (org_id, account_id, book_id, month, subsidiary_id) do update
    set debit_total = g.debit_total + excluded.debit_total,
        credit_total = g.credit_total + excluded.credit_total,
        line_count = g.line_count + excluded.line_count;
$$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_old_in boolean;
  v_new_in boolean;
  v_old_month date;
  v_new_month date;
begin
  -- Wipes delete the summary rows themselves; per-row maintenance during a
  -- wipe is pure waste.
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- Bulk copies (sandbox clone, backup restore, migration) may insert an
    -- already-posted entry before or after its lines; aggregating whatever
    -- lines exist right now composes with the per-line trigger to count each
    -- line exactly once in either order.
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
  if v_old_in and not v_new_in then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1);
  elsif v_new_in and not v_old_in then
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  elsif v_old_in and v_new_in and v_old_month <> v_new_month then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1);
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  end if;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_date date;
  v_org uuid;
  v_book uuid;
  v_month date;
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.entry_id is distinct from old.entry_id then
    -- A line never legally moves between entries, but if it ever did the
    -- delta must split across both parents.
    select status, posting_date, org_id, book_id into v_status, v_date, v_org, v_book from journal_entries where id = old.entry_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, old.account_id, v_book, v_month, old.subsidiary_id,
        -greatest(old.amount, 0), -greatest(-old.amount, 0), -1);
    end if;
    select status, posting_date, org_id, book_id into v_status, v_date, v_org, v_book from journal_entries where id = new.entry_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, new.account_id, v_book, v_month, new.subsidiary_id,
        greatest(new.amount, 0), greatest(-new.amount, 0), 1);
    end if;
    return null;
  end if;
  select status, posting_date, org_id, book_id into v_status, v_date, v_org, v_book
    from journal_entries where id = coalesce(new.entry_id, old.entry_id);
  -- Draft edits are free; a missing parent means a bulk copy will account for
  -- this line when the entry row arrives (entry-INSERT aggregation).
  if v_status is null or v_status not in ('posted', 'reversed') then
    return null;
  end if;
  v_month := date_trunc('month', v_date)::date;
  if tg_op in ('UPDATE', 'DELETE') then
    perform openbooks_gl_activity_apply(v_org, old.account_id, v_book, v_month, old.subsidiary_id,
      -greatest(old.amount, 0), -greatest(-old.amount, 0), -1);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform openbooks_gl_activity_apply(v_org, new.account_id, v_book, v_month, new.subsidiary_id,
      greatest(new.amount, 0), greatest(-new.amount, 0), 1);
  end if;
  return null;
end $$;

-- Swap the key and repopulate per book. Pre-migration rows may already fuse
-- several books under one key, so the only faithful backfill is a full
-- rebuild from the lines — same statement the sanctioned per-org repair path
-- runs, extended with e.book_id and executed for every org at once. Inside
-- the migration transaction readers keep seeing the untouched pre-swap rows
-- until commit; a failure anywhere above rolls all of this back.
ALTER TABLE public.gl_month_activity DROP CONSTRAINT IF EXISTS gl_month_activity_pkey;
DELETE FROM public.gl_month_activity;
INSERT INTO public.gl_month_activity (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
SELECT e.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date, l.subsidiary_id,
       coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0),
       coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0),
       count(*)
  FROM public.journal_lines l
  JOIN public.journal_entries e ON e.id = l.entry_id
 WHERE e.status IN ('posted', 'reversed')
 GROUP BY e.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date, l.subsidiary_id;
ALTER TABLE public.gl_month_activity ALTER COLUMN book_id SET NOT NULL;
ALTER TABLE public.gl_month_activity
  ADD CONSTRAINT gl_month_activity_pkey PRIMARY KEY (org_id, account_id, book_id, month, subsidiary_id);

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_rebuild(p_org uuid) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
  v_count bigint;
begin
  delete from gl_month_activity where org_id = p_org;
  insert into gl_month_activity (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
  select e.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date, l.subsidiary_id,
         coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0),
         coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0),
         count(*)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id
   where e.org_id = p_org and l.org_id = p_org and e.status in ('posted', 'reversed')
   group by e.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date, l.subsidiary_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- verify's OUT row type gains book_id, so the old signature must go first.
DROP FUNCTION IF EXISTS public.openbooks_gl_activity_verify(uuid);
CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_verify(p_org uuid) RETURNS TABLE(account_id uuid, book_id uuid, month date, subsidiary_id uuid, summary_debit numeric, ledger_debit numeric, summary_credit numeric, ledger_credit numeric)
    LANGUAGE sql
    AS $$
  with ledger as (
    select l.account_id, e.book_id, date_trunc('month', e.posting_date)::date as month, l.subsidiary_id,
           coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as debit_total,
           coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0) as credit_total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where e.org_id = p_org and l.org_id = p_org and e.status in ('posted', 'reversed')
     group by 1, 2, 3, 4
  ), summary as (
    select g.account_id, g.book_id, g.month, g.subsidiary_id, g.debit_total, g.credit_total
      from gl_month_activity g where g.org_id = p_org
       and (g.debit_total <> 0 or g.credit_total <> 0 or g.line_count <> 0)
  )
  select coalesce(l.account_id, s.account_id), coalesce(l.book_id, s.book_id),
         coalesce(l.month, s.month), coalesce(l.subsidiary_id, s.subsidiary_id),
         coalesce(s.debit_total, 0), coalesce(l.debit_total, 0),
         coalesce(s.credit_total, 0), coalesce(l.credit_total, 0)
    from ledger l
    full outer join summary s
      on s.account_id = l.account_id and s.book_id = l.book_id
     and s.month = l.month and s.subsidiary_id = l.subsidiary_id
   where coalesce(s.debit_total, 0) <> coalesce(l.debit_total, 0)
      or coalesce(s.credit_total, 0) <> coalesce(l.credit_total, 0);
$$;
