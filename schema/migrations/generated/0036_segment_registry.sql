create table "segment_definitions" (
  "id" uuid primary key default uuid_generate_v7() not null,
  "org_id" uuid not null,
  "key" text not null,
  "name" text not null,
  "plural_name" text not null,
  "source_kind" text default 'custom' not null,
  "storage_column" text,
  "is_hierarchical" boolean default false not null,
  "show_on_header" boolean default true not null,
  "show_on_lines" boolean default true not null,
  "show_in_reports" boolean default true not null,
  "allow_account_requirement" boolean default true not null,
  "sort_order" integer default 100 not null,
  "is_active" boolean default true not null,
  "custom" jsonb default '{}'::jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "created_by" uuid,
  "updated_at" timestamp with time zone default now() not null,
  "updated_by" uuid,
  constraint "segment_definition_key_format" check ("key" ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint "segment_definition_source" check (
    ("source_kind" = 'custom' and "storage_column" is null)
    or ("source_kind" = 'builtin' and "storage_column" in
      ('subsidiary_id','department_id','project_id','location_id','class_id'))
  )
);
--> statement-breakpoint
create unique index "segment_definitions_org_key" on "segment_definitions" ("org_id", "key");
create index "segment_definitions_org_order" on "segment_definitions" ("org_id", "sort_order", "name");
--> statement-breakpoint
create table "segment_values" (
  "id" uuid primary key default uuid_generate_v7() not null,
  "org_id" uuid not null,
  "segment_id" uuid not null,
  "parent_id" uuid,
  "code" text,
  "name" text not null,
  "description" text,
  "subsidiary_id" uuid,
  "subsidiary_include_children" boolean default true not null,
  "is_active" boolean default true not null,
  "custom" jsonb default '{}'::jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "created_by" uuid,
  "updated_at" timestamp with time zone default now() not null,
  "updated_by" uuid
);
--> statement-breakpoint
create index "segment_values_org_segment" on "segment_values" ("org_id", "segment_id", "name");
create index "segment_values_parent" on "segment_values" ("parent_id");
create unique index "segment_values_org_segment_code" on "segment_values" ("org_id", "segment_id", lower("code")) where "code" is not null;
--> statement-breakpoint
alter table "documents" add column "extra_dims" jsonb default '{}'::jsonb not null;
alter table "document_lines" add column "extra_dims" jsonb default '{}'::jsonb not null;
create index "documents_extra_dims_gin" on "documents" using gin ("extra_dims");
create index "document_lines_extra_dims_gin" on "document_lines" using gin ("extra_dims");
create index "journal_lines_extra_dims_gin" on "journal_lines" using gin ("extra_dims");
--> statement-breakpoint

create or replace function seed_builtin_segments(p_org_id uuid) returns void
language sql as $$
  insert into segment_definitions
    (org_id, key, name, plural_name, source_kind, storage_column,
     is_hierarchical, show_on_header, show_on_lines, show_in_reports,
     allow_account_requirement, sort_order)
  values
    (p_org_id, 'subsidiary', 'Subsidiary', 'Subsidiaries', 'builtin', 'subsidiary_id', true, true, true, true, false, 10),
    (p_org_id, 'department', 'Department', 'Departments', 'builtin', 'department_id', true, true, true, true, true, 20),
    (p_org_id, 'project', 'Project', 'Projects', 'builtin', 'project_id', true, true, true, true, true, 30),
    (p_org_id, 'location', 'Location', 'Locations', 'builtin', 'location_id', true, true, true, true, true, 40),
    (p_org_id, 'class', 'Class', 'Classes', 'builtin', 'class_id', true, true, true, true, true, 50)
  on conflict (org_id, key) do nothing
$$;
--> statement-breakpoint
select seed_builtin_segments(id) from orgs;
--> statement-breakpoint
create or replace function seed_builtin_segments_on_org_insert() returns trigger
language plpgsql as $$ begin perform seed_builtin_segments(new.id); return new; end $$;
create trigger seed_builtin_segments_on_org_insert
  after insert on orgs for each row execute function seed_builtin_segments_on_org_insert();
--> statement-breakpoint

create or replace function segment_definition_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.source_kind = 'builtin' then
    raise exception 'built-in segment definitions cannot be deleted' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.source_kind = 'builtin' and
     (new.key <> old.key or new.source_kind <> old.source_kind or new.storage_column is distinct from old.storage_column) then
    raise exception 'built-in segment identity cannot be changed' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger segment_definition_guard
  before update or delete on segment_definitions for each row execute function segment_definition_guard();
--> statement-breakpoint

create or replace function segment_value_guard() returns trigger
language plpgsql as $$
declare v_hierarchical boolean;
begin
  select is_hierarchical into v_hierarchical
    from segment_definitions
   where id = new.segment_id and org_id = new.org_id and source_kind = 'custom';
  if v_hierarchical is null then
    raise exception 'segment value must belong to a custom segment in this organization' using errcode = '23514';
  end if;
  if new.parent_id is not null then
    if not v_hierarchical then
      raise exception 'this segment is not hierarchical' using errcode = '23514';
    end if;
    if not exists (select 1 from segment_values p where p.id = new.parent_id
      and p.org_id = new.org_id and p.segment_id = new.segment_id) then
      raise exception 'segment value parent is invalid' using errcode = '23514';
    end if;
    if new.parent_id = new.id or exists (
      with recursive descendants as (
        select id from segment_values where parent_id = new.id
        union all
        select v.id from segment_values v join descendants d on v.parent_id = d.id
      ) select 1 from descendants where id = new.parent_id
    ) then
      raise exception 'segment value hierarchy contains a cycle' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger segment_value_guard before insert or update on segment_values
  for each row execute function segment_value_guard();
--> statement-breakpoint

create or replace function validate_extra_dims(p_org_id uuid, p_dims jsonb) returns void
language plpgsql stable as $$
declare d record;
begin
  if jsonb_typeof(coalesce(p_dims, '{}'::jsonb)) <> 'object' then
    raise exception 'custom segment assignments must be an object' using errcode = '23514';
  end if;
  for d in select key, value from jsonb_each_text(coalesce(p_dims, '{}'::jsonb)) loop
    if not exists (
      select 1 from segment_definitions sd
      join segment_values sv on sv.segment_id = sd.id and sv.org_id = sd.org_id
      where sd.org_id = p_org_id and sd.key = d.key and sd.source_kind = 'custom'
        and sd.is_active and sv.id::text = d.value and sv.is_active
    ) then
      raise exception 'invalid custom segment assignment for %', d.key using errcode = '23514';
    end if;
  end loop;
end $$;
--> statement-breakpoint
create or replace function row_extra_dims_guard() returns trigger
language plpgsql as $$ begin perform validate_extra_dims(new.org_id, new.extra_dims); return new; end $$;
create trigger documents_extra_dims_guard before insert or update of org_id, extra_dims on documents
  for each row execute function row_extra_dims_guard();
create trigger document_lines_extra_dims_guard before insert or update of org_id, extra_dims on document_lines
  for each row execute function row_extra_dims_guard();
create trigger journal_lines_extra_dims_guard before insert or update of org_id, extra_dims on journal_lines
  for each row execute function row_extra_dims_guard();
--> statement-breakpoint

grant select on segment_definitions, segment_values to openbooks_read;
