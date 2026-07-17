set local app.bypass_rls = 'on';
--> statement-breakpoint
alter table party_bank_accounts
  add column if not exists approval_status text not null default 'approved';
--> statement-breakpoint
create table if not exists contacts (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  party_id uuid,
  first_name text,
  last_name text,
  name text not null,
  title text,
  role text,
  email text,
  phone text,
  mobile_phone text,
  fax text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  custom jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
--> statement-breakpoint
create index if not exists contacts_party on contacts (party_id);
create index if not exists contacts_org_name on contacts (org_id, name);
grant select on contacts to openbooks_read;
