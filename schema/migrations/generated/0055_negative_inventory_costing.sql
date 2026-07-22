-- Configurable negative inventory with provisional costing and immutable
-- receipt-correction evidence.
alter table item_inventory_profiles
  add column allow_negative_inventory boolean not null default false,
  add column negative_cost_basis text not null default 'last_receipt',
  add column provisional_unit_cost numeric(19,4),
  add constraint item_inventory_negative_basis check (negative_cost_basis in ('last_receipt','standard','configured')),
  add constraint item_inventory_provisional_cost check (provisional_unit_cost is null or provisional_unit_cost >= 0),
  add constraint item_inventory_configured_cost check (negative_cost_basis <> 'configured' or provisional_unit_cost is not null),
  add constraint item_inventory_standard_cost check (negative_cost_basis <> 'standard' or standard_cost is not null);

create table inventory_provisional_costs (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null references orgs(id),
  item_id uuid not null references items(id), stock_location_id uuid not null references stock_locations(id),
  issue_movement_id uuid not null references inventory_movements(id),
  original_quantity numeric(19,4) not null, remaining_quantity numeric(19,4) not null,
  provisional_unit_cost numeric(19,4) not null, cost_basis text not null,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint inventory_provisional_quantity check (original_quantity>0 and remaining_quantity>=0 and remaining_quantity<=original_quantity),
  constraint inventory_provisional_cost check (provisional_unit_cost>=0),
  constraint inventory_provisional_basis check (cost_basis in ('last_receipt','standard','configured'))
);
create index inventory_provisional_fifo on inventory_provisional_costs(item_id,stock_location_id,created_at);

create table inventory_provisional_settlements (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null references orgs(id),
  provisional_cost_id uuid not null references inventory_provisional_costs(id),
  receipt_movement_id uuid not null references inventory_movements(id),
  quantity numeric(19,4) not null, provisional_unit_cost numeric(19,4) not null,
  receipt_unit_cost numeric(19,4) not null, correction_amount numeric(19,4) not null,
  correction_journal_entry_id uuid not null references journal_entries(id),
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint inventory_provisional_settlement_quantity check (quantity>0)
);
create index inventory_provisional_settlement_receipt on inventory_provisional_settlements(receipt_movement_id);

create or replace function inventory_provisional_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('openbooks.sandbox_wipe',true)='on' then return old; end if;
  raise exception 'inventory provisional evidence is immutable';
end $$;
create trigger inventory_provisional_cost_delete before delete on inventory_provisional_costs for each row execute function inventory_provisional_immutable();
create trigger inventory_provisional_settlement_immutable before update or delete on inventory_provisional_settlements for each row execute function inventory_provisional_immutable();

alter table inventory_provisional_costs enable row level security; alter table inventory_provisional_costs force row level security;
create policy org_isolation on inventory_provisional_costs using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true));
alter table inventory_provisional_settlements enable row level security; alter table inventory_provisional_settlements force row level security;
create policy org_isolation on inventory_provisional_settlements using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true));
grant select on inventory_provisional_costs,inventory_provisional_settlements to openbooks_read;
