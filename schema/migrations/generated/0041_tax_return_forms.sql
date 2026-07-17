-- Configurable government tax returns. A tenant-owned form (tax_return_forms)
-- plus richer boxes on tax_report_lines: a `sequence` (order + evaluation),
-- an optional `formula` (computed boxes, e.g. GST34 line 109 = "105 - 108"),
-- and an optional `pdf_field` (official-PDF overlay). `basis` becomes nullable
-- because computed boxes are not GL-mapped. All of it is UI-editable via the
-- Setup registry; openbooks computes the box values from the ledger.

create table tax_return_forms (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  country text,
  region text,
  submission_channel text not null default 'portal_manual',
  watermark text,
  official_pdf_file_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint tax_return_forms_channel_check
    check (submission_channel in ('print_pdf', 'file_upload', 'efile_api', 'portal_manual')),
  constraint tax_return_forms_code_org unique (org_id, code)
);

create index tax_return_forms_org on tax_return_forms (org_id);

alter table tax_report_lines
  add column sequence integer not null default 0,
  add column formula text,
  add column pdf_field text;

alter table tax_report_lines alter column basis drop not null;
