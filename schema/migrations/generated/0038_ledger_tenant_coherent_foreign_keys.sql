-- OpenBooks forward migration 0038_ledger_tenant_coherent_foreign_keys.
--
-- Ledger rows carry org_id, but their legacy foreign keys referenced only the
-- globally unique id columns. A direct writer could therefore attach a header
-- or line to another tenant's book, period, document, entry, account, native
-- dimension, party, card, equipment unit, subsidiary, or tax code. Several
-- ledger triggers compounded that defect by resolving parents and aggregating
-- balances by id alone.
--
-- Financial history is never rewritten here. The preflight reports one exact
-- offending relationship and row and aborts the whole tracked-migration
-- transaction. Clean installations receive composite storage constraints;
-- existing installations add them NOT VALID first and then validate every
-- row before commit.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT 'journal_entries.book_id'::text AS relationship,
             e.id AS child_id, e.org_id AS child_org,
             e.book_id AS referenced_id, p.org_id AS referenced_org
        FROM public.journal_entries e
        JOIN public.accounting_books p ON p.id = e.book_id
       WHERE p.org_id <> e.org_id
      UNION ALL
      SELECT 'journal_entries.period_id', e.id, e.org_id, e.period_id, p.org_id
        FROM public.journal_entries e
        JOIN public.accounting_periods p ON p.id = e.period_id
       WHERE p.org_id <> e.org_id
      UNION ALL
      SELECT 'journal_entries.source_document_id', e.id, e.org_id, e.source_document_id, p.org_id
        FROM public.journal_entries e
        JOIN public.documents p ON p.id = e.source_document_id
       WHERE p.org_id <> e.org_id
      UNION ALL
      SELECT 'journal_entries.subsidiary_id', e.id, e.org_id, e.subsidiary_id, p.org_id
        FROM public.journal_entries e
        JOIN public.subsidiaries p ON p.id = e.subsidiary_id
       WHERE p.org_id <> e.org_id
      UNION ALL
      SELECT 'journal_entries.reverses_entry_id', e.id, e.org_id, e.reverses_entry_id, p.org_id
        FROM public.journal_entries e
        JOIN public.journal_entries p ON p.id = e.reverses_entry_id
       WHERE p.org_id <> e.org_id
      UNION ALL
      SELECT 'journal_lines.entry_id', l.id, l.org_id, l.entry_id, p.org_id
        FROM public.journal_lines l
        JOIN public.journal_entries p ON p.id = l.entry_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.account_id', l.id, l.org_id, l.account_id, p.org_id
        FROM public.journal_lines l
        JOIN public.accounts p ON p.id = l.account_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.subsidiary_id', l.id, l.org_id, l.subsidiary_id, p.org_id
        FROM public.journal_lines l
        JOIN public.subsidiaries p ON p.id = l.subsidiary_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.party_id', l.id, l.org_id, l.party_id, p.org_id
        FROM public.journal_lines l
        JOIN public.parties p ON p.id = l.party_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.department_id', l.id, l.org_id, l.department_id, p.org_id
        FROM public.journal_lines l
        JOIN public.departments p ON p.id = l.department_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.project_id', l.id, l.org_id, l.project_id, p.org_id
        FROM public.journal_lines l
        JOIN public.projects p ON p.id = l.project_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.location_id', l.id, l.org_id, l.location_id, p.org_id
        FROM public.journal_lines l
        JOIN public.locations p ON p.id = l.location_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.class_id', l.id, l.org_id, l.class_id, p.org_id
        FROM public.journal_lines l
        JOIN public.classes p ON p.id = l.class_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.equipment_unit_id', l.id, l.org_id, l.equipment_unit_id, p.org_id
        FROM public.journal_lines l
        JOIN public.equipment_units p ON p.id = l.equipment_unit_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.payment_card_id', l.id, l.org_id, l.payment_card_id, p.org_id
        FROM public.journal_lines l
        JOIN public.payment_cards p ON p.id = l.payment_card_id
       WHERE p.org_id <> l.org_id
      UNION ALL
      SELECT 'journal_lines.tax_code_id', l.id, l.org_id, l.tax_code_id, p.org_id
        FROM public.journal_lines l
        JOIN public.tax_codes p ON p.id = l.tax_code_id
       WHERE p.org_id <> l.org_id
    ) violations
   ORDER BY relationship, child_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'ledger tenant-coherence migration found a cross-organization reference',
      DETAIL = format(
        'relationship=%s child_id=%s child_org=%s referenced_id=%s referenced_org=%s',
        violation.relationship,
        violation.child_id,
        violation.child_org,
        violation.referenced_id,
        violation.referenced_org
      ),
      HINT = 'Correct or quarantine the identified legacy row under an approved accounting repair, then retry migration 0038; this migration never rewrites ledger history.';
  END IF;
END
$preflight$;

-- PostgreSQL requires a unique key over the exact referenced column set.
-- Several of these already exist in the canonical baseline; IF NOT EXISTS
-- makes the forward migration correct for both fresh and deployed databases.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_books_org_id_id_unique
  ON public.accounting_books USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_periods_org_id_id_unique
  ON public.accounting_periods USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique
  ON public.documents USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subsidiaries_org_id_id_unique
  ON public.subsidiaries USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_id_id_unique
  ON public.journal_entries USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique
  ON public.accounts USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique
  ON public.parties USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_id_id_unique
  ON public.departments USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_unique
  ON public.projects USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS locations_org_id_id_unique
  ON public.locations USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS classes_org_id_id_unique
  ON public.classes USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_org_id_id_unique
  ON public.equipment_units USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_cards_org_id_id_unique
  ON public.payment_cards USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_org_id_id_unique
  ON public.tax_codes USING btree (org_id, id);

ALTER TABLE public.journal_entries
  DROP CONSTRAINT journal_entries_book_id_fkey,
  DROP CONSTRAINT journal_entries_period_id_fkey,
  DROP CONSTRAINT journal_entries_reverses_entry_id_fkey,
  DROP CONSTRAINT journal_entries_source_document_id_fkey,
  DROP CONSTRAINT journal_entries_subsidiary_id_fkey;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_book_id_fkey
    FOREIGN KEY (org_id, book_id)
    REFERENCES public.accounting_books (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_entries_period_id_fkey
    FOREIGN KEY (org_id, period_id)
    REFERENCES public.accounting_periods (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_entries_reverses_entry_id_fkey
    FOREIGN KEY (org_id, reverses_entry_id)
    REFERENCES public.journal_entries (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_entries_source_document_id_fkey
    FOREIGN KEY (org_id, source_document_id)
    REFERENCES public.documents (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_entries_subsidiary_id_fkey
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries (org_id, id) DEFERRABLE NOT VALID;

ALTER TABLE public.journal_lines
  DROP CONSTRAINT journal_lines_account_id_fkey,
  DROP CONSTRAINT journal_lines_class_id_fkey,
  DROP CONSTRAINT journal_lines_department_id_fkey,
  DROP CONSTRAINT journal_lines_entry_id_fkey,
  DROP CONSTRAINT journal_lines_equipment_unit_id_fkey,
  DROP CONSTRAINT journal_lines_location_id_fkey,
  DROP CONSTRAINT journal_lines_party_id_fkey,
  DROP CONSTRAINT journal_lines_payment_card_id_fkey,
  DROP CONSTRAINT journal_lines_project_id_fkey,
  DROP CONSTRAINT journal_lines_subsidiary_id_fkey,
  DROP CONSTRAINT journal_lines_tax_code_id_fkey;

ALTER TABLE public.journal_lines
  ADD CONSTRAINT journal_lines_account_id_fkey
    FOREIGN KEY (org_id, account_id)
    REFERENCES public.accounts (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_class_id_fkey
    FOREIGN KEY (org_id, class_id)
    REFERENCES public.classes (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_department_id_fkey
    FOREIGN KEY (org_id, department_id)
    REFERENCES public.departments (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_entry_id_fkey
    FOREIGN KEY (org_id, entry_id)
    REFERENCES public.journal_entries (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_equipment_unit_id_fkey
    FOREIGN KEY (org_id, equipment_unit_id)
    REFERENCES public.equipment_units (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_location_id_fkey
    FOREIGN KEY (org_id, location_id)
    REFERENCES public.locations (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_party_id_fkey
    FOREIGN KEY (org_id, party_id)
    REFERENCES public.parties (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_payment_card_id_fkey
    FOREIGN KEY (org_id, payment_card_id)
    REFERENCES public.payment_cards (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_project_id_fkey
    FOREIGN KEY (org_id, project_id)
    REFERENCES public.projects (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_subsidiary_id_fkey
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT journal_lines_tax_code_id_fkey
    FOREIGN KEY (org_id, tax_code_id)
    REFERENCES public.tax_codes (org_id, id) DEFERRABLE NOT VALID;

ALTER TABLE public.journal_entries VALIDATE CONSTRAINT journal_entries_book_id_fkey;
ALTER TABLE public.journal_entries VALIDATE CONSTRAINT journal_entries_period_id_fkey;
ALTER TABLE public.journal_entries VALIDATE CONSTRAINT journal_entries_reverses_entry_id_fkey;
ALTER TABLE public.journal_entries VALIDATE CONSTRAINT journal_entries_source_document_id_fkey;
ALTER TABLE public.journal_entries VALIDATE CONSTRAINT journal_entries_subsidiary_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_account_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_class_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_department_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_entry_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_equipment_unit_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_location_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_party_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_payment_card_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_project_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_subsidiary_id_fkey;
ALTER TABLE public.journal_lines VALIDATE CONSTRAINT journal_lines_tax_code_id_fkey;

CREATE OR REPLACE FUNCTION public.je_check_posted_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_sum numeric(19,4);
  v_bad record;
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
  if (select count(*) from journal_lines where entry_id = new.id and org_id = new.org_id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $$;
-- Preserve the close/posting advisory fence introduced by migration 0022;
-- only the line lookup gains its tenant predicate.
CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
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

  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

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
  'openbooks:je_guard:v3 - preserves the close/posting fence and scopes ledger-line reads to the entry organization';

CREATE OR REPLACE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
  select is_summary, is_active, currency_restriction
    into v_summary, v_active, v_ccy
    from accounts
   where id = new.account_id and org_id = new.org_id;
  if not found then
    raise exception 'account % does not exist in organization %', new.account_id, new.org_id
      using errcode = '23503';
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;

CREATE OR REPLACE FUNCTION public.jl_check_balanced() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entries uuid[];
  v_orgs uuid[];
  v_sum numeric(19,4);
  i integer;
begin
  if tg_op = 'INSERT' then
    v_entries := array[new.entry_id];
    v_orgs := array[new.org_id];
  elsif tg_op = 'DELETE' then
    v_entries := array[old.entry_id];
    v_orgs := array[old.org_id];
  else
    v_entries := array[new.entry_id, old.entry_id];
    v_orgs := array[new.org_id, old.org_id];
  end if;

  for i in 1..array_length(v_entries, 1) loop
    if i > 1
       and v_entries[i] = v_entries[1]
       and v_orgs[i] = v_orgs[1] then
      continue;
    end if;
    select coalesce(sum(amount), 0) into v_sum
      from journal_lines
     where entry_id = v_entries[i] and org_id = v_orgs[i];
    if v_sum <> 0 then
      raise exception 'journal entry % does not balance in organization % (sum = %)',
        v_entries[i], v_orgs[i], v_sum using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.jl_check_balanced_by_subsidiary() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entries uuid[];
  v_orgs uuid[];
  v_bad record;
  i integer;
begin
  if tg_op = 'INSERT' then
    v_entries := array[new.entry_id];
    v_orgs := array[new.org_id];
  elsif tg_op = 'DELETE' then
    v_entries := array[old.entry_id];
    v_orgs := array[old.org_id];
  else
    v_entries := array[new.entry_id, old.entry_id];
    v_orgs := array[new.org_id, old.org_id];
  end if;

  for i in 1..array_length(v_entries, 1) loop
    if i > 1
       and v_entries[i] = v_entries[1]
       and v_orgs[i] = v_orgs[1] then
      continue;
    end if;
    select subsidiary_id, sum(amount) as total into v_bad
      from journal_lines
     where entry_id = v_entries[i] and org_id = v_orgs[i]
     group by subsidiary_id having sum(amount) <> 0 limit 1;
    if found then
      raise exception 'journal entry % does not balance for subsidiary % in organization % (sum = %)',
        v_entries[i], v_bad.subsidiary_id, v_orgs[i], v_bad.total using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.jl_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_org uuid;
  v_period uuid;
  v_book uuid;
  v_line_org uuid;
  v_entry uuid;
begin
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    v_line_org := old.org_id;
    v_entry := old.entry_id;
  else
    v_line_org := new.org_id;
    v_entry := new.entry_id;
  end if;
  select status, org_id, period_id, book_id
    into v_status, v_org, v_period, v_book
    from journal_entries
   where id = v_entry and org_id = v_line_org;
  if not found then
    raise exception 'journal entry % does not exist in organization %', v_entry, v_line_org
      using errcode = '23503';
  end if;
  if v_status is distinct from 'draft' then
    if tg_op = 'UPDATE'
       and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id'
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id'
    then
      if new.reconciled_at is not distinct from old.reconciled_at
         and new.reconciliation_id is not distinct from old.reconciliation_id then
        return new;
      end if;
      if old.reconciled_at is null
         and old.reconciliation_id is null
         and new.reconciled_at is not null
         and new.reconciliation_id is not null
         and exists (
           select 1
             from reconciliations r
            where r.id = new.reconciliation_id
              and r.org_id = new.org_id
              and r.status <> 'signed_off'
         )
         and exists (
           select 1
             from reconciliation_matches m
            where m.reconciliation_id = new.reconciliation_id
              and m.journal_line_id = new.id
              and m.org_id = new.org_id
         ) then
        return new;
      end if;
      raise exception 'journal-line reconciliation evidence is append-only';
    end if;
    if v_status in ('posted', 'reversed')
       and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
      if period_module_blocks_write(v_org, v_period, v_book,
           nullif(coalesce(to_jsonb(new), to_jsonb(old))->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
        raise exception 'period is closed for GL posting';
      end if;
      return coalesce(new, old);
    end if;
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_entry_delta(p_entry uuid, p_org uuid, p_month date, p_sign integer) RETURNS void
    LANGUAGE sql
    AS $$
  insert into gl_month_activity as g (org_id, account_id, book_id, month, subsidiary_id, debit_total, credit_total, line_count)
  select p_org, l.account_id, e.book_id, p_month, l.subsidiary_id,
         p_sign * coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0),
         p_sign * coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0),
         p_sign * count(*)
    from journal_lines l
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
   where l.entry_id = p_entry and l.org_id = p_org and e.org_id = p_org
   group by l.account_id, e.book_id, l.subsidiary_id
   order by l.account_id, e.book_id, l.subsidiary_id
  on conflict (org_id, account_id, book_id, month, subsidiary_id) do update
    set debit_total = g.debit_total + excluded.debit_total,
        credit_total = g.credit_total + excluded.credit_total,
        line_count = g.line_count + excluded.line_count;
$$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_date date;
  v_org uuid;
  v_book uuid;
  v_month date;
  v_entry uuid;
  v_line_org uuid;
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and (new.entry_id, new.org_id) is distinct from (old.entry_id, old.org_id) then
    select status, posting_date, org_id, book_id
      into v_status, v_date, v_org, v_book
      from journal_entries
     where id = old.entry_id and org_id = old.org_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, old.account_id, v_book, v_month, old.subsidiary_id,
        -greatest(old.amount, 0), -greatest(-old.amount, 0), -1);
    end if;
    select status, posting_date, org_id, book_id
      into v_status, v_date, v_org, v_book
      from journal_entries
     where id = new.entry_id and org_id = new.org_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, new.account_id, v_book, v_month, new.subsidiary_id,
        greatest(new.amount, 0), greatest(-new.amount, 0), 1);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    v_entry := old.entry_id;
    v_line_org := old.org_id;
  else
    v_entry := new.entry_id;
    v_line_org := new.org_id;
  end if;
  select status, posting_date, org_id, book_id
    into v_status, v_date, v_org, v_book
    from journal_entries
   where id = v_entry and org_id = v_line_org;
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
    join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
   where e.org_id = p_org and l.org_id = p_org and e.status in ('posted', 'reversed')
   group by e.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date, l.subsidiary_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_verify(p_org uuid) RETURNS TABLE(account_id uuid, book_id uuid, month date, subsidiary_id uuid, summary_debit numeric, ledger_debit numeric, summary_credit numeric, ledger_credit numeric)
    LANGUAGE sql
    AS $$
  with ledger as (
    select l.account_id, e.book_id, date_trunc('month', e.posting_date)::date as month, l.subsidiary_id,
           coalesce(sum(case when l.amount > 0 then l.amount else 0 end), 0) as debit_total,
           coalesce(sum(case when l.amount < 0 then -l.amount else 0 end), 0) as credit_total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
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

CREATE OR REPLACE FUNCTION public.openbooks_je_cascade_posting_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return null;
  end if;
  update journal_lines
     set posting_date = new.posting_date
   where entry_id = new.id
     and org_id = new.org_id
     and posting_date is distinct from new.posting_date;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_jl_stamp_posting_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_date date;
begin
  select posting_date into v_date
    from journal_entries
   where id = new.entry_id and org_id = new.org_id;
  new.posting_date := v_date;
  return new;
end $$;
