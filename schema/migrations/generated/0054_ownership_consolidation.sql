-- Effective-dated ownership, acquisition/NCI policy, and immutable adjustment
-- evidence for full, proportionate, and equity-method consolidation.
create table subsidiary_ownership_interests (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null,
  parent_subsidiary_id uuid not null, subsidiary_id uuid not null,
  effective_from date not null, effective_to date, ownership_percent numeric(19,10) not null,
  method text not null default 'full', acquisition_date date not null,
  acquisition_cost numeric(19,4) not null default 0, fair_value_net_assets numeric(19,4) not null default 0,
  acquisition_rate numeric(19,10) not null default 1,
  nci_measurement text not null default 'proportionate', nci_fair_value numeric(19,4),
  investment_account_id uuid not null, equity_income_account_id uuid not null,
  distribution_account_id uuid, distribution_income_account_id uuid,
  nci_equity_account_id uuid, nci_income_account_id uuid, goodwill_account_id uuid, fair_value_adjustment_account_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint subsidiary_ownership_method check (method in ('full','proportionate','equity')),
  constraint subsidiary_ownership_nci_method check (nci_measurement in ('proportionate','fair_value')),
  constraint subsidiary_ownership_distinct check (parent_subsidiary_id <> subsidiary_id),
  constraint subsidiary_ownership_percent check (ownership_percent > 0 and ownership_percent <= 100),
  constraint subsidiary_ownership_dates check (effective_to is null or effective_to >= effective_from),
  constraint subsidiary_ownership_acquisition check (acquisition_date <= effective_from),
  constraint subsidiary_ownership_positive_values check (acquisition_cost >= 0 and fair_value_net_assets >= 0 and acquisition_rate > 0 and (nci_fair_value is null or nci_fair_value >= 0)),
  constraint subsidiary_ownership_nci_fair_value check (nci_measurement <> 'fair_value' or nci_fair_value is not null)
);
create unique index subsidiary_ownership_identity on subsidiary_ownership_interests(parent_subsidiary_id, subsidiary_id, effective_from);
create index subsidiary_ownership_effective on subsidiary_ownership_interests(org_id, subsidiary_id, effective_from, effective_to);
create table ownership_consolidation_runs (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, period_id uuid not null,
  status text not null default 'running', error text, started_at timestamptz not null default now(), finished_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint ownership_runs_status check (status in ('running','posted','failed'))
);
create index ownership_runs_period on ownership_consolidation_runs(org_id, period_id, started_at);
create table ownership_consolidation_entries (
  id uuid primary key default uuid_generate_v7(), org_id uuid not null, run_id uuid not null, interest_id uuid not null,
  kind text not null, journal_entry_id uuid not null,
  created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
  constraint ownership_entries_kind check (kind in ('acquisition','nci_income','equity_income','reversal'))
);
create index ownership_entries_run_interest_kind on ownership_consolidation_entries(run_id, interest_id, kind);
alter table subsidiary_ownership_interests
  add foreign key (org_id) references orgs(id), add foreign key (parent_subsidiary_id) references subsidiaries(id),
  add foreign key (subsidiary_id) references subsidiaries(id), add foreign key (investment_account_id) references accounts(id),
  add foreign key (equity_income_account_id) references accounts(id), add foreign key (distribution_account_id) references accounts(id),
  add foreign key (distribution_income_account_id) references accounts(id), add foreign key (nci_equity_account_id) references accounts(id),
  add foreign key (nci_income_account_id) references accounts(id), add foreign key (goodwill_account_id) references accounts(id),
  add foreign key (fair_value_adjustment_account_id) references accounts(id);
alter table ownership_consolidation_runs add foreign key (org_id) references orgs(id), add foreign key (period_id) references accounting_periods(id);
alter table ownership_consolidation_entries add foreign key (org_id) references orgs(id), add foreign key (run_id) references ownership_consolidation_runs(id) on delete cascade, add foreign key (interest_id) references subsidiary_ownership_interests(id), add foreign key (journal_entry_id) references journal_entries(id);
create or replace function ownership_interest_guard() returns trigger language plpgsql as $$
declare actual_parent uuid; bad_account boolean;
begin
  select parent_id into actual_parent from subsidiaries where id=new.subsidiary_id and org_id=new.org_id and is_active and not is_elimination;
  if actual_parent is distinct from new.parent_subsidiary_id or not exists (select 1 from subsidiaries where id=new.parent_subsidiary_id and org_id=new.org_id and is_active and not is_elimination) then raise exception 'ownership interest must follow the active tenant consolidation hierarchy'; end if;
  if exists (select 1 from subsidiary_ownership_interests x where x.org_id=new.org_id and x.subsidiary_id=new.subsidiary_id and x.id<>new.id and x.is_active and new.is_active and daterange(x.effective_from,coalesce(x.effective_to,'infinity'::date),'[]') && daterange(new.effective_from,coalesce(new.effective_to,'infinity'::date),'[]')) then raise exception 'ownership effective dates overlap for the subsidiary'; end if;
  select exists (select 1 from unnest(array_remove(array[new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id],null)) wanted(id) where not exists (select 1 from accounts a where a.id=wanted.id and a.org_id=new.org_id and a.is_active and not a.is_summary)) into bad_account;
  if bad_account then raise exception 'ownership accounts must be active postable accounts in the tenant'; end if;
  if new.method='full' and new.ownership_percent<100 and (new.nci_equity_account_id is null or new.nci_income_account_id is null) then raise exception 'full consolidation below 100 percent requires NCI equity and income accounts'; end if;
  if new.method='full' and (new.goodwill_account_id is null or new.fair_value_adjustment_account_id is null) then raise exception 'full consolidation requires goodwill and fair-value adjustment accounts'; end if;
  if new.distribution_account_id is not null and new.distribution_income_account_id is null then raise exception 'distribution income account is required when a distribution account is configured'; end if;
  if tg_op='UPDATE' and exists(select 1 from ownership_consolidation_entries where interest_id=old.id) and row(new.org_id,new.parent_subsidiary_id,new.subsidiary_id,new.effective_from,new.effective_to,new.ownership_percent,new.method,new.acquisition_date,new.acquisition_cost,new.fair_value_net_assets,new.acquisition_rate,new.nci_measurement,new.nci_fair_value,new.investment_account_id,new.equity_income_account_id,new.distribution_account_id,new.distribution_income_account_id,new.nci_equity_account_id,new.nci_income_account_id,new.goodwill_account_id,new.fair_value_adjustment_account_id,new.is_active) is distinct from row(old.org_id,old.parent_subsidiary_id,old.subsidiary_id,old.effective_from,old.effective_to,old.ownership_percent,old.method,old.acquisition_date,old.acquisition_cost,old.fair_value_net_assets,old.acquisition_rate,old.nci_measurement,old.nci_fair_value,old.investment_account_id,old.equity_income_account_id,old.distribution_account_id,old.distribution_income_account_id,old.nci_equity_account_id,old.nci_income_account_id,old.goodwill_account_id,old.fair_value_adjustment_account_id,old.is_active) then raise exception 'used ownership policy is immutable; close it and create a new effective-dated policy'; end if;
  return new;
end $$;
create trigger ownership_interest_guard before insert or update on subsidiary_ownership_interests for each row execute function ownership_interest_guard();
alter table subsidiary_ownership_interests enable row level security; alter table subsidiary_ownership_interests force row level security;
create policy org_isolation on subsidiary_ownership_interests using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true));
alter table ownership_consolidation_runs enable row level security; alter table ownership_consolidation_runs force row level security;
create policy org_isolation on ownership_consolidation_runs using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true));
alter table ownership_consolidation_entries enable row level security; alter table ownership_consolidation_entries force row level security;
create policy org_isolation on ownership_consolidation_entries using (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true)) with check (current_setting('app.bypass_rls',true)='on' or org_id::text=current_setting('app.current_org',true));
grant select on subsidiary_ownership_interests, ownership_consolidation_runs, ownership_consolidation_entries to openbooks_read;
