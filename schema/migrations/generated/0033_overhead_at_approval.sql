-- Overhead applies WITH the hours, not as a month-end batch: each approved
-- time entry that receives the net-zero overhead pair is stamped with the
-- journal entry that carried it (mirror of cost_journal_entry_id for labor).

alter table time_entries
  add column if not exists overhead_journal_entry_id uuid;

create index if not exists time_entries_overhead_journal_entry
  on time_entries (overhead_journal_entry_id);

alter table time_entries
  add foreign key (overhead_journal_entry_id) references journal_entries(id);
