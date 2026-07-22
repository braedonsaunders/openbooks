alter table item_rate_versions
  add column if not exists custom jsonb not null default '{}'::jsonb;

create table if not exists labor_rate_adjustment_targets (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  adjustment_id uuid not null,
  target_type text not null,
  target_value_id uuid,
  target_value_text text,
  include_children boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint labor_rate_adjustment_targets_type check (target_type in (
    'item', 'item_kind', 'item_category', 'transaction_type', 'department',
    'subsidiary', 'location', 'class', 'trade', 'job_title', 'project',
    'customer', 'other'
  )),
  constraint labor_rate_adjustment_targets_one_value check (
    num_nonnulls(target_value_id, target_value_text) = 1
  )
);
create index if not exists labor_rate_adjustment_targets_adjustment
  on labor_rate_adjustment_targets (adjustment_id);
create unique index if not exists labor_rate_adjustment_targets_unique
  on labor_rate_adjustment_targets
  (adjustment_id, target_type, target_value_id, target_value_text)
  nulls not distinct;

-- Preserve any pre-generalization item applicability as an explicit target.
-- Some legacy databases already dropped item_id while receiving the target
-- table out of band, so the copy must be conditional as well as the DROP.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema='public' and table_name='labor_rate_adjustments' and column_name='item_id'
  ) then
    execute $copy$
      insert into labor_rate_adjustment_targets
        (org_id, adjustment_id, target_type, target_value_id, include_children,
         created_by, updated_by)
      select org_id, id, 'item', item_id, false, created_by, updated_by
        from labor_rate_adjustments
       where item_id is not null
      on conflict do nothing
    $copy$;
  end if;
end $$;

alter table labor_rate_adjustments
  drop constraint if exists labor_rate_adjustments_item_id_items_id_fk;
drop index if exists labor_rate_adjustments_version_item_code;
drop index if exists labor_rate_adjustments_version;
alter table labor_rate_adjustments drop column if exists item_id;
create unique index if not exists labor_rate_adjustments_version_code
  on labor_rate_adjustments (version_id, code);
create index if not exists labor_rate_adjustments_version
  on labor_rate_adjustments (version_id, sort_order);

grant select on labor_rate_adjustment_targets to openbooks_read;

-- The labor-card support tables were introduced after the baseline RLS pass.
-- Apply the same forced org policy as every other tenant-owned pricing table.
do $$
declare
  t text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  foreach t in array array[
    'labor_rate_version_policies',
    'labor_rate_version_scopes',
    'labor_rate_adjustments',
    'labor_rate_adjustment_targets',
    'labor_rate_terms'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', t, body, body);
  end loop;
end $$;
