-- Forward-converge trigger guards that had diverged between historical live
-- installs and clean bootstraps. The canonical definitions intentionally remove
-- blanket openbooks.migration bypasses: trusted copy/import paths must satisfy
-- tenant and lifecycle invariants. Sandbox deletion remains allowed only through
-- the explicit sandbox_wipe guard on a sandbox tenant.
--
-- Also fixes clean-install sandbox creation: a sandbox org must not pre-seed
-- built-in segments before the production segment graph is cloned.
BEGIN;

CREATE OR REPLACE FUNCTION public.change_order_target_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.target_sov_line_id is not null and not exists (
    select 1
      from sov_lines sl
     where sl.id = new.target_sov_line_id
       and sl.org_id = new.org_id
       and sl.project_id = new.project_id
  ) then
    raise exception 'change-order target must belong to the same organization and project';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.dunning_log_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if current_setting('app.bypass_rls', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'dunning_log is append-only';
end;
$function$;

CREATE OR REPLACE FUNCTION public.intercompany_pair_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.inv_move_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' and not openbooks_sandbox_wipe_allowed(old.org_id) then
      raise exception 'inventory movement % is posted and cannot be deleted', old.id;
    end if;
    return old;
  end if;
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'inventory movement % is posted and immutable', old.id;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.inventory_provisional_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if current_setting('openbooks.sandbox_wipe',true)='on' then return old; end if;
  raise exception 'inventory provisional evidence is immutable';
end $function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_ap_capture_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'AP capture evidence is append-only';
END;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_ap_capture_source_blob()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM file_versions fv
    JOIN ap_capture_items ci ON ci.file_id = fv.file_id
    WHERE fv.id = OLD.version_id
  ) THEN
    RAISE EXCEPTION 'AP capture source blobs are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_ap_capture_source_file()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = OLD.id) THEN
    RAISE EXCEPTION 'AP capture source files are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_ap_capture_source_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE target_file_id uuid;
BEGIN
  target_file_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.file_id ELSE OLD.file_id END;
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = target_file_id) THEN
    RAISE EXCEPTION 'AP capture source versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_budget_line()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  row_data budget_lines%rowtype;
  scenario_org uuid;
  scenario_year integer;
  scenario_status text;
begin
  row_data := case when tg_op = 'DELETE' then old else new end;
  select org_id, fiscal_year, status
    into scenario_org, scenario_year, scenario_status
    from budget_scenarios where id = row_data.scenario_id;
  -- During an ON DELETE CASCADE, PostgreSQL removes the parent scenario before
  -- firing the child row's delete trigger. The line was already protected by
  -- the scenario's draft-only delete guard, so allow that cascade to finish.
  if tg_op = 'DELETE' and scenario_org is null then return old; end if;
  if scenario_org is null or scenario_org <> row_data.org_id then
    raise exception 'budget line scenario must belong to the tenant';
  end if;
  if scenario_status <> 'draft' then
    raise exception 'budget lines are immutable outside draft status';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  if not exists (
    select 1 from accounts a
     where a.id = new.account_id and a.org_id = new.org_id and a.is_active and not a.is_summary
  ) then
    raise exception 'budget account must be an active posting account in the tenant';
  end if;
  if not exists (
    select 1 from accounting_periods p
     where p.id = new.period_id and p.org_id = new.org_id
       and p.fiscal_year = scenario_year and not p.is_adjustment
  ) then
    raise exception 'budget period must belong to the scenario fiscal year and tenant';
  end if;
  if new.department_id is not null and not exists (
    select 1 from departments d where d.id = new.department_id and d.org_id = new.org_id
  ) then raise exception 'budget department must belong to the tenant'; end if;
  if new.project_id is not null and not exists (
    select 1 from projects p where p.id = new.project_id and p.org_id = new.org_id
  ) then raise exception 'budget project must belong to the tenant'; end if;
  if new.location_id is not null and not exists (
    select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id
  ) then raise exception 'budget location must belong to the tenant'; end if;
  if new.class_id is not null and not exists (
    select 1 from classes c where c.id = new.class_id and c.org_id = new.org_id
  ) then raise exception 'budget class must belong to the tenant'; end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_budget_scenario()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'only draft budget scenarios may be deleted';
    end if;
    return old;
  end if;

  if not exists (
    select 1 from accounting_books b
     where b.id = new.book_id and b.org_id = new.org_id and b.is_active
  ) then
    raise exception 'budget scenario book must be active and belong to the tenant';
  end if;

  if tg_op = 'UPDATE' then
    if new.revision <> old.revision + 1 then
      raise exception 'budget scenario revision must increment by exactly one';
    end if;
    if old.status <> 'draft' and (
      new.name is distinct from old.name or
      new.description is distinct from old.description or
      new.book_id is distinct from old.book_id or
      new.fiscal_year is distinct from old.fiscal_year or
      new.kind is distinct from old.kind
    ) then
      raise exception 'only draft budget metadata may be edited';
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'draft' and new.status in ('pending_approval', 'archived')) or
      (old.status = 'pending_approval' and new.status in ('draft', 'approved', 'archived')) or
      (old.status = 'approved' and new.status = 'archived')
    ) then
      raise exception 'invalid budget status transition: % -> %', old.status, new.status;
    end if;
  end if;

  if new.status in ('pending_approval', 'approved') and not exists (
    select 1 from budget_lines bl
     where bl.scenario_id = new.id and bl.org_id = new.org_id and bl.amount <> 0
  ) then
    raise exception 'a submitted or approved budget must contain at least one non-zero line';
  end if;
  if new.submitted_by is not null and not exists (
    select 1 from users u where u.id = new.submitted_by and u.org_id = new.org_id
  ) then raise exception 'budget submitter must belong to the tenant'; end if;
  if new.approved_by is not null and not exists (
    select 1 from users u where u.id = new.approved_by and u.org_id = new.org_id
  ) then raise exception 'budget approver must belong to the tenant'; end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_finished_ap_capture_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' THEN
    RAISE EXCEPTION 'Finished AP capture runs are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.party_subsidiary_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.seed_builtin_segments_on_org_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Sandbox tenants clone the production segment graph with deterministically
  -- rebased identities; pre-seeding would create duplicate logical keys.
  if new.env_kind = 'sandbox' then return new; end if;
  perform seed_builtin_segments(new.id);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.segment_definition_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' and old.source_kind = 'builtin'
     and not openbooks_sandbox_wipe_allowed(old.org_id) then
    raise exception 'built-in segment definitions cannot be deleted' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.source_kind = 'builtin' and
     (new.key <> old.key or new.source_kind <> old.source_kind or new.storage_column is distinct from old.storage_column) then
    raise exception 'built-in segment identity cannot be changed' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $function$;

CREATE OR REPLACE FUNCTION public.segment_value_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.subsidiary_ref_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if new.subsidiary_id is not null and not exists (
    select 1 from subsidiaries s where s.id = new.subsidiary_id and s.org_id = new.org_id
  ) then
    raise exception 'subsidiary belongs to another organization' using errcode = '23514';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.subsidiary_tree_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.tax_group_member_validate()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare group_org uuid; code_org uuid;
begin
  if new.sequence <= 0 then raise exception 'tax group member sequence must be positive'; end if;
  select org_id into group_org from tax_groups where id = new.tax_group_id;
  select org_id into code_org from tax_codes where id = new.tax_code_id;
  if group_org is null or code_org is null or group_org <> code_org then
    raise exception 'tax group and tax code must belong to the same organization';
  end if;
  return new;
end $function$;

COMMIT;
