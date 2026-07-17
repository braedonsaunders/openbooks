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
  if new.subsidiary_id is not null and not exists (
    select 1 from subsidiaries where id = new.subsidiary_id and org_id = new.org_id
  ) then
    raise exception 'segment value subsidiary belongs to another organization' using errcode = '23514';
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
--> statement-breakpoint

drop function if exists validate_extra_dims(uuid, jsonb);
--> statement-breakpoint
create or replace function validate_extra_dims(p_org_id uuid, p_dims jsonb, p_subsidiary_id uuid default null) returns void
language plpgsql stable as $$
declare d record;
begin
  if jsonb_typeof(coalesce(p_dims, '{}'::jsonb)) <> 'object' then
    raise exception 'custom segment assignments must be an object' using errcode = '23514';
  end if;
  for d in
    select pair.key, pair.value, sv.subsidiary_id, sv.subsidiary_include_children
      from jsonb_each_text(coalesce(p_dims, '{}'::jsonb)) pair
      left join segment_definitions sd on sd.org_id = p_org_id and sd.key = pair.key
       and sd.source_kind = 'custom' and sd.is_active
      left join segment_values sv on sv.segment_id = sd.id and sv.org_id = sd.org_id
       and sv.id::text = pair.value and sv.is_active
  loop
    if d.subsidiary_include_children is null then
      raise exception 'invalid custom segment assignment for %', d.key using errcode = '23514';
    end if;
    if d.subsidiary_id is not null and p_subsidiary_id is not null and not (
      p_subsidiary_id = d.subsidiary_id or (
        d.subsidiary_include_children and exists (
          with recursive descendants as (
            select id from subsidiaries where id = d.subsidiary_id and org_id = p_org_id
            union all
            select s.id from subsidiaries s join descendants x on s.parent_id = x.id
             where s.org_id = p_org_id
          ) select 1 from descendants where id = p_subsidiary_id
        )
      )
    ) then
      raise exception 'custom segment value % is restricted to another subsidiary', d.value using errcode = '23514';
    end if;
  end loop;
end $$;
--> statement-breakpoint

create or replace function row_extra_dims_guard() returns trigger
language plpgsql as $$
declare v_subsidiary uuid;
begin
  v_subsidiary := new.subsidiary_id;
  if tg_table_name = 'document_lines' and v_subsidiary is null then
    select subsidiary_id into v_subsidiary from documents where id = new.document_id;
  end if;
  if v_subsidiary is null then
    select id into v_subsidiary from subsidiaries where org_id = new.org_id and parent_id is null;
  end if;
  perform validate_extra_dims(new.org_id, new.extra_dims, v_subsidiary);
  return new;
end $$;
--> statement-breakpoint

create or replace function jl_check_required_dimensions() returns trigger
language plpgsql as $$
declare v_key text; v_required jsonb;
begin
  select required_dimensions into v_required from accounts
   where id = new.account_id and org_id = new.org_id;
  for v_key in select jsonb_array_elements_text(coalesce(v_required, '[]'::jsonb)) loop
    if (case v_key
      when 'subsidiary' then new.subsidiary_id is null
      when 'department' then new.department_id is null
      when 'project' then new.project_id is null
      when 'location' then new.location_id is null
      when 'class' then new.class_id is null
      when 'party' then new.party_id is null
      else not (coalesce(new.extra_dims, '{}'::jsonb) ? v_key)
    end) then
      raise exception 'account % requires segment %', new.account_id, v_key using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists jl_check_required_dimensions on journal_lines;
create trigger jl_check_required_dimensions before insert or update on journal_lines
  for each row execute function jl_check_required_dimensions();
