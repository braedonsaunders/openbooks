set local app.bypass_rls = 'on';
--> statement-breakpoint
alter table fixed_assets add column subsidiary_id uuid;
--> statement-breakpoint
update fixed_assets a set subsidiary_id = s.id
  from subsidiaries s
 where s.org_id = a.org_id and s.parent_id is null;
--> statement-breakpoint
alter table fixed_assets alter column subsidiary_id set not null;
alter table fixed_assets add foreign key (subsidiary_id) references subsidiaries(id);
create index fixed_assets_org_subsidiary on fixed_assets (org_id, subsidiary_id);
--> statement-breakpoint
create trigger subsidiary_ref_guard
  before insert or update of subsidiary_id, org_id on fixed_assets
  for each row execute function subsidiary_ref_guard();
