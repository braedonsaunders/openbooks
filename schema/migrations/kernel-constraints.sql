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
  v_old_entry uuid;
  v_sum numeric(19,4);
begin
  v_entry := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
  v_old_entry := case when tg_op = 'UPDATE' then old.entry_id else null end;
  foreach v_entry in array array[v_entry, v_old_entry] loop
    if v_entry is null then continue; end if;
    select coalesce(sum(amount), 0) into v_sum
      from journal_lines where entry_id = v_entry;
    if v_sum <> 0 then
      raise exception 'journal entry % does not balance (sum = %)', v_entry, v_sum
        using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

create constraint trigger jl_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function jl_check_balanced();

-- A line trigger alone is insufficient: a defective write path could build an
-- unbalanced draft, satisfy/defer the line events, and later flip only the
-- entry header to posted. Independently re-prove both whole-entry and legal-
-- entity balance on every transition that ends in POSTED status.
create or replace function je_check_posted_balance() returns trigger
language plpgsql as $$
declare
  v_sum numeric(19,4);
  v_bad record;
begin
  if new.status <> 'posted' then return null; end if;
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines where entry_id = new.id;
  if v_sum <> 0 then
    raise exception 'posted journal entry % does not balance (sum = %)', new.id, v_sum
      using errcode = '23514';
  end if;
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines where entry_id = new.id
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'posted journal entry % does not balance for subsidiary % (sum = %)',
      new.id, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  if (select count(*) from journal_lines where entry_id = new.id) < 2 then
    raise exception 'posted journal entry % must contain at least two lines', new.id
      using errcode = '23514';
  end if;
  return null;
end $$;

drop trigger if exists je_posted_balanced on journal_entries;
create constraint trigger je_posted_balanced
  after insert or update of status on journal_entries
  deferrable initially deferred
  for each row execute function je_check_posted_balance();

-- The baseline defines the per-subsidiary constraint trigger. Replace its
-- function here so an UPDATE that reassigns a line validates BOTH the old and
-- new entries, exactly like the whole-entry trigger above.
create or replace function jl_check_balanced_by_subsidiary() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  v_new_entry uuid;
  v_old_entry uuid;
  v_bad record;
begin
  v_new_entry := case when tg_op = 'DELETE' then null else new.entry_id end;
  v_old_entry := case when tg_op in ('UPDATE', 'DELETE') then old.entry_id else null end;
  foreach v_entry in array array[v_new_entry, v_old_entry] loop
    if v_entry is null then continue; end if;
    select subsidiary_id, sum(amount) as total into v_bad
      from journal_lines where entry_id = v_entry
     group by subsidiary_id having sum(amount) <> 0 limit 1;
    if found then
      raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
        v_entry, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
    end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Posted entries are locked by default; posting requires an open period.
--    A tightly scoped engine transaction may set openbooks.amend=on to
--    re-materialize or delete a posted transaction in an OPEN period. Every
--    such operation must write immutable before/after evidence to audit_log in
--    the same transaction. Closed-period GL impact is never amended in place.
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
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
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
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
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
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
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

-- The business and GL state of an open-period transaction may change, so its
-- audit evidence is the permanent history. Audit rows themselves can only be
-- inserted; even an engine amendment cannot rewrite or remove them.
create or replace function audit_log_append_only_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  raise exception 'audit_log is append-only';
end $$;

drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function audit_log_append_only_guard();

-- Prepared tax-return snapshots are evidence, not a mutable working table.
-- A user may only transition a prepared snapshot to filed and record the
-- government reference/timestamp; every value used to prepare it stays frozen.
create or replace function tax_filing_immutable_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    raise exception 'tax filing snapshots cannot be deleted';
  end if;
  if old.status = 'prepared' and new.status = 'filed'
     and (to_jsonb(new) - 'status' - 'filing_reference' - 'filed_at' - 'updated_at' - 'updated_by')
       = (to_jsonb(old) - 'status' - 'filing_reference' - 'filed_at' - 'updated_at' - 'updated_by')
  then
    return new;
  end if;
  raise exception 'tax filing snapshots are immutable';
end $$;

drop trigger if exists tax_filing_immutable on tax_filings;
create trigger tax_filing_immutable before update or delete on tax_filings
  for each row execute function tax_filing_immutable_guard();

-- ---------------------------------------------------------------------------
-- 3. Lines post only to active, postable (non-summary) accounts.
--    source platform allows posting to parent accounts; openbooks refuses.
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

-- Account-specific required dimensions are part of the posting contract.
-- Built-ins use physical columns; registry-defined segments use extra_dims.
create or replace function jl_check_required_dimensions() returns trigger
language plpgsql as $$
declare v_key text; v_required jsonb;
begin
  select required_dimensions into v_required from accounts
   where id = new.account_id and org_id = new.org_id;
  for v_key in select jsonb_array_elements_text(coalesce(v_required, '[]'::jsonb)) loop
    if (case v_key
      when 'subsidiary' then new.subsidiary_id is null
      when 'department' then new.department_id is null
      when 'project' then new.project_id is null
      when 'location' then new.location_id is null
      when 'class' then new.class_id is null
      when 'party' then new.party_id is null
      else not (coalesce(new.extra_dims, '{}'::jsonb) ? v_key)
    end) then
      raise exception 'account % requires segment %', new.account_id, v_key using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists jl_check_required_dimensions on journal_lines;
create trigger jl_check_required_dimensions before insert or update on journal_lines
  for each row execute function jl_check_required_dimensions();

-- ---------------------------------------------------------------------------
-- 4. FX consistency: base amount = txn amount x rate (0.005 rounding slack).
-- ---------------------------------------------------------------------------
alter table journal_lines add constraint jl_fx_consistent
  check (abs(amount - round(txn_amount * fx_rate, 4)) <= 0.005);

-- ---------------------------------------------------------------------------
-- 5. Applications never exceed the open item, on either side.
-- ---------------------------------------------------------------------------
create or replace function app_validate_endpoints() returns trigger
language plpgsql as $$
declare
  v_from journal_lines%rowtype;
  v_to journal_lines%rowtype;
  v_fx fx_rates%rowtype;
  v_status_count integer;
begin
  -- Deterministic row locks serialize competing applications to either line.
  perform id from journal_lines
   where id in (new.from_line_id, new.to_line_id)
   order by id for update;
  select * into v_from from journal_lines where id = new.from_line_id;
  select * into v_to from journal_lines where id = new.to_line_id;
  if v_from.id is null or v_to.id is null or v_from.id = v_to.id then
    raise exception 'application endpoints must be two distinct journal lines' using errcode = '23514';
  end if;
  if v_from.org_id <> new.org_id or v_to.org_id <> new.org_id
     or v_from.org_id <> v_to.org_id then
    raise exception 'application endpoints must belong to the application tenant' using errcode = '23514';
  end if;
  if new.unapplied_at is not null then return new; end if;
  if not v_from.is_open_item or not v_to.is_open_item then
    raise exception 'applications require open-item journal lines' using errcode = '23514';
  end if;
  if v_from.account_id <> v_to.account_id
     or v_from.party_id is distinct from v_to.party_id
     or v_from.subsidiary_id <> v_to.subsidiary_id then
    raise exception 'application endpoints must share account, party, and subsidiary' using errcode = '23514';
  end if;
  if sign(v_from.amount) = sign(v_to.amount) then
    raise exception 'application endpoints must have opposite debit/credit signs' using errcode = '23514';
  end if;
  if v_from.currency <> new.source_transaction_currency
     or v_to.currency <> new.target_transaction_currency then
    raise exception 'application source and target currencies must match their journal lines' using errcode = '23514';
  end if;
  if abs(new.target_transaction_amount - round(new.source_transaction_amount * new.settlement_rate, 4)) > 0.0001 then
    raise exception 'application settlement rate does not cross-foot source and target transaction amounts' using errcode = '23514';
  end if;
  if new.source_transaction_currency = new.target_transaction_currency then
    if new.source_transaction_amount <> new.target_transaction_amount
       or new.settlement_rate <> 1
       or new.settlement_rate_source <> 'same_currency' then
      raise exception 'same-currency applications require equal transaction amounts and a rate of one' using errcode = '23514';
    end if;
  elsif new.settlement_rate_source = 'same_currency' then
    raise exception 'cross-currency applications require explicit settlement-rate evidence' using errcode = '23514';
  end if;
  if new.settlement_rate_source = 'provider' and new.settlement_fx_rate_id is null then
    raise exception 'provider settlement evidence requires an FX rate observation' using errcode = '23514';
  end if;
  if new.settlement_fx_rate_id is not null then
    select * into v_fx from fx_rates where id = new.settlement_fx_rate_id;
    if v_fx.id is null
       or v_fx.org_id <> new.org_id
       or v_fx.from_currency <> new.source_transaction_currency
       or v_fx.to_currency <> new.target_transaction_currency
       or v_fx.rate <> new.settlement_rate
       or v_fx.as_of > new.applied_on then
      raise exception 'settlement FX observation does not match the application evidence' using errcode = '23514';
    end if;
  end if;
  select count(*) into v_status_count from journal_entries
   where id in (v_from.entry_id, v_to.entry_id) and status = 'posted';
  if v_status_count <> 2 then
    raise exception 'applications may only connect posted journal entries' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists app_validate_endpoints on applications;
create trigger app_validate_endpoints before insert or update on applications
  for each row execute function app_validate_endpoints();

create or replace function app_check_open() returns trigger
language plpgsql as $$
declare
  v_line numeric(19,4);
  v_applied numeric(19,4);
  v_transaction numeric(19,4);
begin
  if new.unapplied_at is not null then return new; end if;
  -- target side: total applied to the open item <= |line amount|
  select abs(amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(amount), 0) into v_applied
    from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line then
    raise exception 'application exceeds open amount on target line % (% applied of %)',
      new.to_line_id, v_applied + new.amount, v_line;
  end if;

  select abs(txn_amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(target_transaction_amount), 0) into v_transaction from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.target_transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on target line %', new.to_line_id using errcode = '23514';
  end if;

  -- source side uses its independently recorded carrying amount.
  select abs(amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(source_amount), 0) into v_applied
    from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.source_amount > v_line then
    raise exception 'application exceeds available amount on source line %', new.from_line_id using errcode = '23514';
  end if;
  select abs(txn_amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(source_transaction_amount), 0) into v_transaction from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_transaction + new.source_transaction_amount > v_line then
    raise exception 'application exceeds transaction amount on source line %', new.from_line_id using errcode = '23514';
  end if;
  return new;
end $$;

create constraint trigger app_check_open
  after insert or update on applications
  deferrable initially deferred
  for each row execute function app_check_open();

create or replace function application_evidence_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    raise exception 'application evidence is immutable; unapply it instead';
  end if;
  if new.org_id is distinct from old.org_id
     or new.from_line_id is distinct from old.from_line_id
     or new.to_line_id is distinct from old.to_line_id
     or new.amount is distinct from old.amount
     or new.source_amount is distinct from old.source_amount
     or new.source_transaction_amount is distinct from old.source_transaction_amount
     or new.source_transaction_currency is distinct from old.source_transaction_currency
     or new.target_transaction_amount is distinct from old.target_transaction_amount
     or new.target_transaction_currency is distinct from old.target_transaction_currency
     or new.settlement_rate is distinct from old.settlement_rate
     or new.settlement_rate_source is distinct from old.settlement_rate_source
     or new.settlement_rate_reference is distinct from old.settlement_rate_reference
     or new.settlement_fx_rate_id is distinct from old.settlement_fx_rate_id
     or new.applied_on is distinct from old.applied_on
     or new.fx_gain_loss_entry_id is distinct from old.fx_gain_loss_entry_id
     or old.unapplied_at is not null
     or new.unapplied_at is null then
    raise exception 'application evidence is immutable; only a one-time unapply is allowed';
  end if;
  return new;
end $$;

drop trigger if exists application_evidence_guard on applications;
create trigger application_evidence_guard before update or delete on applications
  for each row execute function application_evidence_guard();

-- Tax component rows are the immutable explanation of a posted line's tax.
create or replace function document_line_tax_component_guard() returns trigger
language plpgsql as $$
declare v_status text;
declare v_org uuid;
begin
  v_org := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(v_org) then return old; end if;
  select d.status into v_status
    from documents d join document_lines dl on dl.document_id = d.id
   where dl.id = case when tg_op = 'DELETE' then old.document_line_id else new.document_line_id end;
  if v_status <> 'draft'
     and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
    raise exception 'posted tax calculation evidence is immutable';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists document_line_tax_component_guard on document_line_tax_components;
create trigger document_line_tax_component_guard
  before insert or update or delete on document_line_tax_components
  for each row execute function document_line_tax_component_guard();

-- Application changes normally refresh denormalized document open balances.
-- A sandbox wipe removes both sides, so the private, sandbox-verified lifecycle
-- context skips those otherwise quadratic and meaningless recomputations.
create or replace function trg_application_open_balance() returns trigger
language plpgsql as $$
declare v_doc uuid;
begin
  if openbooks_sandbox_wipe_allowed(
       case when tg_op = 'DELETE' then old.org_id else new.org_id end
     ) then
    return null;
  end if;
  for v_doc in
    select distinct d.id
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id
     where jl.is_open_item
       and jl.id in (coalesce(new.to_line_id, old.to_line_id),
                     coalesce(new.from_line_id, old.from_line_id))
  loop
    perform recompute_document_open_balance(v_doc);
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Payment artifacts and lifecycle evidence are immutable.
-- ---------------------------------------------------------------------------
create or replace function payment_event_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  raise exception 'payment events are append-only';
end $$;

create trigger payment_event_immutable before update or delete on payment_events
  for each row execute function payment_event_immutable();

create or replace function payment_file_artifact_immutable() returns trigger
language plpgsql as $$
begin
  if new.payment_run_id is distinct from old.payment_run_id
     or new.payment_bank_profile_id is distinct from old.payment_bank_profile_id
     or new.payment_format_id is distinct from old.payment_format_id
     or new.parent_payment_file_id is distinct from old.parent_payment_file_id
     or new.sequence_number is distinct from old.sequence_number
     or new.filename is distinct from old.filename
     or new.content_type is distinct from old.content_type
     or new.content_hash is distinct from old.content_hash
     or new.file_id is distinct from old.file_id
     or new.file_version_id is distinct from old.file_version_id
     or new.payment_count is distinct from old.payment_count
     or new.total_amount is distinct from old.total_amount
     or new.currency is distinct from old.currency
     or new.generated_at is distinct from old.generated_at
     or new.generated_by is distinct from old.generated_by then
    raise exception 'generated payment file artifacts are immutable; reprocess into a new file';
  end if;
  return new;
end $$;

create trigger payment_file_artifact_immutable before update on payment_files
  for each row execute function payment_file_artifact_immutable();

create or replace function payment_run_item_guard() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from payment_runs where id = coalesce(new.payment_run_id, old.payment_run_id);
  if tg_op = 'DELETE' and v_status not in ('draft', 'pending_approval')
     and not openbooks_sandbox_wipe_allowed(old.org_id) then
    raise exception 'payment run items are immutable once the run is approved';
  end if;
  if tg_op = 'UPDATE' and v_status not in ('draft', 'pending_approval') and (
     new.payment_run_id is distinct from old.payment_run_id
     or new.payment_instruction_id is distinct from old.payment_instruction_id
     or new.source_document_id is distinct from old.source_document_id
     or new.source_open_line_id is distinct from old.source_open_line_id
     or new.kind is distinct from old.kind
     or new.gross_amount is distinct from old.gross_amount
     or new.discount_amount is distinct from old.discount_amount
     or new.credit_amount is distinct from old.credit_amount
     or new.payment_amount is distinct from old.payment_amount
     or new.currency is distinct from old.currency
     or new.fx_rate is distinct from old.fx_rate) then
    raise exception 'payment run item composition is immutable once the run is approved';
  end if;
  return coalesce(new, old);
end $$;

create trigger payment_run_item_guard before update or delete on payment_run_items
  for each row execute function payment_run_item_guard();
-- Manual and production-usage depreciation evidence is append-preserved.
-- A replacement voids an unposted input and inserts a successor; evidence that
-- has reached the ledger can never be edited or deleted.
create or replace function openbooks_guard_depreciation_evidence()
returns trigger language plpgsql as $$
declare
  posted boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'depreciation input evidence is append-preserved';
  end if;

  select exists (
    select 1 from depreciation_schedule_lines
     where input_id = old.id and posted_amount is not null
  ) into posted;
  if posted then
    raise exception 'posted depreciation input evidence is immutable';
  end if;

  if old.voided_at is not null
     or new.voided_at is null
     or new.voided_by is null
     or new.org_id is distinct from old.org_id
     or new.schedule_id is distinct from old.schedule_id
     or new.period_id is distinct from old.period_id
     or new.kind is distinct from old.kind
     or new.manual_amount is distinct from old.manual_amount
     or new.production_units is distinct from old.production_units
     or new.memo is distinct from old.memo
     or new.evidence_reference is distinct from old.evidence_reference
     or new.supersedes_input_id is distinct from old.supersedes_input_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'depreciation input evidence may only be voided before posting';
  end if;
  return new;
end;
$$;

drop trigger if exists depreciation_input_evidence_guard on depreciation_inputs;
create trigger depreciation_input_evidence_guard
before update or delete on depreciation_inputs
for each row execute function openbooks_guard_depreciation_evidence();

create or replace function openbooks_validate_depreciation_line_input()
returns trigger language plpgsql as $$
declare
  input_row depreciation_inputs%rowtype;
  schedule_method text;
begin
  if new.source in ('formula', 'imported') then return new; end if;
  select * into input_row from depreciation_inputs where id = new.input_id;
  if not found
     or input_row.voided_at is not null
     or input_row.org_id <> new.org_id
     or input_row.schedule_id <> new.schedule_id
     or input_row.period_id <> new.period_id then
    raise exception 'depreciation line input evidence does not match its schedule and period';
  end if;
  select method into schedule_method from depreciation_schedules where id = new.schedule_id;
  if (new.source = 'manual' and (input_row.kind <> 'manual' or schedule_method <> 'manual'))
     or (new.source = 'production_usage' and (input_row.kind <> 'production_usage' or schedule_method <> 'units_of_production')) then
    raise exception 'depreciation line source does not match its method evidence';
  end if;
  return new;
end;
$$;

drop trigger if exists depreciation_line_input_guard on depreciation_schedule_lines;
create trigger depreciation_line_input_guard
before insert or update of schedule_id, period_id, source, input_id on depreciation_schedule_lines
for each row execute function openbooks_validate_depreciation_line_input();
