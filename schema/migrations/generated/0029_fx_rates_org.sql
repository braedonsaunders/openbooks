-- Daily FX rates are tenant configuration. The original table was global,
-- which could leak one tenant's manual/imported rate into another tenant's
-- postings and consolidation. Preserve any pre-cutover rows by copying the
-- legacy set into every existing org, then enforce org scoping and RLS.
set local app.bypass_rls = 'on';
--> statement-breakpoint
create temporary table fx_rates_legacy as
select from_currency, to_currency, as_of, rate_type, rate, source,
       created_at, created_by, updated_at, updated_by
  from fx_rates;
--> statement-breakpoint
delete from fx_rates;
--> statement-breakpoint
alter table fx_rates add column org_id uuid;
--> statement-breakpoint
insert into fx_rates
  (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source,
   created_at, created_by, updated_at, updated_by)
select uuid_generate_v7(), o.id, r.from_currency, r.to_currency, r.as_of,
       r.rate_type, r.rate, r.source, r.created_at, r.created_by, r.updated_at, r.updated_by
  from fx_rates_legacy r cross join orgs o;
--> statement-breakpoint
alter table fx_rates alter column org_id set not null;
--> statement-breakpoint
drop index if exists fx_rates_pair_date_type;
--> statement-breakpoint
create unique index fx_rates_org_pair_date_type
  on fx_rates (org_id, from_currency, to_currency, as_of, rate_type);
--> statement-breakpoint
alter table fx_rates add foreign key (org_id) references orgs(id) on delete cascade;
--> statement-breakpoint
alter table fx_rates enable row level security;
--> statement-breakpoint
alter table fx_rates force row level security;
--> statement-breakpoint
create policy org_isolation on fx_rates
  using (current_setting('app.bypass_rls', true) = 'on'
         or org_id::text = current_setting('app.current_org', true))
  with check (current_setting('app.bypass_rls', true) = 'on'
         or org_id::text = current_setting('app.current_org', true));
--> statement-breakpoint
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'openbooks_read') then
    grant select on fx_rates to openbooks_read;
  end if;
end $$;
--> statement-breakpoint
drop table fx_rates_legacy;
