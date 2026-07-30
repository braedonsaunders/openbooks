-- Append-only cancellation lineage for revenue-recognition schedules.
--
-- A posted recognition line keeps its original journal forever. Cancellation
-- records the exact compensating journal separately and freezes the financial
-- identity of the schedule line.

alter table recognition_schedule_lines
  add column if not exists reversal_journal_entry_id uuid
    references journal_entries(id);

alter table performance_obligations
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references users(id);

create unique index if not exists recognition_lines_posted_entry_unique
  on recognition_schedule_lines (journal_entry_id)
  where journal_entry_id is not null;

create unique index if not exists recognition_lines_reversal_entry_unique
  on recognition_schedule_lines (reversal_journal_entry_id)
  where reversal_journal_entry_id is not null;

alter table recognition_schedule_lines
  drop constraint if exists recognition_line_reversal_shape;
alter table recognition_schedule_lines
  add constraint recognition_line_reversal_shape check (
    reversal_journal_entry_id is null
    or (
      journal_entry_id is not null
      and reversal_journal_entry_id <> journal_entry_id
    )
  );

alter table performance_obligations
  drop constraint if exists performance_obligation_cancellation_shape;
alter table performance_obligations
  add constraint performance_obligation_cancellation_shape check (
    (
      status = 'cancelled'
      and cancellation_reason is not null
      and length(btrim(cancellation_reason)) between 5 and 500
      and cancelled_at is not null
      and cancelled_by is not null
    )
    or (
      status <> 'cancelled'
      and cancellation_reason is null
      and cancelled_at is null
      and cancelled_by is null
    )
  ) not valid;

create or replace function guard_recognition_schedule_line_financial_history()
returns trigger
language plpgsql
as $$
begin
  if old.journal_entry_id is not null then
    if new.schedule_id is distinct from old.schedule_id
       or new.period_id is distinct from old.period_id
       or new.sequence is distinct from old.sequence
       or new.planned_amount is distinct from old.planned_amount
       or new.recognized_amount is distinct from old.recognized_amount
       or new.journal_entry_id is distinct from old.journal_entry_id then
      raise exception
        'posted revenue-recognition schedule line financial history is immutable';
    end if;
  end if;

  if old.reversal_journal_entry_id is not null
     and new.reversal_journal_entry_id is distinct from old.reversal_journal_entry_id then
    raise exception
      'revenue-recognition reversal lineage is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists recognition_schedule_line_financial_history_guard
  on recognition_schedule_lines;
create trigger recognition_schedule_line_financial_history_guard
before update on recognition_schedule_lines
for each row
execute function guard_recognition_schedule_line_financial_history();
