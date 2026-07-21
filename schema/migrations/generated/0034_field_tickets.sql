-- Field tickets (signed crew timesheets for T&M): a non-posting `documents`
-- kind ('field_ticket'). Header specifics (period, foreman, signatures, send
-- state) live in documents.custom; crew hours are ordinary time_entries rows
-- linked back to their ticket so approval reuses the entire labor-costing
-- chain (rate snapshots, WIP posting, overhead pairs, billing sweeps).

alter table time_entries
  add column if not exists field_ticket_id uuid;

create index if not exists time_entries_field_ticket
  on time_entries (field_ticket_id);

alter table time_entries
  add foreign key (field_ticket_id) references documents(id) on delete set null;
