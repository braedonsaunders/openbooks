-- Index open-item lines with their live remaining amount, so as-of AR/AP reads start from the lines that can still be open.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- One row per open-item journal line: the line's magnitude less every active
-- application leg on it, in the line's functional currency (the same legs
-- the as-of open-item reader nets), alongside the line attributes that
-- select and age it. Derived and never authored: triggers on journal_lines
-- and applications maintain it, and openbooks_open_item_balances_rebuild()
-- reproduces it from source rows.
CREATE TABLE public.open_item_balances (
    org_id uuid NOT NULL,
    line_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    party_id uuid,
    posting_date date,
    due_date date,
    amount numeric(19,4) NOT NULL,
    remaining numeric(19,4) NOT NULL,
    is_open boolean GENERATED ALWAYS AS (remaining <> 0) STORED NOT NULL,
    CONSTRAINT open_item_balances_pkey PRIMARY KEY (org_id, line_id)
);

COMMENT ON TABLE public.open_item_balances IS 'Derived open-item index: each open-item journal line''s attributes and live remaining amount (magnitude less active application legs); maintained by openbooks_open_item_balances_* triggers.';

ALTER TABLE public.open_item_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.open_item_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.open_item_balances
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.open_item_balances IS 'openbooks:org_isolation:v1';

CREATE TRIGGER tenant_retirement_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.open_item_balances
  FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

-- The open set by control account and posting date: a reader scans only the
-- lines with something left to settle on the accounts it ages. A boolean
-- predicate keeps the index usable under row-level security.
CREATE INDEX open_item_balances_open ON public.open_item_balances USING btree (org_id, account_id, posting_date) WHERE is_open;

-- Applications dated after an as-of date, or unapplied after it, are the only
-- reason a line's as-of remaining can differ from its live remaining.
CREATE INDEX applications_org_applied_on ON public.applications USING btree (org_id, applied_on);
CREATE INDEX applications_org_unapplied_at ON public.applications USING btree (org_id, unapplied_at) WHERE (unapplied_at IS NOT NULL);

-- Active application legs on one line: the from leg carries source_amount,
-- the to leg carries amount, and a self-application counts once.
CREATE FUNCTION public.openbooks_open_item_balances_applied(p_org uuid, p_line uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce((select sum(x.source_amount) from public.applications x
                    where x.org_id = p_org and x.from_line_id = p_line and x.unapplied_at is null), 0)
       + coalesce((select sum(x.amount) from public.applications x
                    where x.org_id = p_org and x.to_line_id = p_line and x.from_line_id <> p_line
                      and x.unapplied_at is null), 0)
$$;

-- Move one application's legs in or out of the lines it touches. Deltas update
-- under the row lock, so concurrent applications on one line serialize. A line
-- with no row yet (a restore or clone may copy an application before its line)
-- is left for the line's own insert, which nets every application present.
CREATE FUNCTION public.openbooks_open_item_balances_delta(p_org uuid, p_from uuid, p_to uuid, p_source_amount numeric, p_amount numeric, p_sign integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  update public.open_item_balances
     set remaining = remaining + p_sign * p_source_amount
   where org_id = p_org and line_id = p_from;
  if p_to is distinct from p_from then
    update public.open_item_balances
       set remaining = remaining + p_sign * p_amount
     where org_id = p_org and line_id = p_to;
  end if;
end
$$;

CREATE FUNCTION public.openbooks_open_item_balances_application() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  -- An active application's legs are applied; an unapplied one contributes
  -- nothing. Remove the old contribution, then add the new one.
  if tg_op in ('UPDATE', 'DELETE') and old.unapplied_at is null then
    perform public.openbooks_open_item_balances_delta(old.org_id, old.from_line_id, old.to_line_id, old.source_amount, old.amount, 1);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.unapplied_at is null then
    perform public.openbooks_open_item_balances_delta(new.org_id, new.from_line_id, new.to_line_id, new.source_amount, new.amount, -1);
  end if;
  return null;
end
$$;

-- Inserted open-item lines, one statement at a time: posting and bulk loads
-- insert many lines per statement. Each row nets whatever applications already
-- reference the line, so copies that land applications first still converge.
CREATE FUNCTION public.openbooks_open_item_balances_line_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.open_item_balances
    (org_id, line_id, entry_id, account_id, subsidiary_id, party_id, posting_date, due_date, amount, remaining)
  select l.org_id, l.id, l.entry_id, l.account_id, l.subsidiary_id, l.party_id, l.posting_date, l.due_date, l.amount,
         abs(l.amount) - public.openbooks_open_item_balances_applied(l.org_id, l.id)
    from inserted_journal_lines l
   where l.is_open_item
  on conflict (org_id, line_id) do update set
    entry_id = excluded.entry_id, account_id = excluded.account_id, subsidiary_id = excluded.subsidiary_id,
    party_id = excluded.party_id, posting_date = excluded.posting_date, due_date = excluded.due_date,
    amount = excluded.amount, remaining = excluded.remaining;
  return null;
end
$$;

-- A changed line recomputes its row from scratch (posting carries the entry's
-- date onto its lines); a delete removes it.
CREATE FUNCTION public.openbooks_open_item_balances_line() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  if tg_op = 'DELETE' or not new.is_open_item or (new.id, new.org_id) is distinct from (old.id, old.org_id) then
    delete from public.open_item_balances where org_id = old.org_id and line_id = old.id;
  end if;
  if tg_op = 'UPDATE' and new.is_open_item then
    insert into public.open_item_balances
      (org_id, line_id, entry_id, account_id, subsidiary_id, party_id, posting_date, due_date, amount, remaining)
    values (new.org_id, new.id, new.entry_id, new.account_id, new.subsidiary_id, new.party_id, new.posting_date,
            new.due_date, new.amount, abs(new.amount) - public.openbooks_open_item_balances_applied(new.org_id, new.id))
    on conflict (org_id, line_id) do update set
      entry_id = excluded.entry_id, account_id = excluded.account_id, subsidiary_id = excluded.subsidiary_id,
      party_id = excluded.party_id, posting_date = excluded.posting_date, due_date = excluded.due_date,
      amount = excluded.amount, remaining = excluded.remaining;
  end if;
  return null;
end
$$;

-- Repair and audit: recompute one organization's rows from source, and list
-- every line whose stored row differs from its source (empty when sound).
CREATE FUNCTION public.openbooks_open_item_balances_rebuild(p_org uuid) RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  v_rows bigint;
begin
  delete from public.open_item_balances where org_id = p_org;
  insert into public.open_item_balances
    (org_id, line_id, entry_id, account_id, subsidiary_id, party_id, posting_date, due_date, amount, remaining)
  select l.org_id, l.id, l.entry_id, l.account_id, l.subsidiary_id, l.party_id, l.posting_date, l.due_date, l.amount,
         abs(l.amount) - coalesce(src.amount, 0) - coalesce(tgt.amount, 0)
    from public.journal_lines l
    left join (
      select x.from_line_id as line_id, sum(x.source_amount) as amount
        from public.applications x
       where x.org_id = p_org and x.unapplied_at is null
       group by x.from_line_id
    ) src on src.line_id = l.id
    left join (
      select x.to_line_id as line_id, sum(x.amount) as amount
        from public.applications x
       where x.org_id = p_org and x.unapplied_at is null and x.from_line_id <> x.to_line_id
       group by x.to_line_id
    ) tgt on tgt.line_id = l.id
   where l.org_id = p_org and l.is_open_item;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;

CREATE FUNCTION public.openbooks_open_item_balances_verify(p_org uuid) RETURNS TABLE(line_id uuid, stored jsonb, actual jsonb)
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  with actual as (
    select l.id as line_id,
           jsonb_build_object('entry_id', l.entry_id, 'account_id', l.account_id, 'subsidiary_id', l.subsidiary_id,
             'party_id', l.party_id, 'posting_date', l.posting_date, 'due_date', l.due_date, 'amount', l.amount,
             'remaining', abs(l.amount) - public.openbooks_open_item_balances_applied(p_org, l.id)) as row
      from public.journal_lines l
     where l.org_id = p_org and l.is_open_item
  ), stored as (
    select s.line_id,
           jsonb_build_object('entry_id', s.entry_id, 'account_id', s.account_id, 'subsidiary_id', s.subsidiary_id,
             'party_id', s.party_id, 'posting_date', s.posting_date, 'due_date', s.due_date, 'amount', s.amount,
             'remaining', s.remaining) as row
      from public.open_item_balances s
     where s.org_id = p_org
  )
  select coalesce(a.line_id, b.line_id), b.row, a.row
    from actual a
    full join stored b on b.line_id = a.line_id
   where a.row is distinct from b.row
$$;

-- Triggers before the backfill: creating them takes the write locks on
-- journal_lines and applications, so no write lands between the backfill's
-- snapshot and their activation.
CREATE TRIGGER open_item_balances_application
  AFTER INSERT OR DELETE OR UPDATE OF unapplied_at, from_line_id, to_line_id, amount, source_amount ON public.applications
  FOR EACH ROW EXECUTE FUNCTION public.openbooks_open_item_balances_application();
CREATE TRIGGER open_item_balances_line_insert
  AFTER INSERT ON public.journal_lines REFERENCING NEW TABLE AS inserted_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.openbooks_open_item_balances_line_insert();
CREATE TRIGGER open_item_balances_line
  AFTER DELETE OR UPDATE OF is_open_item, amount, id, org_id, entry_id, account_id, subsidiary_id, party_id, posting_date, due_date ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.openbooks_open_item_balances_line();

INSERT INTO public.open_item_balances
  (org_id, line_id, entry_id, account_id, subsidiary_id, party_id, posting_date, due_date, amount, remaining)
SELECT l.org_id, l.id, l.entry_id, l.account_id, l.subsidiary_id, l.party_id, l.posting_date, l.due_date, l.amount,
       abs(l.amount) - coalesce(src.amount, 0) - coalesce(tgt.amount, 0)
  FROM public.journal_lines l
  LEFT JOIN (
    SELECT x.org_id, x.from_line_id AS line_id, sum(x.source_amount) AS amount
      FROM public.applications x
     WHERE x.unapplied_at IS NULL
     GROUP BY x.org_id, x.from_line_id
  ) src ON src.org_id = l.org_id AND src.line_id = l.id
  LEFT JOIN (
    SELECT x.org_id, x.to_line_id AS line_id, sum(x.amount) AS amount
      FROM public.applications x
     WHERE x.unapplied_at IS NULL AND x.from_line_id <> x.to_line_id
     GROUP BY x.org_id, x.to_line_id
  ) tgt ON tgt.org_id = l.org_id AND tgt.line_id = l.id
 WHERE l.is_open_item;

-- Expose the rollup through the governed query views like the other ledger rollups.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('open_item_balances', '0008_open_item_balances')
ON CONFLICT (relation) DO NOTHING;
SELECT public.openbooks_refresh_query_catalog();
