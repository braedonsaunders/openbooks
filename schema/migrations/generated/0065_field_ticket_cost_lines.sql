alter table document_lines add column if not exists field_ticket_id uuid;
create index if not exists document_lines_field_ticket on document_lines (field_ticket_id) where field_ticket_id is not null;
alter table billing_requests drop constraint if exists billing_requests_basis_check;
alter table billing_requests add constraint billing_requests_basis_check check (basis in ('date_range','draw_amount','time_selection','milestone','field_ticket'));
