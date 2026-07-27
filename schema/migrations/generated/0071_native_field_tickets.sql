-- Native Field Ticket domain state. documents.custom remains available only
-- for tenant-defined extensions and upstream source provenance.

create table if not exists field_tickets (
  document_id uuid primary key,
  org_id uuid not null,
  period text not null check (period in ('shift','daily','weekly')),
  period_start date not null,
  period_end date not null,
  foreman_party_id uuid,
  charge_document_id uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint field_tickets_period_order check (period_end >= period_start),
  constraint field_tickets_document_fk foreign key (document_id) references documents(id) on delete cascade,
  constraint field_tickets_org_fk foreign key (org_id) references orgs(id),
  constraint field_tickets_foreman_fk foreign key (foreman_party_id) references parties(id),
  constraint field_tickets_charge_fk foreign key (charge_document_id) references documents(id),
  constraint field_tickets_submitted_by_fk foreign key (submitted_by) references users(id)
);
create index if not exists field_tickets_org_period
  on field_tickets (org_id, period_start, period_end);
create index if not exists field_tickets_foreman
  on field_tickets (org_id, foreman_party_id);

create table if not exists field_ticket_policies (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  scope text not null check (scope in ('organization','customer','project')),
  customer_party_id uuid,
  project_id uuid,
  period text not null check (period in ('shift','daily','weekly')),
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint field_ticket_policies_scope_shape check (
    (scope = 'organization' and customer_party_id is null and project_id is null)
    or (scope = 'customer' and customer_party_id is not null and project_id is null)
    or (scope = 'project' and project_id is not null and customer_party_id is null)
  ),
  constraint field_ticket_policies_date_order check (
    effective_to is null or effective_to >= effective_from
  ),
  constraint field_ticket_policies_org_fk foreign key (org_id) references orgs(id),
  constraint field_ticket_policies_customer_fk foreign key (customer_party_id) references parties(id),
  constraint field_ticket_policies_project_fk foreign key (project_id) references projects(id),
  constraint field_ticket_policies_created_by_fk foreign key (created_by) references users(id),
  constraint field_ticket_policies_updated_by_fk foreign key (updated_by) references users(id)
);
create index if not exists field_ticket_policies_resolution
  on field_ticket_policies
    (org_id, scope, project_id, customer_party_id, effective_from);

create table if not exists field_ticket_signatures (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  field_ticket_id uuid not null,
  role text not null check (role in ('foreman','customer')),
  signer_name text not null,
  comment text,
  signature_file_id uuid not null,
  signed_at timestamptz not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint field_ticket_signatures_org_fk foreign key (org_id) references orgs(id),
  constraint field_ticket_signatures_ticket_fk foreign key (field_ticket_id) references field_tickets(document_id) on delete cascade,
  constraint field_ticket_signatures_file_fk foreign key (signature_file_id) references files(id),
  constraint field_ticket_signatures_created_by_fk foreign key (created_by) references users(id),
  constraint field_ticket_signatures_role unique (org_id, field_ticket_id, role)
);
create index if not exists field_ticket_signatures_ticket
  on field_ticket_signatures (org_id, field_ticket_id);

create table if not exists field_ticket_signature_requests (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  field_ticket_id uuid not null,
  recipient text not null,
  message text,
  sent_at timestamptz,
  expires_at timestamptz not null,
  responded_at timestamptz,
  revoked_at timestamptz,
  token_digest text not null,
  email_log_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint field_ticket_signature_requests_expiry check (sent_at is null or expires_at > sent_at),
  constraint field_ticket_signature_requests_org_fk foreign key (org_id) references orgs(id),
  constraint field_ticket_signature_requests_ticket_fk foreign key (field_ticket_id) references field_tickets(document_id) on delete cascade,
  constraint field_ticket_signature_requests_email_fk foreign key (email_log_id) references email_log(id),
  constraint field_ticket_signature_requests_created_by_fk foreign key (created_by) references users(id)
);
create index if not exists field_ticket_signature_requests_ticket
  on field_ticket_signature_requests (org_id, field_ticket_id, sent_at);
create unique index if not exists field_ticket_signature_requests_token
  on field_ticket_signature_requests (token_digest);

create or replace function field_ticket_policy_guard() returns trigger
language plpgsql as $$
begin
  if new.customer_party_id is not null and not exists (
    select 1 from parties p
     where p.id = new.customer_party_id and p.org_id = new.org_id
  ) then
    raise exception 'field ticket customer policy must belong to the same organization'
      using errcode = '23514';
  end if;
  if new.project_id is not null and not exists (
    select 1 from projects p
     where p.id = new.project_id and p.org_id = new.org_id
  ) then
    raise exception 'field ticket project policy must belong to the same organization'
      using errcode = '23514';
  end if;
  if new.is_active and exists (
    select 1 from field_ticket_policies existing
     where existing.org_id = new.org_id
       and existing.id <> new.id
       and existing.is_active
       and existing.scope = new.scope
       and existing.customer_party_id is not distinct from new.customer_party_id
       and existing.project_id is not distinct from new.project_id
       and daterange(existing.effective_from, existing.effective_to, '[]')
           && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'effective Field Ticket policies cannot overlap for the same scope'
      using errcode = '23P01';
  end if;
  return new;
end $$;
drop trigger if exists field_ticket_policy_integrity on field_ticket_policies;
create trigger field_ticket_policy_integrity
before insert or update on field_ticket_policies
for each row execute function field_ticket_policy_guard();

-- The subtype row and every referenced native record must belong to the same
-- tenant. UUID uniqueness alone is insufficient evidence of tenant ownership.
create or replace function field_ticket_integrity_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from documents d
     where d.id = new.document_id and d.org_id = new.org_id
       and d.kind = 'field_ticket'
  ) then
    raise exception 'field ticket header must extend a field_ticket document in the same organization'
      using errcode = '23514';
  end if;
  if new.foreman_party_id is not null and not exists (
    select 1 from parties p where p.id = new.foreman_party_id and p.org_id = new.org_id
  ) then
    raise exception 'field ticket foreman must belong to the same organization'
      using errcode = '23514';
  end if;
  if new.charge_document_id is not null and not exists (
    select 1 from documents d where d.id = new.charge_document_id and d.org_id = new.org_id
  ) then
    raise exception 'field ticket charge document must belong to the same organization'
      using errcode = '23514';
  end if;
  if new.submitted_by is not null and not exists (
    select 1 from users u where u.id = new.submitted_by and u.org_id = new.org_id
  ) then
    raise exception 'field ticket submitter must belong to the same organization'
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists field_ticket_integrity on field_tickets;
create trigger field_ticket_integrity
before insert or update on field_tickets
for each row execute function field_ticket_integrity_guard();

create or replace function field_ticket_evidence_integrity_guard() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from field_tickets ft
     where ft.document_id = new.field_ticket_id and ft.org_id = new.org_id
  ) then
    raise exception 'field ticket evidence must belong to the same organization'
      using errcode = '23514';
  end if;
  if tg_table_name = 'field_ticket_signatures' and not exists (
    select 1 from files f
     where f.id = new.signature_file_id and f.org_id = new.org_id
  ) then
    raise exception 'field ticket signature file must belong to the same organization'
      using errcode = '23514';
  end if;
  if tg_table_name = 'field_ticket_signature_requests'
     and new.email_log_id is not null and not exists (
       select 1 from email_log e
        where e.id = new.email_log_id and e.org_id = new.org_id
     )
  then
    raise exception 'field ticket signature email evidence must belong to the same organization'
      using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists field_ticket_signature_integrity on field_ticket_signatures;
create trigger field_ticket_signature_integrity
before insert on field_ticket_signatures
for each row execute function field_ticket_evidence_integrity_guard();
drop trigger if exists field_ticket_signature_request_integrity on field_ticket_signature_requests;
create trigger field_ticket_signature_request_integrity
before insert or update on field_ticket_signature_requests
for each row execute function field_ticket_evidence_integrity_guard();

create or replace function field_ticket_signature_immutable_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'field ticket signatures are append-only evidence';
end $$;
drop trigger if exists field_ticket_signature_immutable on field_ticket_signatures;
create trigger field_ticket_signature_immutable
before update or delete on field_ticket_signatures
for each row execute function field_ticket_signature_immutable_guard();

create or replace function field_ticket_signature_request_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'field ticket signature requests are retained evidence';
  end if;
  if row(new.org_id, new.field_ticket_id, new.recipient, new.message,
         new.expires_at, new.token_digest, new.email_log_id,
         new.created_by, new.created_at)
     is distinct from
     row(old.org_id, old.field_ticket_id, old.recipient, old.message,
         old.expires_at, old.token_digest, old.email_log_id,
         old.created_by, old.created_at)
  then
    raise exception 'field ticket signature request evidence is immutable';
  end if;
  if old.responded_at is not null and new.responded_at is distinct from old.responded_at then
    raise exception 'field ticket signature response timestamp is immutable once set';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'field ticket signature revocation timestamp is immutable once set';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'field ticket signature delivery timestamp is immutable once set';
  end if;
  return new;
end $$;
drop trigger if exists field_ticket_signature_request_immutable on field_ticket_signature_requests;
create trigger field_ticket_signature_request_immutable
before update or delete on field_ticket_signature_requests
for each row execute function field_ticket_signature_request_guard();

alter table field_tickets enable row level security;
alter table field_tickets force row level security;
drop policy if exists org_isolation on field_tickets;
create policy org_isolation on field_tickets
  using (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true));

alter table field_ticket_policies enable row level security;
alter table field_ticket_policies force row level security;
drop policy if exists org_isolation on field_ticket_policies;
create policy org_isolation on field_ticket_policies
  using (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true));

alter table field_ticket_signatures enable row level security;
alter table field_ticket_signatures force row level security;
drop policy if exists org_isolation on field_ticket_signatures;
create policy org_isolation on field_ticket_signatures
  using (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true));

alter table field_ticket_signature_requests enable row level security;
alter table field_ticket_signature_requests force row level security;
drop policy if exists org_isolation on field_ticket_signature_requests;
create policy org_isolation on field_ticket_signature_requests
  using (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
    or org_id::text = current_setting('app.current_org', true));
