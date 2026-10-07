-- Optional custom dimension assignments preserve explicit blank overrides.
-- Required account dimensions still refuse blank values before posting.
SET statement_timeout = 0;
SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.validate_extra_dims(p_org_id uuid, p_dims jsonb, p_subsidiary_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
declare d record;
begin
  if jsonb_typeof(coalesce(p_dims, '{}'::jsonb)) <> 'object' then
    raise exception 'custom segment assignments must be an object' using errcode = '23514';
  end if;
  for d in
    select pair.key, pair.value, sd.id as segment_id, sv.id as value_id, sv.subsidiary_id, sv.subsidiary_include_children
      from jsonb_each(coalesce(p_dims, '{}'::jsonb)) pair
      left join segment_definitions sd on sd.org_id = p_org_id and sd.key = pair.key
       and sd.source_kind = 'custom' and sd.is_active
      left join segment_values sv on sv.segment_id = sd.id and sv.org_id = sd.org_id
       and sv.id::text = (pair.value #>> '{}') and sv.is_active
  loop
    if d.segment_id is null then
      raise exception 'unknown or inactive custom segment %', d.key using errcode = '23514';
    end if;
    -- A known optional segment may be explicitly blank. Keeping its key
    -- prevents a line from inheriting a header value the operator cleared.
    if d.value = 'null'::jsonb then continue; end if;
    if jsonb_typeof(d.value) <> 'string' or d.value_id is null then
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

CREATE OR REPLACE FUNCTION public.jl_check_required_dimensions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
      else nullif(coalesce(new.extra_dims, '{}'::jsonb)->>v_key, '') is null
    end) then
      raise exception 'account % requires segment %', new.account_id, v_key using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;
