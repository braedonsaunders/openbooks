-- Database authority for subsidiary ownership and hierarchy. Application
-- validation provides friendly errors; these triggers prevent guessed UUIDs,
-- background jobs, imports, or future code from crossing tenant/entity scope.
set local app.bypass_rls = 'on';
--> statement-breakpoint
create or replace function openbooks_sandbox_wipe_allowed(p_org_id uuid) returns boolean
language sql stable as $$
  select coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on'
     and exists (
       select 1 from orgs where id = p_org_id and env_kind = 'sandbox'
     )
$$;
--> statement-breakpoint
create or replace function subsidiary_tree_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.parent_id is null
       and exists (select 1 from orgs where id = old.org_id)
       and not openbooks_sandbox_wipe_allowed(old.org_id) then
      raise exception 'the root subsidiary cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.parent_id is null and new.parent_id is not null then
    raise exception 'the root subsidiary cannot be moved' using errcode = '23514';
  end if;
  if new.parent_id is null and not new.is_active then
    raise exception 'the root subsidiary cannot be inactive' using errcode = '23514';
  end if;
  if new.parent_id is not null then
    if not exists (select 1 from subsidiaries p where p.id = new.parent_id and p.org_id = new.org_id) then
      raise exception 'subsidiary parent belongs to another organization' using errcode = '23514';
    end if;
    if new.parent_id = new.id or exists (
      with recursive descendants as (
        select id from subsidiaries where parent_id = new.id
        union all
        select s.id from subsidiaries s join descendants d on s.parent_id = d.id
      ) select 1 from descendants where id = new.parent_id
    ) then
      raise exception 'subsidiary hierarchy contains a cycle' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger subsidiary_tree_guard
  before insert or update or delete on subsidiaries
  for each row execute function subsidiary_tree_guard();
--> statement-breakpoint

create or replace function subsidiary_ref_guard() returns trigger
language plpgsql as $$
begin
  if new.subsidiary_id is not null and not exists (
    select 1 from subsidiaries s where s.id = new.subsidiary_id and s.org_id = new.org_id
  ) then
    raise exception 'subsidiary belongs to another organization' using errcode = '23514';
  end if;
  return new;
end $$;
--> statement-breakpoint
do $$
declare t text;
begin
  foreach t in array array[
    'accounts','departments','locations','classes','projects','parties',
    'number_sequences','documents','document_lines','journal_entries','journal_lines'
  ] loop
    execute format('create trigger subsidiary_ref_guard before insert or update of subsidiary_id, org_id on %I for each row execute function subsidiary_ref_guard()', t);
  end loop;
end $$;
--> statement-breakpoint

create or replace function party_subsidiary_guard() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from parties p where p.id = new.party_id and p.org_id = new.org_id) then
    raise exception 'party belongs to another organization' using errcode = '23514';
  end if;
  if not exists (
    select 1 from subsidiaries s
     where s.id = new.subsidiary_id and s.org_id = new.org_id and not s.is_elimination
  ) then
    raise exception 'party subsidiary is invalid' using errcode = '23514';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger party_subsidiary_guard
  before insert or update on party_subsidiaries
  for each row execute function party_subsidiary_guard();
--> statement-breakpoint

drop index if exists intercompany_subsidiary_pair;
--> statement-breakpoint
create unique index intercompany_subsidiary_pair
  on intercompany_pairs (least(from_subsidiary_id, to_subsidiary_id), greatest(from_subsidiary_id, to_subsidiary_id));
--> statement-breakpoint
create or replace function intercompany_pair_guard() returns trigger
language plpgsql as $$
declare
  v_from_type text;
  v_to_type text;
begin
  if new.from_subsidiary_id = new.to_subsidiary_id then
    raise exception 'intercompany subsidiaries must be different' using errcode = '23514';
  end if;
  if (select count(*) from subsidiaries s
       where s.org_id = new.org_id and s.id in (new.from_subsidiary_id, new.to_subsidiary_id)
         and s.is_active and not s.is_elimination) <> 2 then
    raise exception 'intercompany subsidiaries are invalid' using errcode = '23514';
  end if;
  select type into v_from_type from accounts
   where id = new.due_from_account_id and org_id = new.org_id
     and is_active and not is_summary and eliminate;
  select type into v_to_type from accounts
   where id = new.due_to_account_id and org_id = new.org_id
     and is_active and not is_summary and eliminate;
  if v_from_type is null or v_from_type not like 'asset\_%' escape '\' then
    raise exception 'due-from account must be an eliminable asset' using errcode = '23514';
  end if;
  if v_to_type is null or v_to_type not like 'liability\_%' escape '\' then
    raise exception 'due-to account must be an eliminable liability' using errcode = '23514';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger intercompany_pair_guard
  before insert or update on intercompany_pairs
  for each row execute function intercompany_pair_guard();
