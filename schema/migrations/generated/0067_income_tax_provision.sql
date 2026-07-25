-- ASC 740 income-tax provision: enacted rate config, provision runs, and
-- measured temporary differences.

CREATE TABLE IF NOT EXISTS income_tax_rates (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  jurisdiction text NOT NULL,
  subsidiary_id uuid,
  rate_percent numeric(19,4) NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT income_tax_rates_valid_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS income_tax_rates_scope ON income_tax_rates (org_id, subsidiary_id, is_active, effective_from);

CREATE TABLE IF NOT EXISTS tax_provision_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  fiscal_year integer NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  snapshot_hash text NOT NULL,
  payload jsonb NOT NULL,
  journal_entry_id uuid,
  posted_at timestamptz,
  posted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT tax_provision_runs_status_chk CHECK (status IN ('draft', 'posted', 'superseded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_provision_runs_org_fy_version ON tax_provision_runs (org_id, fiscal_year, version);
CREATE INDEX IF NOT EXISTS tax_provision_runs_org ON tax_provision_runs (org_id, fiscal_year, status);

CREATE TABLE IF NOT EXISTS temporary_differences (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  subsidiary_id uuid,
  book_basis numeric(19,4) NOT NULL DEFAULT 0,
  tax_basis numeric(19,4) NOT NULL DEFAULT 0,
  difference numeric(19,4) NOT NULL,
  rate_percent numeric(19,4) NOT NULL,
  tax_effect numeric(19,4) NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT temporary_differences_category_chk CHECK (category IN ('fixed_assets', 'revenue_recognition', 'provisions', 'loss_carryforward', 'other')),
  CONSTRAINT temporary_differences_source_chk CHECK (source IN ('auto', 'manual'))
);
CREATE INDEX IF NOT EXISTS temporary_differences_run ON temporary_differences (run_id);
CREATE INDEX IF NOT EXISTS temporary_differences_org ON temporary_differences (org_id, category);

-- Tenant isolation + read role (standard pattern, matches 0041 et al.)
do $$
declare
  tbl text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  foreach tbl in array array[
    'income_tax_rates',
    'tax_provision_runs',
    'temporary_differences'
  ]
  loop
    execute format('grant select on %I to openbooks_read', tbl);
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format('drop policy if exists org_isolation on %I', tbl);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', tbl, body, body);
  end loop;
end $$;
