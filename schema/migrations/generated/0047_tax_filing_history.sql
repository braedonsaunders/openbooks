alter table tax_return_forms
  add column government_format text not null default 'portal_entry',
  add column submission_url text,
  add constraint tax_return_forms_government_format_check
    check (government_format in ('portal_entry', 'certified_file', 'api', 'paper'));

create table tax_filings (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  form_code text not null,
  form_name text not null,
  country text,
  period_from date not null,
  period_to date not null,
  version integer not null,
  status text not null default 'prepared' check (status in ('prepared', 'filed')),
  submission_channel text not null,
  boxes jsonb not null,
  adjustments jsonb not null default '{}'::jsonb,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  filing_reference text,
  filed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_filings_dates_check check (period_from <= period_to),
  constraint tax_filings_version_check check (version > 0),
  constraint tax_filings_boxes_check check (jsonb_typeof(boxes) = 'array'),
  constraint tax_filings_filed_state_check check (
    (status = 'prepared' and filed_at is null) or
    (status = 'filed' and filed_at is not null)
  ),
  constraint tax_filings_period_version unique (org_id, form_code, period_from, period_to, version)
);

create index tax_filings_org_period on tax_filings (org_id, period_to desc);
create index tax_filings_org_status on tax_filings (org_id, status);

grant select on tax_filings to openbooks_read;
