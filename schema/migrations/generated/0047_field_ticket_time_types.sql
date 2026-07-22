-- Field tickets deliberately expose only the tenant's selected time types.
-- Keep existing tenants unchanged on rollout; newly-created/imported types are
-- opt-in so an integration cannot silently make the crew grid enormous again.

alter table time_types
  add column if not exists show_on_field_ticket boolean not null default false;

alter table time_types
  alter column show_on_field_ticket set default false;

update time_types
   set show_on_field_ticket = true
 where is_active;
