-- openbooks kernel invariants.
-- These are the guarantees the ledger makes BY CONSTRUCTION, in Postgres,
-- regardless of application bugs. Applied after Drizzle's generated DDL.

-- ---------------------------------------------------------------------------
-- 1. Every journal entry balances: SUM(amount) = 0 across its lines.
--    Deferred to commit so multi-line inserts work naturally.
-- ---------------------------------------------------------------------------
create or replace function jl_check_balanced() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  v_sum numeric(19,4);
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines where entry_id = v_entry;
  if v_sum <> 0 then
    raise exception 'journal entry % does not balance (sum = %)', v_entry, v_sum
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger jl_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function jl_check_balanced();

-- ---------------------------------------------------------------------------
-- 2. Posted entries are immutable; posting requires an open period.
-- ---------------------------------------------------------------------------
create or replace function period_module_is_closed(
  p_org uuid,
  p_period uuid,
  p_book uuid,
  p_subsidiary uuid,
  p_module text
) returns boolean
language sql stable as $$
  select coalesce(
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id = p_subsidiary and module = p_module),
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id is null and module = p_module),
    false
  )
$$;

-- Close evidence, signatures, and event history are permanent audit facts.
-- Corrections append a new row; they never rewrite the original record.
create or replace function close_append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

drop trigger if exists close_events_append_only on close_events;
create trigger close_events_append_only before update or delete on close_events
for each row execute function close_append_only_guard();

drop trigger if exists close_signoffs_append_only on close_signoffs;
create trigger close_signoffs_append_only before update or delete on close_signoffs
for each row execute function close_append_only_guard();

drop trigger if exists close_evidence_append_only on close_task_evidence;
create trigger close_evidence_append_only before update or delete on close_task_evidence
for each row execute function close_append_only_guard();

create or replace function je_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- Deleting a transaction removes its journal entry too. That is the one
    -- legitimate removal of a posted entry, done by the engine's guarded
    -- delete under the 'openbooks.amend' flag (after it has proven the delete
    -- is safe: open period, no applied payments, no downstream conversion).
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    return old;
  end if;

  -- A document-sourced entry is a DERIVED projection of its source document:
  -- entry = postingRules(document), re-materialized on every save. When
  -- 'openbooks.amend' is on (set only by the engine's materialize path), a
  -- posted entry's header may be regenerated in place — but only into an OPEN
  -- period (a GL change can't land in a closed period). Balance + summary-
  -- account rules still apply to the regenerated lines.
  if old.status = 'posted' and new.status = 'posted'
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    if period_module_is_closed(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl')
       or period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl') then
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

  -- draft -> posted: period must be open for GL
  if old.status = 'draft' and new.status = 'posted' then
    if period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and period_module_is_closed(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;

create trigger je_guard before update or delete on journal_entries
  for each row execute function je_guard();

create or replace function jl_guard() returns trigger
language plpgsql as $$
declare
  v_status text;
  v_org uuid;
  v_period uuid;
  v_book uuid;
begin
  select status, org_id, period_id, book_id into v_status, v_org, v_period, v_book from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if v_status is distinct from 'draft' then
    -- Bank-reconciliation sign-off stamps reconciled_at / reconciliation_id
    -- on posted lines. That is bookkeeping METADATA, not accounting content:
    -- allow an UPDATE that changes nothing else. Every other write to a
    -- non-draft entry's lines stays blocked.
    if tg_op = 'UPDATE'
       and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id'
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id'
    then
      return new;
    end if;
    -- Re-materializing a posted entry's GL-Impact projection from its edited
    -- source document (engine-only 'openbooks.amend' flag). The entry stays
    -- posted; its lines are regenerated to match the transaction. Balance and
    -- account guards still fire on the new lines.
    if v_status = 'posted'
       and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
      if tg_op <> 'DELETE'
         and period_module_is_closed(v_org, v_period, v_book,
           nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl') then
        raise exception 'period is closed for GL posting';
      end if;
      return coalesce(new, old);
    end if;
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;

create trigger jl_guard before insert or update or delete on journal_lines
  for each row execute function jl_guard();

-- ---------------------------------------------------------------------------
-- 3. Lines post only to active, postable (non-summary) accounts.
--    NetSuite allows posting to parent accounts; openbooks refuses.
-- ---------------------------------------------------------------------------
create or replace function jl_check_account() returns trigger
language plpgsql as $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
  select is_summary, is_active, currency_restriction
    into v_summary, v_active, v_ccy
    from accounts where id = new.account_id;
  if not found then
    raise exception 'account % does not exist', new.account_id;
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  -- Historical migration replays may post to accounts that are inactive
  -- TODAY but were active at the time. 'set local openbooks.migration = on'
  -- (transaction-scoped, requires direct DB access) relaxes ONLY this check;
  -- balance, immutability and summary-account rules always hold.
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;

create trigger jl_check_account before insert or update on journal_lines
  for each row execute function jl_check_account();


-- ---------------------------------------------------------------------------
-- 4. FX consistency: base amount = txn amount x rate (0.005 rounding slack).
-- ---------------------------------------------------------------------------
alter table journal_lines add constraint jl_fx_consistent
  check (abs(amount - round(txn_amount * fx_rate, 4)) <= 0.005);

-- ---------------------------------------------------------------------------
-- 5. Applications never exceed the open item, on either side.
-- ---------------------------------------------------------------------------
create or replace function app_check_open() returns trigger
language plpgsql as $$
declare
  v_line numeric(19,4);
  v_applied numeric(19,4);
begin
  -- target side: total applied to the open item <= |line amount|
  select abs(amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(amount), 0) into v_applied
    from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line + 0.005 then
    raise exception 'application exceeds open amount on target line % (% applied of %)',
      new.to_line_id, v_applied + new.amount, v_line;
  end if;

  -- source side: a credit can't be applied beyond its own magnitude
  select abs(amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(amount), 0) into v_applied
    from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line + 0.005 then
    raise exception 'application exceeds available amount on source line %', new.from_line_id;
  end if;
  return new;
end $$;

create constraint trigger app_check_open
  after insert or update on applications
  deferrable initially deferred
  for each row execute function app_check_open();
