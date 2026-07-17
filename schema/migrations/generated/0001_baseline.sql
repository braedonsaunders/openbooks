-- Flattened schema baseline (generated from the cluster schema).
-- Tables, indexes, sequences, RLS policies, and non-kernel functions/triggers.
-- Foreign keys live in referential-integrity.sql; posting-kernel invariants in
-- kernel-constraints.sql; uuid_generate_v7() + _applied_migrations are created
-- by bootstrap. Applied once, tracked in _applied_migrations.

set check_function_bodies = false;
--
-- Extension: pg_trgm (best-effort — global search falls back to substring if absent)
--
do $$ begin create extension if not exists pg_trgm; exception when insufficient_privilege then raise notice 'pg_trgm unavailable to this role'; end $$;
--
-- Name: app_check_open(); Type: FUNCTION; Schema: public
--
--
-- Name: app_check_open(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_check_open() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_line numeric(19,4);
  v_applied numeric(19,4);
begin
  -- target side: total applied to the open item <= |line amount|
  select abs(amount) into v_line from journal_lines where id = new.to_line_id;
  select coalesce(sum(amount), 0) into v_applied
    from applications
   where to_line_id = new.to_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line + 0.005 then
    raise exception 'application exceeds open amount on target line % (% applied of %)',
      new.to_line_id, v_applied + new.amount, v_line;
  end if;

  -- source side: a credit can't be applied beyond its own magnitude
  select abs(amount) into v_line from journal_lines where id = new.from_line_id;
  select coalesce(sum(amount), 0) into v_applied
    from applications
   where from_line_id = new.from_line_id and unapplied_at is null and id <> new.id;
  if v_applied + new.amount > v_line + 0.005 then
    raise exception 'application exceeds available amount on source line %', new.from_line_id;
  end if;
  return new;
end $$;


--
-- Name: audit_log_append_only_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: audit_log_append_only_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_log_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin raise exception 'audit_log is append-only'; end $$;


--
-- Name: close_append_only_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: close_append_only_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin raise exception '% is append-only', tg_table_name; end $$;


--
-- Name: intercompany_pair_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: intercompany_pair_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.intercompany_pair_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: inv_move_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: inv_move_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inv_move_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'posted' then
      raise exception 'inventory movement % is posted and cannot be deleted', old.id;
    end if;
    return old;
  end if;
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'inventory movement % is posted and immutable', old.id;
  end if;
  return new;
end $$;


--
-- Name: je_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: je_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    -- Deleting a transaction removes its journal entry too. That is the one
    -- legitimate removal of a posted entry, done by the engine's guarded
    -- delete under the 'openbooks.amend' flag (after it has proven the delete
    -- is safe: open period, no applied payments, no downstream conversion).
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    return old;
  end if;

  -- A document-sourced entry is a DERIVED projection of its source document:
  -- entry = postingRules(document), re-materialized on every save. When
  -- 'openbooks.amend' is on (set only by the engine's materialize path), a
  -- posted entry's header may be regenerated in place — but only into an OPEN
  -- period (a GL change can't land in a closed period). Balance + summary-
  -- account rules still apply to the regenerated lines.
  if old.status = 'posted' and new.status = 'posted'
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    if period_module_is_closed(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl')
       or period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl') then
      raise exception 'period is closed for GL posting';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  -- draft -> posted: period must be open for GL
  if old.status = 'draft' and new.status = 'posted' then
    if period_module_is_closed(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and period_module_is_closed(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;


--
-- Name: jl_check_account(); Type: FUNCTION; Schema: public
--
--
-- Name: jl_check_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
begin
  select is_summary, is_active, currency_restriction
    into v_summary, v_active, v_ccy
    from accounts where id = new.account_id;
  if not found then
    raise exception 'account % does not exist', new.account_id;
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;


--
-- Name: jl_check_balanced(); Type: FUNCTION; Schema: public
--
--
-- Name: jl_check_balanced(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jl_check_balanced() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entry uuid;
  v_sum numeric(19,4);
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select coalesce(sum(amount), 0) into v_sum
    from journal_lines where entry_id = v_entry;
  if v_sum <> 0 then
    raise exception 'journal entry % does not balance (sum = %)', v_entry, v_sum
      using errcode = '23514';
  end if;
  return null;
end $$;


--
-- Name: jl_check_balanced_by_subsidiary(); Type: FUNCTION; Schema: public
--
--
-- Name: jl_check_balanced_by_subsidiary(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jl_check_balanced_by_subsidiary() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_entry uuid;
  v_bad record;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines where entry_id = v_entry
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
      v_entry, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  return null;
end $$;


--
-- Name: jl_check_required_dimensions(); Type: FUNCTION; Schema: public
--
--
-- Name: jl_check_required_dimensions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jl_check_required_dimensions() RETURNS trigger
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
      else not (coalesce(new.extra_dims, '{}'::jsonb) ? v_key)
    end) then
      raise exception 'account % requires segment %', new.account_id, v_key using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;


--
-- Name: jl_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: jl_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jl_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
begin
  select status into v_status from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if v_status is distinct from 'draft' then
    -- Bank-reconciliation sign-off stamps reconciled_at / reconciliation_id
    -- on posted lines. That is bookkeeping METADATA, not accounting content:
    -- allow an UPDATE that changes nothing else. Every other write to a
    -- non-draft entry's lines stays blocked.
    if tg_op = 'UPDATE'
       and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id'
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id'
    then
      return new;
    end if;
    -- Re-materializing a posted entry's GL-Impact projection from its edited
    -- source document (engine-only 'openbooks.amend' flag). The entry stays
    -- posted; its lines are regenerated to match the transaction. Balance and
    -- account guards still fire on the new lines.
    if v_status = 'posted'
       and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
      return coalesce(new, old);
    end if;
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;


--
-- Name: ob_rebase(uuid, uuid); Type: FUNCTION; Schema: public
--
--
-- Name: ob_rebase(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ob_rebase(old uuid, seed uuid) RETURNS uuid
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    select md5(seed::text || ':' || old::text)::uuid
$$;


--
-- Name: openbooks_guard_ap_capture_evidence(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_ap_capture_evidence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_ap_capture_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'AP capture evidence is append-only';
END;
$$;


--
-- Name: openbooks_guard_ap_capture_source_blob(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_ap_capture_source_blob(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_ap_capture_source_blob() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: openbooks_guard_ap_capture_source_file(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_ap_capture_source_file(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_ap_capture_source_file() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = OLD.id) THEN
    RAISE EXCEPTION 'AP capture source files are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: openbooks_guard_ap_capture_source_version(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_ap_capture_source_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_ap_capture_source_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target_file_id uuid;
BEGIN
  target_file_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.file_id ELSE OLD.file_id END;
  IF EXISTS (SELECT 1 FROM ap_capture_items WHERE file_id = target_file_id) THEN
    RAISE EXCEPTION 'AP capture source versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: openbooks_guard_budget_line(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_budget_line(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_budget_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: openbooks_guard_budget_scenario(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_budget_scenario(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_budget_scenario() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: openbooks_guard_finished_ap_capture_run(); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_guard_finished_ap_capture_run(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_guard_finished_ap_capture_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'running' THEN
    RAISE EXCEPTION 'Finished AP capture runs are immutable';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: openbooks_sandbox_wipe_allowed(uuid); Type: FUNCTION; Schema: public
--
--
-- Name: openbooks_sandbox_wipe_allowed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.openbooks_sandbox_wipe_allowed(p_org_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on'
     and exists (
       select 1 from orgs where id = p_org_id and env_kind = 'sandbox'
     )
$$;


--
-- Name: party_subsidiary_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: party_subsidiary_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.party_subsidiary_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: payment_event_immutable(); Type: FUNCTION; Schema: public
--
--
-- Name: payment_event_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_event_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'payment events are append-only';
end $$;


--
-- Name: payment_file_artifact_immutable(); Type: FUNCTION; Schema: public
--
--
-- Name: payment_file_artifact_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_file_artifact_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.payment_run_id is distinct from old.payment_run_id
     or new.payment_bank_profile_id is distinct from old.payment_bank_profile_id
     or new.payment_format_id is distinct from old.payment_format_id
     or new.parent_payment_file_id is distinct from old.parent_payment_file_id
     or new.sequence_number is distinct from old.sequence_number
     or new.filename is distinct from old.filename
     or new.content_type is distinct from old.content_type
     or new.content_hash is distinct from old.content_hash
     or new.file_id is distinct from old.file_id
     or new.file_version_id is distinct from old.file_version_id
     or new.payment_count is distinct from old.payment_count
     or new.total_amount is distinct from old.total_amount
     or new.currency is distinct from old.currency
     or new.generated_at is distinct from old.generated_at
     or new.generated_by is distinct from old.generated_by then
    raise exception 'generated payment file artifacts are immutable; reprocess into a new file';
  end if;
  return new;
end $$;


--
-- Name: payment_run_item_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: payment_run_item_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payment_run_item_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare v_status text;
begin
  select status into v_status from payment_runs where id = coalesce(new.payment_run_id, old.payment_run_id);
  if tg_op = 'DELETE' and v_status not in ('draft', 'pending_approval') then
    raise exception 'payment run items are immutable once the run is approved';
  end if;
  if tg_op = 'UPDATE' and v_status not in ('draft', 'pending_approval') and (
     new.payment_run_id is distinct from old.payment_run_id
     or new.payment_instruction_id is distinct from old.payment_instruction_id
     or new.source_document_id is distinct from old.source_document_id
     or new.source_open_line_id is distinct from old.source_open_line_id
     or new.kind is distinct from old.kind
     or new.gross_amount is distinct from old.gross_amount
     or new.discount_amount is distinct from old.discount_amount
     or new.credit_amount is distinct from old.credit_amount
     or new.payment_amount is distinct from old.payment_amount
     or new.currency is distinct from old.currency
     or new.fx_rate is distinct from old.fx_rate) then
    raise exception 'payment run item composition is immutable once the run is approved';
  end if;
  return coalesce(new, old);
end $$;


--
-- Name: period_module_is_closed(uuid, uuid, uuid, uuid, text); Type: FUNCTION; Schema: public
--
--
-- Name: period_module_is_closed(uuid, uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.period_module_is_closed(p_org uuid, p_period uuid, p_book uuid, p_subsidiary uuid, p_module text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select coalesce(
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id = p_subsidiary and module = p_module),
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id is null and module = p_module),
    false
  )
$$;


--
-- Name: recompute_document_open_balance(uuid); Type: FUNCTION; Schema: public
--
--
-- Name: recompute_document_open_balance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_document_open_balance(p_doc uuid) RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE documents d SET open_balance = CASE
    WHEN d.status = 'voided' THEN NULL
    ELSE (
      SELECT CASE WHEN count(jl.id) = 0 THEN NULL
             ELSE sum(abs(jl.amount)) - coalesce(sum(ap.applied), 0) END
        FROM journal_lines jl
        LEFT JOIN LATERAL (
          SELECT sum(a.amount) AS applied
            FROM applications a
           WHERE (a.to_line_id = jl.id OR a.from_line_id = jl.id)
             AND a.unapplied_at IS NULL
        ) ap ON true
       WHERE jl.entry_id = d.posted_entry_id AND jl.is_open_item
    )
    END
  WHERE d.id = p_doc;
$$;


--
-- Name: row_extra_dims_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: row_extra_dims_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.row_extra_dims_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: seed_builtin_segments(uuid); Type: FUNCTION; Schema: public
--
--
-- Name: seed_builtin_segments(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_builtin_segments(p_org_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
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


--
-- Name: seed_builtin_segments_on_org_insert(); Type: FUNCTION; Schema: public
--
--
-- Name: seed_builtin_segments_on_org_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_builtin_segments_on_org_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin perform seed_builtin_segments(new.id); return new; end $$;


--
-- Name: segment_definition_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: segment_definition_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.segment_definition_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
end $$;


--
-- Name: segment_value_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: segment_value_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.segment_value_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: subsidiary_ref_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: subsidiary_ref_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subsidiary_ref_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.subsidiary_id is not null and not exists (
    select 1 from subsidiaries s where s.id = new.subsidiary_id and s.org_id = new.org_id
  ) then
    raise exception 'subsidiary belongs to another organization' using errcode = '23514';
  end if;
  return new;
end $$;


--
-- Name: subsidiary_tree_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: subsidiary_tree_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subsidiary_tree_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: tax_filing_immutable_guard(); Type: FUNCTION; Schema: public
--
--
-- Name: tax_filing_immutable_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tax_filing_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' then
    if openbooks_sandbox_wipe_allowed(old.org_id) then return old; end if;
    raise exception 'tax filing snapshots cannot be deleted';
  end if;
  if old.status = 'prepared' and new.status = 'filed'
     and (to_jsonb(new) - 'status' - 'filing_reference' - 'filed_at' - 'updated_at' - 'updated_by')
       = (to_jsonb(old) - 'status' - 'filing_reference' - 'filed_at' - 'updated_at' - 'updated_by')
  then
    return new;
  end if;
  raise exception 'tax filing snapshots are immutable';
end $$;


--
-- Name: trg_application_open_balance(); Type: FUNCTION; Schema: public
--
--
-- Name: trg_application_open_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_application_open_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare v_doc uuid;
begin
  if openbooks_sandbox_wipe_allowed(
       case when tg_op = 'DELETE' then old.org_id else new.org_id end
     ) then
    return null;
  end if;
  for v_doc in
    select distinct d.id
      from documents d
      join journal_lines jl on jl.entry_id = d.posted_entry_id
     where jl.is_open_item
       and jl.id in (coalesce(new.to_line_id, old.to_line_id),
                     coalesce(new.from_line_id, old.from_line_id))
  loop
    perform recompute_document_open_balance(v_doc);
  end loop;
  return null;
end $$;


--
-- Name: trg_document_open_balance(); Type: FUNCTION; Schema: public
--
--
-- Name: trg_document_open_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_document_open_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM recompute_document_open_balance(NEW.id);
  RETURN NULL;
END $$;


--
-- Name: validate_extra_dims(uuid, jsonb, uuid); Type: FUNCTION; Schema: public
--
--
-- Name: validate_extra_dims(uuid, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_extra_dims(p_org_id uuid, p_dims jsonb, p_subsidiary_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_group_members; Type: TABLE; Schema: public
--
--
-- Name: account_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_group_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    group_id uuid NOT NULL,
    account_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.account_group_members FORCE ROW LEVEL SECURITY;


--
-- Name: account_groups; Type: TABLE; Schema: public
--
--
-- Name: account_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_groups (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    dimension text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    color text,
    sort_order integer DEFAULT 0 NOT NULL,
    match jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_catch_all boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.account_groups FORCE ROW LEVEL SECURITY;


--
-- Name: accounting_books; Type: TABLE; Schema: public
--
--
-- Name: accounting_books; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounting_books (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    posts_gl boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.accounting_books FORCE ROW LEVEL SECURITY;


--
-- Name: accounting_periods; Type: TABLE; Schema: public
--
--
-- Name: accounting_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounting_periods (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    fiscal_year integer NOT NULL,
    period_number integer NOT NULL,
    name text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    is_adjustment boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    fiscal_calendar_id uuid NOT NULL,
    CONSTRAINT accounting_periods_date_check CHECK ((starts_on <= ends_on))
);

ALTER TABLE ONLY public.accounting_periods FORCE ROW LEVEL SECURITY;


--
-- Name: accounts; Type: TABLE; Schema: public
--
--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    number text,
    name text NOT NULL,
    type text NOT NULL,
    description text,
    is_summary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    currency_restriction text,
    eliminate boolean DEFAULT false NOT NULL,
    reconcilable boolean DEFAULT false NOT NULL,
    required_dimensions jsonb DEFAULT '[]'::jsonb NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;


--
-- Name: addresses; Type: TABLE; Schema: public
--
--
-- Name: addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.addresses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    label text,
    line1 text,
    line2 text,
    city text,
    region text,
    postal_code text,
    country text,
    is_default_billing boolean DEFAULT false NOT NULL,
    is_default_shipping boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.addresses FORCE ROW LEVEL SECURITY;


--
-- Name: ai_agent_policies; Type: TABLE; Schema: public
--
--
-- Name: ai_agent_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    agent_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    automatic_runs boolean DEFAULT false NOT NULL,
    cadence text DEFAULT 'daily'::text NOT NULL,
    materiality_threshold numeric(19,4) DEFAULT '1000'::numeric NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    detector_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    analysis_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT ai_agent_policies_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text]))),
    CONSTRAINT ai_agent_policies_analysis_settings_object_check CHECK ((jsonb_typeof(analysis_settings) = 'object'::text)),
    CONSTRAINT ai_agent_policies_cadence_check CHECK ((cadence = ANY (ARRAY['daily'::text, 'weekly'::text]))),
    CONSTRAINT ai_agent_policies_detector_settings_object_check CHECK ((jsonb_typeof(detector_settings) = 'object'::text)),
    CONSTRAINT ai_agent_policies_materiality_check CHECK ((materiality_threshold >= (0)::numeric))
);

ALTER TABLE ONLY public.ai_agent_policies FORCE ROW LEVEL SECURITY;


--
-- Name: ai_agent_runs; Type: TABLE; Schema: public
--
--
-- Name: ai_agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    agent_key text NOT NULL,
    trigger text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    detector_version text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    initiated_by uuid,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    CONSTRAINT ai_agent_runs_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text]))),
    CONSTRAINT ai_agent_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT ai_agent_runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'scheduler'::text])))
);

ALTER TABLE ONLY public.ai_agent_runs FORCE ROW LEVEL SECURITY;


--
-- Name: ai_conversations; Type: TABLE; Schema: public
--
--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    scope text DEFAULT 'assistant'::text NOT NULL,
    title text DEFAULT 'New chat'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.ai_conversations FORCE ROW LEVEL SECURITY;


--
-- Name: ai_messages; Type: TABLE; Schema: public
--
--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.ai_messages FORCE ROW LEVEL SECURITY;


--
-- Name: ai_work_item_evidence; Type: TABLE; Schema: public
--
--
-- Name: ai_work_item_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_work_item_evidence (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    kind text NOT NULL,
    source_type text,
    source_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ai_work_item_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: ai_work_item_feedback; Type: TABLE; Schema: public
--
--
-- Name: ai_work_item_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_work_item_feedback (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rating text NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_work_item_feedback_rating_check CHECK ((rating = ANY (ARRAY['helpful'::text, 'not_helpful'::text])))
);

ALTER TABLE ONLY public.ai_work_item_feedback FORCE ROW LEVEL SECURITY;


--
-- Name: ai_work_items; Type: TABLE; Schema: public
--
--
-- Name: ai_work_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_work_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    agent_key text NOT NULL,
    finding_type text NOT NULL,
    detector_version text NOT NULL,
    fingerprint text NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    confidence numeric(19,4) DEFAULT '1'::numeric NOT NULL,
    materiality numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    subject_type text,
    subject_id uuid,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_run_id uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    dismissed_at timestamp with time zone,
    dismissed_by uuid,
    dismissal_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT ai_work_items_agent_key_check CHECK ((agent_key = ANY (ARRAY['accounting'::text, 'finance'::text]))),
    CONSTRAINT ai_work_items_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT ai_work_items_materiality_check CHECK ((materiality >= (0)::numeric)),
    CONSTRAINT ai_work_items_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT ai_work_items_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_review'::text, 'resolved'::text, 'dismissed'::text])))
);

ALTER TABLE ONLY public.ai_work_items FORCE ROW LEVEL SECURITY;


--
-- Name: allocation_rule_targets; Type: TABLE; Schema: public
--
--
-- Name: allocation_rule_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allocation_rule_targets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    target_account_id uuid NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    fixed_percent numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.allocation_rule_targets FORCE ROW LEVEL SECURITY;


--
-- Name: allocation_rules; Type: TABLE; Schema: public
--
--
-- Name: allocation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allocation_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    source jsonb DEFAULT '{}'::jsonb NOT NULL,
    basis text NOT NULL,
    basis_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    offset_account_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.allocation_rules FORCE ROW LEVEL SECURITY;


--
-- Name: allocation_runs; Type: TABLE; Schema: public
--
--
-- Name: allocation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allocation_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    period_id uuid NOT NULL,
    status text NOT NULL,
    total_allocated numeric(19,4) NOT NULL,
    journal_entry_id uuid,
    computation jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.allocation_runs FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_corrections; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_corrections (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    capture_item_id uuid NOT NULL,
    field_key text NOT NULL,
    line_index integer,
    before_value jsonb,
    after_value jsonb,
    corrected_by uuid NOT NULL,
    corrected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ap_capture_corrections_line_check CHECK (((line_index IS NULL) OR (line_index >= 0)))
);

ALTER TABLE ONLY public.ap_capture_corrections FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_events; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    capture_item_id uuid NOT NULL,
    event_kind text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ap_capture_events_detail_check CHECK ((jsonb_typeof(detail) = 'object'::text))
);

ALTER TABLE ONLY public.ap_capture_events FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_fields; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_fields (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    field_key text NOT NULL,
    line_index integer,
    raw_value text,
    normalized_value jsonb,
    confidence numeric(5,4),
    page_number integer,
    polygon jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ap_capture_fields_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT ap_capture_fields_line_check CHECK (((line_index IS NULL) OR (line_index >= 0))),
    CONSTRAINT ap_capture_fields_page_check CHECK (((page_number IS NULL) OR (page_number > 0)))
);

ALTER TABLE ONLY public.ap_capture_fields FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_items; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    file_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    source text DEFAULT 'upload'::text NOT NULL,
    original_filename text NOT NULL,
    content_hash text NOT NULL,
    document_kind text DEFAULT 'vendor_bill'::text NOT NULL,
    normalized jsonb DEFAULT '{}'::jsonb NOT NULL,
    validation_issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    overall_confidence numeric(5,4),
    vendor_candidate_id uuid,
    purchase_order_id uuid,
    document_id uuid,
    assigned_to uuid,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    materialized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT ap_capture_items_confidence_check CHECK (((overall_confidence IS NULL) OR ((overall_confidence >= (0)::numeric) AND (overall_confidence <= (1)::numeric)))),
    CONSTRAINT ap_capture_items_issues_array_check CHECK ((jsonb_typeof(validation_issues) = 'array'::text)),
    CONSTRAINT ap_capture_items_kind_check CHECK ((document_kind = ANY (ARRAY['vendor_bill'::text, 'vendor_credit'::text]))),
    CONSTRAINT ap_capture_items_normalized_object_check CHECK ((jsonb_typeof(normalized) = 'object'::text)),
    CONSTRAINT ap_capture_items_source_check CHECK ((source = 'upload'::text)),
    CONSTRAINT ap_capture_items_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'extracting'::text, 'needs_review'::text, 'ready'::text, 'duplicate'::text, 'failed'::text, 'materialized'::text, 'rejected'::text])))
);

ALTER TABLE ONLY public.ap_capture_items FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_rules; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_kind text NOT NULL,
    match jsonb NOT NULL,
    output jsonb NOT NULL,
    confirmation_count integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT ap_capture_rules_confirmations_check CHECK ((confirmation_count > 0)),
    CONSTRAINT ap_capture_rules_json_check CHECK (((jsonb_typeof(match) = 'object'::text) AND (jsonb_typeof(output) = 'object'::text))),
    CONSTRAINT ap_capture_rules_kind_check CHECK ((rule_kind = ANY (ARRAY['vendor_alias'::text, 'vendor_account'::text, 'field_mapping'::text])))
);

ALTER TABLE ONLY public.ap_capture_rules FORCE ROW LEVEL SECURITY;


--
-- Name: ap_capture_runs; Type: TABLE; Schema: public
--
--
-- Name: ap_capture_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_capture_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    capture_item_id uuid NOT NULL,
    attempt integer NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    api_version text,
    status text DEFAULT 'running'::text NOT NULL,
    raw_provider_payload jsonb,
    normalized_snapshot jsonb,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT ap_capture_runs_finished_check CHECK ((((status = 'running'::text) AND (finished_at IS NULL)) OR ((status <> 'running'::text) AND (finished_at IS NOT NULL)))),
    CONSTRAINT ap_capture_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.ap_capture_runs FORCE ROW LEVEL SECURITY;


--
-- Name: api_key_events; Type: TABLE; Schema: public
--
--
-- Name: api_key_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_key_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key_id uuid,
    method text NOT NULL,
    path text NOT NULL,
    status_code integer NOT NULL,
    duration_ms integer NOT NULL,
    ip_address text,
    user_agent text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.api_key_events FORCE ROW LEVEL SECURITY;


--
-- Name: api_keys; Type: TABLE; Schema: public
--
--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    key_preview text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.api_keys FORCE ROW LEVEL SECURITY;


--
-- Name: app_files; Type: TABLE; Schema: public
--
--
-- Name: app_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_files (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    app_id uuid NOT NULL,
    version_id uuid NOT NULL,
    path text NOT NULL,
    kind text NOT NULL,
    content_type text DEFAULT 'text/plain'::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    is_binary boolean DEFAULT false NOT NULL,
    size integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.app_files FORCE ROW LEVEL SECURITY;


--
-- Name: app_listings; Type: TABLE; Schema: public
--
--
-- Name: app_listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_listings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    publisher_org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    icon_key text DEFAULT 'box'::text NOT NULL,
    version text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    files jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: app_roles; Type: TABLE; Schema: public
--
--
-- Name: app_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_roles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    is_built_in boolean DEFAULT false NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_restriction jsonb DEFAULT '{"mode": "all"}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.app_roles FORCE ROW LEVEL SECURITY;


--
-- Name: app_runs; Type: TABLE; Schema: public
--
--
-- Name: app_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    app_id uuid NOT NULL,
    version_id uuid,
    endpoint text NOT NULL,
    status text NOT NULL,
    units integer DEFAULT 0 NOT NULL,
    logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_message text,
    duration_ms integer,
    actor_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.app_runs FORCE ROW LEVEL SECURITY;


--
-- Name: app_storage; Type: TABLE; Schema: public
--
--
-- Name: app_storage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_storage (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    app_id uuid NOT NULL,
    namespace text DEFAULT 'default'::text NOT NULL,
    key text NOT NULL,
    value jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.app_storage FORCE ROW LEVEL SECURITY;


--
-- Name: app_versions; Type: TABLE; Schema: public
--
--
-- Name: app_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    app_id uuid NOT NULL,
    version text NOT NULL,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.app_versions FORCE ROW LEVEL SECURITY;


--
-- Name: applications; Type: TABLE; Schema: public
--
--
-- Name: applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.applications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    from_line_id uuid NOT NULL,
    to_line_id uuid NOT NULL,
    amount numeric(19,4) NOT NULL,
    applied_on date NOT NULL,
    fx_gain_loss_entry_id uuid,
    unapplied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT app_positive CHECK ((amount > (0)::numeric))
);

ALTER TABLE ONLY public.applications FORCE ROW LEVEL SECURITY;


--
-- Name: approval_delegations; Type: TABLE; Schema: public
--
--
-- Name: approval_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_delegations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    from_user_id uuid NOT NULL,
    to_user_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    reason text,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.approval_delegations FORCE ROW LEVEL SECURITY;


--
-- Name: approval_policies; Type: TABLE; Schema: public
--
--
-- Name: approval_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    target_kind text NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.approval_policies FORCE ROW LEVEL SECURITY;


--
-- Name: approval_requests; Type: TABLE; Schema: public
--
--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    amount numeric(19,4),
    status text DEFAULT 'pending'::text NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    submitted_by uuid NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.approval_requests FORCE ROW LEVEL SECURITY;


--
-- Name: approval_steps; Type: TABLE; Schema: public
--
--
-- Name: approval_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    request_id uuid NOT NULL,
    step_number integer NOT NULL,
    assignee_party_id uuid,
    assignee_role text,
    decision text DEFAULT 'pending'::text NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    note text,
    is_delegated boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.approval_steps FORCE ROW LEVEL SECURITY;


--
-- Name: apps; Type: TABLE; Schema: public
--
--
-- Name: apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    icon_key text DEFAULT 'box'::text NOT NULL,
    status text DEFAULT 'installed'::text NOT NULL,
    active_version_id uuid,
    granted_permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    show_in_nav boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    provisioned jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.apps FORCE ROW LEVEL SECURITY;


--
-- Name: asset_categories; Type: TABLE; Schema: public
--
--
-- Name: asset_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_categories (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    asset_account_id uuid NOT NULL,
    accumulated_depreciation_account_id uuid NOT NULL,
    depreciation_expense_account_id uuid NOT NULL,
    gain_loss_account_id uuid,
    default_method text DEFAULT 'straight_line'::text NOT NULL,
    default_life_months integer,
    tax_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    default_convention text DEFAULT 'full_month'::text NOT NULL
);

ALTER TABLE ONLY public.asset_categories FORCE ROW LEVEL SECURITY;


--
-- Name: asset_events; Type: TABLE; Schema: public
--
--
-- Name: asset_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    kind text NOT NULL,
    occurred_on date NOT NULL,
    amount numeric(19,4),
    journal_entry_id uuid,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.asset_events FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log; Type: TABLE; Schema: public
--
--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    table_name text NOT NULL,
    row_id uuid NOT NULL,
    action text NOT NULL,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: bank_match_rules; Type: TABLE; Schema: public
--
--
-- Name: bank_match_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_match_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    criteria jsonb DEFAULT '{}'::jsonb NOT NULL,
    outcome jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.bank_match_rules FORCE ROW LEVEL SECURITY;


--
-- Name: bank_statement_lines; Type: TABLE; Schema: public
--
--
-- Name: bank_statement_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_statement_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    line_number integer NOT NULL,
    posted_on date NOT NULL,
    amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    description text,
    counterparty_ref text,
    bank_transaction_id text,
    match_status text DEFAULT 'unmatched'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.bank_statement_lines FORCE ROW LEVEL SECURITY;


--
-- Name: bank_statements; Type: TABLE; Schema: public
--
--
-- Name: bank_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_statements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    account_id uuid NOT NULL,
    source text NOT NULL,
    statement_date date NOT NULL,
    opening_balance numeric(19,4),
    closing_balance numeric(19,4),
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    raw_file_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.bank_statements FORCE ROW LEVEL SECURITY;


--
-- Name: billing_requests; Type: TABLE; Schema: public
--
--
-- Name: billing_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    request_number text NOT NULL,
    invoice_type text DEFAULT 'progress'::text NOT NULL,
    basis text DEFAULT 'date_range'::text NOT NULL,
    draw_amount numeric(19,4),
    start_date date,
    cutoff_date date,
    invoice_description text,
    customer_po text,
    billing_method_snapshot text,
    backup_required boolean DEFAULT false NOT NULL,
    backup_type text DEFAULT 'none'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    invoice_document_id uuid,
    selected_time_entry_ids jsonb,
    notes text,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT billing_requests_backup_type_check CHECK ((backup_type = ANY (ARRAY['none'::text, 'costed_timesheets'::text, 'quote_only'::text, 'timesheets_purchases'::text, 'purchases'::text, 'purchases_shop_time'::text]))),
    CONSTRAINT billing_requests_basis_check CHECK ((basis = ANY (ARRAY['date_range'::text, 'draw_amount'::text, 'time_selection'::text, 'milestone'::text]))),
    CONSTRAINT billing_requests_billing_method_check CHECK (((billing_method_snapshot IS NULL) OR (billing_method_snapshot = ANY (ARRAY['time_and_materials'::text, 'fixed_price'::text, 'cost_plus'::text])))),
    CONSTRAINT billing_requests_invoice_type_check CHECK ((invoice_type = ANY (ARRAY['progress'::text, 'final'::text]))),
    CONSTRAINT billing_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'invoiced'::text, 'closed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.billing_requests FORCE ROW LEVEL SECURITY;


--
-- Name: billing_schedules; Type: TABLE; Schema: public
--
--
-- Name: billing_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    type text,
    scheduled_date date,
    milestone text,
    percent_complete numeric(19,4),
    amount_billed numeric(19,4),
    percent_billed numeric(19,4),
    sort_order integer DEFAULT 0 NOT NULL,
    billing_request_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.billing_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: bom_components; Type: TABLE; Schema: public
--
--
-- Name: bom_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bom_components (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    assembly_item_id uuid NOT NULL,
    component_item_id uuid NOT NULL,
    quantity_per numeric(19,4) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.bom_components FORCE ROW LEVEL SECURITY;


--
-- Name: budget_lines; Type: TABLE; Schema: public
--
--
-- Name: budget_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    scenario_id uuid NOT NULL,
    account_id uuid NOT NULL,
    period_id uuid NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    amount numeric(19,4) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.budget_lines FORCE ROW LEVEL SECURITY;


--
-- Name: budget_scenarios; Type: TABLE; Schema: public
--
--
-- Name: budget_scenarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.budget_scenarios (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    book_id uuid NOT NULL,
    fiscal_year integer NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'budget'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    description text,
    revision integer DEFAULT 1 NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    CONSTRAINT budget_scenarios_fiscal_year_check CHECK (((fiscal_year >= 1900) AND (fiscal_year <= 9999))),
    CONSTRAINT budget_scenarios_kind_check CHECK ((kind = ANY (ARRAY['budget'::text, 'forecast'::text]))),
    CONSTRAINT budget_scenarios_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT budget_scenarios_revision_check CHECK ((revision > 0)),
    CONSTRAINT budget_scenarios_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'archived'::text])))
);

ALTER TABLE ONLY public.budget_scenarios FORCE ROW LEVEL SECURITY;


--
-- Name: change_set_items; Type: TABLE; Schema: public
--
--
-- Name: change_set_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_set_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    change_set_id uuid NOT NULL,
    table_name text NOT NULL,
    target_id uuid NOT NULL,
    op text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.change_set_items FORCE ROW LEVEL SECURITY;


--
-- Name: change_sets; Type: TABLE; Schema: public
--
--
-- Name: change_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_sets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    sandbox_org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.change_sets FORCE ROW LEVEL SECURITY;


--
-- Name: classes; Type: TABLE; Schema: public
--
--
-- Name: classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.classes FORCE ROW LEVEL SECURITY;


--
-- Name: close_automation_executions; Type: TABLE; Schema: public
--
--
-- Name: close_automation_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_automation_executions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    run_id uuid NOT NULL,
    task_id uuid,
    trigger text NOT NULL,
    event_key text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    executed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT close_automation_executions_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.close_automation_executions FORCE ROW LEVEL SECURITY;


--
-- Name: close_automation_rules; Type: TABLE; Schema: public
--
--
-- Name: close_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_automation_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    trigger text NOT NULL,
    action text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_automation_rules FORCE ROW LEVEL SECURITY;


--
-- Name: close_blueprint_dependencies; Type: TABLE; Schema: public
--
--
-- Name: close_blueprint_dependencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_blueprint_dependencies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    step_id uuid NOT NULL,
    depends_on_step_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT close_blueprint_dependencies_not_self CHECK ((step_id <> depends_on_step_id))
);

ALTER TABLE ONLY public.close_blueprint_dependencies FORCE ROW LEVEL SECURITY;


--
-- Name: close_blueprint_steps; Type: TABLE; Schema: public
--
--
-- Name: close_blueprint_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_blueprint_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    description text,
    workstream text NOT NULL,
    task_type text DEFAULT 'action'::text NOT NULL,
    completion_mode text DEFAULT 'manual'::text NOT NULL,
    gate_type text DEFAULT 'none'::text NOT NULL,
    due_offset_business_days integer DEFAULT 0 NOT NULL,
    evidence_required boolean DEFAULT false NOT NULL,
    default_owner_role_key text,
    default_reviewer_role_key text,
    sort_order integer DEFAULT 0 NOT NULL,
    applicability jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_blueprint_steps FORCE ROW LEVEL SECURITY;


--
-- Name: close_blueprints; Type: TABLE; Schema: public
--
--
-- Name: close_blueprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_blueprints (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    period_type text DEFAULT 'any'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    scope_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT close_blueprints_period_type_check CHECK ((period_type = ANY (ARRAY['month'::text, 'quarter'::text, 'year'::text, 'adjustment'::text, 'any'::text])))
);

ALTER TABLE ONLY public.close_blueprints FORCE ROW LEVEL SECURITY;


--
-- Name: close_events; Type: TABLE; Schema: public
--
--
-- Name: close_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid,
    task_id uuid,
    event_type text NOT NULL,
    actor_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.close_events FORCE ROW LEVEL SECURITY;


--
-- Name: close_exceptions; Type: TABLE; Schema: public
--
--
-- Name: close_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_exceptions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    task_id uuid,
    code text NOT NULL,
    category text NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    source text DEFAULT 'system'::text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_exceptions FORCE ROW LEVEL SECURITY;


--
-- Name: close_policies; Type: TABLE; Schema: public
--
--
-- Name: close_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    policy_type text NOT NULL,
    rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_policies FORCE ROW LEVEL SECURITY;


--
-- Name: close_reopen_requests; Type: TABLE; Schema: public
--
--
-- Name: close_reopen_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_reopen_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    period_id uuid NOT NULL,
    book_id uuid NOT NULL,
    subsidiary_id uuid,
    modules jsonb DEFAULT '[]'::jsonb NOT NULL,
    reason text NOT NULL,
    impact_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    requested_by uuid NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    expires_at timestamp with time zone,
    reclosed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_reopen_requests FORCE ROW LEVEL SECURITY;


--
-- Name: close_reporting_packages; Type: TABLE; Schema: public
--
--
-- Name: close_reporting_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_reporting_packages (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    reports jsonb DEFAULT '[]'::jsonb NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    delivery jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_reporting_packages FORCE ROW LEVEL SECURITY;


--
-- Name: close_run_tasks; Type: TABLE; Schema: public
--
--
-- Name: close_run_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_run_tasks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    blueprint_step_id uuid,
    key text NOT NULL,
    title text NOT NULL,
    description text,
    workstream text NOT NULL,
    task_type text NOT NULL,
    completion_mode text NOT NULL,
    gate_type text NOT NULL,
    status text DEFAULT 'blocked'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    owner_id uuid,
    reviewer_id uuid,
    due_on date,
    evidence_required boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    completed_by uuid,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    data_fingerprint text,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_run_tasks FORCE ROW LEVEL SECURITY;


--
-- Name: close_runs; Type: TABLE; Schema: public
--
--
-- Name: close_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    period_id uuid NOT NULL,
    book_id uuid NOT NULL,
    blueprint_id uuid NOT NULL,
    reporting_package_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    current_stage text DEFAULT 'scope'::text NOT NULL,
    target_close_date date NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    readiness_score integer DEFAULT 0 NOT NULL,
    data_fingerprint text,
    last_validated_at timestamp with time zone,
    started_at timestamp with time zone,
    started_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    closed_at timestamp with time zone,
    closed_by uuid,
    published_at timestamp with time zone,
    published_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    binder_snapshot jsonb,
    binder_hash text,
    CONSTRAINT close_runs_readiness_check CHECK (((readiness_score >= 0) AND (readiness_score <= 100)))
);

ALTER TABLE ONLY public.close_runs FORCE ROW LEVEL SECURITY;


--
-- Name: close_signoffs; Type: TABLE; Schema: public
--
--
-- Name: close_signoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_signoffs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    task_id uuid,
    signoff_type text NOT NULL,
    decision text NOT NULL,
    comment text,
    data_fingerprint text,
    signed_by uuid NOT NULL,
    signed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.close_signoffs FORCE ROW LEVEL SECURITY;


--
-- Name: close_task_evidence; Type: TABLE; Schema: public
--
--
-- Name: close_task_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.close_task_evidence (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    task_id uuid NOT NULL,
    file_id uuid,
    evidence_type text NOT NULL,
    reference_id uuid,
    reference_url text,
    label text NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.close_task_evidence FORCE ROW LEVEL SECURITY;


--
-- Name: connections; Type: TABLE; Schema: public
--
--
-- Name: connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connections (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    source text NOT NULL,
    display_name text NOT NULL,
    auth_kind text DEFAULT 'token'::text NOT NULL,
    status text DEFAULT 'unconfigured'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secrets text,
    mirror_enabled boolean DEFAULT false NOT NULL,
    mirror_schedule text DEFAULT 'daily'::text NOT NULL,
    cursor timestamp with time zone,
    last_run_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.connections FORCE ROW LEVEL SECURITY;


--
-- Name: consolidated_fx_rates; Type: TABLE; Schema: public
--
--
-- Name: consolidated_fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consolidated_fx_rates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    period_id uuid NOT NULL,
    from_currency text NOT NULL,
    to_currency text NOT NULL,
    current_rate numeric(19,10) NOT NULL,
    average_rate numeric(19,10) NOT NULL,
    historical_rate numeric(19,10) NOT NULL,
    source text DEFAULT 'derived'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.consolidated_fx_rates FORCE ROW LEVEL SECURITY;


--
-- Name: contacts; Type: TABLE; Schema: public
--
--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid,
    first_name text,
    last_name text,
    name text NOT NULL,
    title text,
    role text,
    email text,
    phone text,
    mobile_phone text,
    fax text,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.contacts FORCE ROW LEVEL SECURITY;


--
-- Name: cost_layer_consumptions; Type: TABLE; Schema: public
--
--
-- Name: cost_layer_consumptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_layer_consumptions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cost_layer_id uuid NOT NULL,
    issue_movement_id uuid NOT NULL,
    quantity numeric(19,4) NOT NULL,
    unit_cost numeric(19,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT layer_consumptions_positive CHECK ((quantity > (0)::numeric))
);

ALTER TABLE ONLY public.cost_layer_consumptions FORCE ROW LEVEL SECURITY;


--
-- Name: cost_layers; Type: TABLE; Schema: public
--
--
-- Name: cost_layers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_layers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    stock_location_id uuid NOT NULL,
    source_movement_id uuid NOT NULL,
    received_at timestamp with time zone NOT NULL,
    original_quantity numeric(19,4) NOT NULL,
    remaining_quantity numeric(19,4) NOT NULL,
    unit_cost numeric(19,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT cost_layers_remaining CHECK (((remaining_quantity >= (0)::numeric) AND (remaining_quantity <= original_quantity)))
);

ALTER TABLE ONLY public.cost_layers FORCE ROW LEVEL SECURITY;


--
-- Name: crm_account_assignment_events; Type: TABLE; Schema: public
--
--
-- Name: crm_account_assignment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_assignment_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    account_profile_id uuid NOT NULL,
    from_owner_user_id uuid,
    to_owner_user_id uuid,
    from_territory_id uuid,
    to_territory_id uuid,
    source text NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_account_assignment_events FORCE ROW LEVEL SECURITY;


--
-- Name: crm_account_profiles; Type: TABLE; Schema: public
--
--
-- Name: crm_account_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_profiles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    lifecycle_stage text DEFAULT 'lead'::text NOT NULL,
    status_id uuid,
    owner_user_id uuid,
    territory_id uuid,
    lead_source_id uuid,
    industry text,
    category text,
    annual_revenue numeric(19,4),
    employee_count integer,
    qualification_score integer,
    qualification jsonb DEFAULT '{}'::jsonb NOT NULL,
    next_action_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    qualified_at timestamp with time zone,
    converted_at timestamp with time zone,
    acquired_on date,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_account_employee_count CHECK (((employee_count IS NULL) OR (employee_count >= 0))),
    CONSTRAINT crm_account_qualification_score CHECK (((qualification_score IS NULL) OR ((qualification_score >= 0) AND (qualification_score <= 100))))
);

ALTER TABLE ONLY public.crm_account_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: crm_account_stage_events; Type: TABLE; Schema: public
--
--
-- Name: crm_account_stage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_stage_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    account_profile_id uuid NOT NULL,
    from_stage text,
    to_stage text NOT NULL,
    source_kind text DEFAULT 'manual'::text NOT NULL,
    source_id uuid,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_account_stage_events FORCE ROW LEVEL SECURITY;


--
-- Name: crm_account_statuses; Type: TABLE; Schema: public
--
--
-- Name: crm_account_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_account_statuses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    lifecycle_stage text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    sequence integer DEFAULT 0 NOT NULL,
    is_qualified boolean DEFAULT false NOT NULL,
    is_closed boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_account_statuses FORCE ROW LEVEL SECURITY;


--
-- Name: crm_activities; Type: TABLE; Schema: public
--
--
-- Name: crm_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_activities (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    subject text NOT NULL,
    body text,
    priority text DEFAULT 'normal'::text NOT NULL,
    owner_user_id uuid,
    assigned_user_id uuid,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    reminder_at timestamp with time zone,
    duration_minutes integer,
    recurrence jsonb,
    is_private boolean DEFAULT false NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_activity_dates CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at >= starts_at))),
    CONSTRAINT crm_activity_duration CHECK (((duration_minutes IS NULL) OR (duration_minutes >= 0)))
);

ALTER TABLE ONLY public.crm_activities FORCE ROW LEVEL SECURITY;


--
-- Name: crm_activity_links; Type: TABLE; Schema: public
--
--
-- Name: crm_activity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_activity_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_activity_links FORCE ROW LEVEL SECURITY;


--
-- Name: crm_activity_participants; Type: TABLE; Schema: public
--
--
-- Name: crm_activity_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_activity_participants (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    user_id uuid,
    contact_id uuid,
    email text,
    response text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_activity_participant_target CHECK ((num_nonnulls(user_id, contact_id, email) = 1))
);

ALTER TABLE ONLY public.crm_activity_participants FORCE ROW LEVEL SECURITY;


--
-- Name: crm_forecast_snapshots; Type: TABLE; Schema: public
--
--
-- Name: crm_forecast_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_forecast_snapshots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    owner_user_id uuid,
    sales_team_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    as_of timestamp with time zone DEFAULT now() NOT NULL,
    snapshot_kind text NOT NULL,
    currency text NOT NULL,
    pipeline_amount numeric(19,4) NOT NULL,
    weighted_amount numeric(19,4) NOT NULL,
    worst_case_amount numeric(19,4) NOT NULL,
    most_likely_amount numeric(19,4) NOT NULL,
    upside_amount numeric(19,4) NOT NULL,
    closed_amount numeric(19,4) NOT NULL,
    override_amount numeric(19,4),
    note text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_forecast_snapshot_dates CHECK ((period_end >= period_start)),
    CONSTRAINT crm_forecast_snapshot_target CHECK ((num_nonnulls(owner_user_id, sales_team_id) = 1))
);

ALTER TABLE ONLY public.crm_forecast_snapshots FORCE ROW LEVEL SECURITY;


--
-- Name: crm_lead_sources; Type: TABLE; Schema: public
--
--
-- Name: crm_lead_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_sources (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    parent_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_lead_sources FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunities; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunities (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    opportunity_number text NOT NULL,
    title text NOT NULL,
    party_id uuid,
    primary_contact_id uuid,
    owner_user_id uuid,
    sales_team_id uuid,
    status_id uuid NOT NULL,
    lead_source_id uuid,
    expected_close_date date,
    forecast_category text DEFAULT 'upside'::text NOT NULL,
    probability integer DEFAULT 0 NOT NULL,
    currency text NOT NULL,
    projected_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    weighted_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    range_low numeric(19,4),
    range_high numeric(19,4),
    subsidiary_id uuid,
    department_id uuid,
    location_id uuid,
    class_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    next_step text,
    competitor_notes text,
    win_loss_reason text,
    description text,
    closed_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_opportunity_amounts CHECK (((projected_amount >= (0)::numeric) AND (weighted_amount >= (0)::numeric) AND ((range_low IS NULL) OR (range_low >= (0)::numeric)) AND ((range_high IS NULL) OR (range_high >= (0)::numeric)) AND ((range_low IS NULL) OR (range_high IS NULL) OR (range_high >= range_low)))),
    CONSTRAINT crm_opportunity_probability CHECK (((probability >= 0) AND (probability <= 100)))
);

ALTER TABLE ONLY public.crm_opportunities FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunity_documents; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunity_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunity_documents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    document_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_opportunity_documents FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunity_lines; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunity_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunity_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    line_number integer NOT NULL,
    item_id uuid,
    description text,
    quantity numeric(19,4) DEFAULT '1'::numeric NOT NULL,
    unit text,
    unit_price numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    probability integer,
    expected_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_opportunity_line_values CHECK (((quantity > (0)::numeric) AND (unit_price >= (0)::numeric) AND (amount >= (0)::numeric) AND (expected_amount >= (0)::numeric) AND ((probability IS NULL) OR ((probability >= 0) AND (probability <= 100)))))
);

ALTER TABLE ONLY public.crm_opportunity_lines FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunity_stage_events; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunity_stage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunity_stage_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    from_status_id uuid,
    to_status_id uuid NOT NULL,
    probability integer NOT NULL,
    forecast_category text NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_opportunity_stage_events FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunity_statuses; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunity_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunity_statuses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    sequence integer DEFAULT 0 NOT NULL,
    probability integer DEFAULT 0 NOT NULL,
    default_forecast_category text DEFAULT 'upside'::text NOT NULL,
    is_closed boolean DEFAULT false NOT NULL,
    is_won boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_opportunity_status_probability CHECK (((probability >= 0) AND (probability <= 100))),
    CONSTRAINT crm_opportunity_status_won_closed CHECK (((NOT is_won) OR is_closed))
);

ALTER TABLE ONLY public.crm_opportunity_statuses FORCE ROW LEVEL SECURITY;


--
-- Name: crm_opportunity_team_members; Type: TABLE; Schema: public
--
--
-- Name: crm_opportunity_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_opportunity_team_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contribution_percent numeric(19,4) NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_opportunity_contribution CHECK (((contribution_percent > (0)::numeric) AND (contribution_percent <= (100)::numeric)))
);

ALTER TABLE ONLY public.crm_opportunity_team_members FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sales_quotas; Type: TABLE; Schema: public
--
--
-- Name: crm_sales_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sales_quotas (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    owner_user_id uuid,
    sales_team_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    currency text NOT NULL,
    amount numeric(19,4) NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT crm_sales_quota_amount CHECK ((amount >= (0)::numeric)),
    CONSTRAINT crm_sales_quota_dates CHECK ((period_end >= period_start)),
    CONSTRAINT crm_sales_quota_target CHECK ((num_nonnulls(owner_user_id, sales_team_id) = 1))
);

ALTER TABLE ONLY public.crm_sales_quotas FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sales_team_members; Type: TABLE; Schema: public
--
--
-- Name: crm_sales_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sales_team_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_sales_team_members FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sales_teams; Type: TABLE; Schema: public
--
--
-- Name: crm_sales_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sales_teams (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    manager_user_id uuid,
    parent_team_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_sales_teams FORCE ROW LEVEL SECURITY;


--
-- Name: crm_sales_territories; Type: TABLE; Schema: public
--
--
-- Name: crm_sales_territories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sales_territories (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    priority integer DEFAULT 100 NOT NULL,
    manager_user_id uuid,
    default_owner_user_id uuid,
    match_mode text DEFAULT 'all'::text NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.crm_sales_territories FORCE ROW LEVEL SECURITY;


--
-- Name: currencies; Type: TABLE; Schema: public
--
--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currencies (
    code text NOT NULL,
    name text NOT NULL,
    minor_units integer DEFAULT 2 NOT NULL
);


--
-- Name: custom_field_defs; Type: TABLE; Schema: public
--
--
-- Name: custom_field_defs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_defs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    target_table text NOT NULL,
    target_kind text,
    key text NOT NULL,
    label text NOT NULL,
    field_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.custom_field_defs FORCE ROW LEVEL SECURITY;


--
-- Name: custom_record_types; Type: TABLE; Schema: public
--
--
-- Name: custom_record_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_record_types (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    plural_name text NOT NULL,
    icon_key text DEFAULT 'grid'::text NOT NULL,
    description text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    show_in_nav boolean DEFAULT false NOT NULL,
    allowed_roles jsonb,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.custom_record_types FORCE ROW LEVEL SECURITY;


--
-- Name: custom_records; Type: TABLE; Schema: public
--
--
-- Name: custom_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_records (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    type_id uuid NOT NULL,
    type_key text NOT NULL,
    record_number text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.custom_records FORCE ROW LEVEL SECURITY;


--
-- Name: customer_roles; Type: TABLE; Schema: public
--
--
-- Name: customer_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_roles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    ar_account_id uuid,
    payment_terms_id uuid,
    credit_limit numeric(19,4),
    currency text,
    sales_rep_id uuid,
    tax_code_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.customer_roles FORCE ROW LEVEL SECURITY;


--
-- Name: departments; Type: TABLE; Schema: public
--
--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.departments FORCE ROW LEVEL SECURITY;


--
-- Name: depreciation_book_policies; Type: TABLE; Schema: public
--
--
-- Name: depreciation_book_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depreciation_book_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    book_id uuid NOT NULL,
    category_id uuid NOT NULL,
    method text DEFAULT 'straight_line'::text NOT NULL,
    life_months integer,
    rate_percent numeric(19,4),
    convention text DEFAULT 'full_month'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT dep_book_policies_conv_check CHECK ((convention = ANY (ARRAY['full_month'::text, 'mid_month'::text, 'half_year'::text]))),
    CONSTRAINT dep_book_policies_method_check CHECK ((method = ANY (ARRAY['straight_line'::text, 'declining_balance'::text, 'double_declining'::text, 'units_of_production'::text, 'manual'::text])))
);

ALTER TABLE ONLY public.depreciation_book_policies FORCE ROW LEVEL SECURITY;


--
-- Name: depreciation_methods; Type: TABLE; Schema: public
--
--
-- Name: depreciation_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depreciation_methods (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    formula text NOT NULL,
    end_of_life text DEFAULT 'fully_depreciate'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT depreciation_methods_eol_check CHECK ((end_of_life = ANY (ARRAY['fully_depreciate'::text, 'retain_balance'::text])))
);

ALTER TABLE ONLY public.depreciation_methods FORCE ROW LEVEL SECURITY;


--
-- Name: depreciation_schedule_lines; Type: TABLE; Schema: public
--
--
-- Name: depreciation_schedule_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depreciation_schedule_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    period_id uuid NOT NULL,
    sequence integer NOT NULL,
    planned_amount numeric(19,4) NOT NULL,
    posted_amount numeric(19,4),
    journal_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.depreciation_schedule_lines FORCE ROW LEVEL SECURITY;


--
-- Name: depreciation_schedules; Type: TABLE; Schema: public
--
--
-- Name: depreciation_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depreciation_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    book_id uuid NOT NULL,
    method text NOT NULL,
    life_months integer,
    rate_percent numeric(19,4),
    units_total numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.depreciation_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: document_lines; Type: TABLE; Schema: public
--
--
-- Name: document_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    document_id uuid NOT NULL,
    line_number integer NOT NULL,
    item_id uuid,
    account_id uuid,
    description text,
    quantity numeric(19,4) DEFAULT '1'::numeric NOT NULL,
    unit text,
    unit_price numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    amount numeric(19,4) NOT NULL,
    tax_code_id uuid,
    tax_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    employee_id uuid,
    time_entry_id uuid,
    time_type_id uuid,
    cost_multiplier numeric(19,4),
    is_billable boolean DEFAULT false NOT NULL,
    billed_by_line_id uuid,
    quantity_fulfilled numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    quantity_billed numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    tax_overridden boolean DEFAULT false NOT NULL,
    subsidiary_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    stock_location_id uuid,
    CONSTRAINT doc_lines_target CHECK (((item_id IS NOT NULL) OR (account_id IS NOT NULL)))
);

ALTER TABLE ONLY public.document_lines FORCE ROW LEVEL SECURITY;


--
-- Name: document_links; Type: TABLE; Schema: public
--
--
-- Name: document_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_links (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    from_document_id uuid NOT NULL,
    to_document_id uuid NOT NULL,
    link_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.document_links FORCE ROW LEVEL SECURITY;


--
-- Name: documents; Type: TABLE; Schema: public
--
--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    document_number text NOT NULL,
    party_id uuid,
    document_date date NOT NULL,
    posting_date date,
    due_date date,
    currency text NOT NULL,
    fx_rate numeric(19,10) DEFAULT '1'::numeric NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    posted_entry_id uuid,
    voided_at timestamp with time zone,
    subtotal numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    tax_total numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    total numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    payment_card_id uuid,
    billing_method text,
    is_final_invoice boolean DEFAULT false NOT NULL,
    reference_number text,
    internal_notes text,
    payment_hold_reason text,
    expected_pay_date date,
    memo text,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    open_balance numeric(19,4),
    subsidiary_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.documents FORCE ROW LEVEL SECURITY;


--
-- Name: email_log; Type: TABLE; Schema: public
--
--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    job_id text,
    provider_message_id text,
    provider text,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    recipient_primary text,
    from_addr text,
    reply_to_addr text,
    subject text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    category_key text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    sent_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.email_log FORCE ROW LEVEL SECURITY;


--
-- Name: employee_roles; Type: TABLE; Schema: public
--
--
-- Name: employee_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_roles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    employee_number text,
    department_id uuid,
    supervisor_id uuid,
    trade_id uuid,
    worker_comp_group_id uuid,
    hired_on date,
    terminated_on date,
    has_benefits boolean DEFAULT false NOT NULL,
    vacation_days_per_year integer,
    billable_utilization_target integer,
    expense_account_id uuid,
    external_payroll_id text,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.employee_roles FORCE ROW LEVEL SECURITY;


--
-- Name: fair_value_prices; Type: TABLE; Schema: public
--
--
-- Name: fair_value_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fair_value_prices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    currency text NOT NULL,
    unit_price numeric(19,4) NOT NULL,
    low_value numeric(19,4),
    high_value numeric(19,4),
    effective_from date,
    effective_to date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.fair_value_prices FORCE ROW LEVEL SECURITY;


--
-- Name: file_attachments; Type: TABLE; Schema: public
--
--
-- Name: file_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_attachments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    file_id uuid NOT NULL,
    target_table text NOT NULL,
    target_id uuid NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.file_attachments FORCE ROW LEVEL SECURITY;


--
-- Name: file_blobs; Type: TABLE; Schema: public
--
--
-- Name: file_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_blobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    version_id uuid NOT NULL,
    bytes bytea NOT NULL
);


--
-- Name: file_versions; Type: TABLE; Schema: public
--
--
-- Name: file_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    file_id uuid NOT NULL,
    version_number integer NOT NULL,
    size_bytes integer NOT NULL,
    content_type text NOT NULL,
    storage_kind text DEFAULT 'db'::text NOT NULL,
    content_hash text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: files; Type: TABLE; Schema: public
--
--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    name text NOT NULL,
    extension text,
    file_type text DEFAULT 'other'::text NOT NULL,
    content_type text NOT NULL,
    size_bytes integer NOT NULL,
    storage_kind text DEFAULT 'db'::text NOT NULL,
    content_hash text,
    is_inactive boolean DEFAULT false NOT NULL,
    current_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.files FORCE ROW LEVEL SECURITY;


--
-- Name: fiscal_calendars; Type: TABLE; Schema: public
--
--
-- Name: fiscal_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fiscal_calendars (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    cadence text DEFAULT 'monthly'::text NOT NULL,
    year_start_month integer DEFAULT 1 NOT NULL,
    week_starts_on integer DEFAULT 1 NOT NULL,
    anchor_date date,
    time_zone text DEFAULT 'UTC'::text NOT NULL,
    adjustment_period_enabled boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT fiscal_calendars_cadence_check CHECK ((cadence = ANY (ARRAY['monthly'::text, 'four_four_five'::text, 'four_five_four'::text, 'five_four_four'::text, 'thirteen_period'::text, 'custom'::text]))),
    CONSTRAINT fiscal_calendars_month_check CHECK (((year_start_month >= 1) AND (year_start_month <= 12))),
    CONSTRAINT fiscal_calendars_week_check CHECK (((week_starts_on >= 0) AND (week_starts_on <= 6)))
);

ALTER TABLE ONLY public.fiscal_calendars FORCE ROW LEVEL SECURITY;


--
-- Name: fixed_assets; Type: TABLE; Schema: public
--
--
-- Name: fixed_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fixed_assets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    category_id uuid NOT NULL,
    asset_number text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    acquired_on date,
    in_service_on date,
    acquisition_cost numeric(19,4) NOT NULL,
    salvage_value numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    source_document_line_id uuid,
    serial_number text,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    custodian_party_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid NOT NULL
);

ALTER TABLE ONLY public.fixed_assets FORCE ROW LEVEL SECURITY;


--
-- Name: flow_gates; Type: TABLE; Schema: public
--
--
-- Name: flow_gates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_gates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    run_id uuid NOT NULL,
    node_id text NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    title text NOT NULL,
    assignee_user_id uuid,
    assignee_role text,
    group_key text NOT NULL,
    quorum text DEFAULT 'any'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    signature_required boolean DEFAULT false NOT NULL,
    comment text,
    decided_by uuid,
    decided_at timestamp with time zone,
    remind_at timestamp with time zone,
    escalate_at timestamp with time zone,
    reminded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.flow_gates FORCE ROW LEVEL SECURITY;


--
-- Name: flow_locks; Type: TABLE; Schema: public
--
--
-- Name: flow_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_locks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    reason text,
    exempt_roles jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.flow_locks FORCE ROW LEVEL SECURITY;


--
-- Name: flow_run_effects; Type: TABLE; Schema: public
--
--
-- Name: flow_run_effects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_run_effects (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_id uuid NOT NULL,
    effect_key text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.flow_run_effects FORCE ROW LEVEL SECURITY;


--
-- Name: flow_runs; Type: TABLE; Schema: public
--
--
-- Name: flow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    subject_kind text NOT NULL,
    subject_id uuid NOT NULL,
    trigger text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    error text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.flow_runs FORCE ROW LEVEL SECURITY;


--
-- Name: flows; Type: TABLE; Schema: public
--
--
-- Name: flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text DEFAULT 'Flow'::text NOT NULL,
    description text,
    subject_kind text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    graph jsonb NOT NULL,
    last_scheduled_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.flows FORCE ROW LEVEL SECURITY;


--
-- Name: folders; Type: TABLE; Schema: public
--
--
-- Name: folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folders (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_folder_id uuid,
    name text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    system_kind text,
    record_table text,
    record_id uuid,
    is_private boolean DEFAULT false NOT NULL,
    owner_id uuid,
    is_inactive boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.folders FORCE ROW LEVEL SECURITY;


--
-- Name: form_layouts; Type: TABLE; Schema: public
--
--
-- Name: form_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_layouts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    record_type text NOT NULL,
    name text NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    allowed_roles jsonb,
    layout jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.form_layouts FORCE ROW LEVEL SECURITY;


--
-- Name: form_response_steps; Type: TABLE; Schema: public
--
--
-- Name: form_response_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_response_steps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    response_id uuid NOT NULL,
    actor uuid,
    action text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.form_response_steps FORCE ROW LEVEL SECURITY;


--
-- Name: form_responses; Type: TABLE; Schema: public
--
--
-- Name: form_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_responses (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    version_id uuid NOT NULL,
    template_key text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    submitted_by uuid,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.form_responses FORCE ROW LEVEL SECURITY;


--
-- Name: form_template_versions; Type: TABLE; Schema: public
--
--
-- Name: form_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_template_versions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_id uuid NOT NULL,
    version integer NOT NULL,
    schema jsonb NOT NULL,
    changelog text,
    published_at timestamp with time zone,
    published_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.form_template_versions FORCE ROW LEVEL SECURITY;


--
-- Name: form_templates; Type: TABLE; Schema: public
--
--
-- Name: form_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    category text,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    kind text DEFAULT 'form'::text NOT NULL,
    allowed_roles jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.form_templates FORCE ROW LEVEL SECURITY;


--
-- Name: fx_provider_configs; Type: TABLE; Schema: public
--
--
-- Name: fx_provider_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_provider_configs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    provider text NOT NULL,
    display_name text NOT NULL,
    base_currency text NOT NULL,
    currencies jsonb DEFAULT '[]'::jsonb NOT NULL,
    schedule text DEFAULT 'daily'::text NOT NULL,
    sync_hour_utc integer DEFAULT 22 NOT NULL,
    lookback_days integer DEFAULT 7 NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    secrets text,
    next_sync_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_observation_date date,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT fx_provider_configs_base_check CHECK ((base_currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT fx_provider_configs_currencies_check CHECK ((jsonb_typeof(currencies) = 'array'::text)),
    CONSTRAINT fx_provider_configs_hour_check CHECK (((sync_hour_utc >= 0) AND (sync_hour_utc <= 23))),
    CONSTRAINT fx_provider_configs_lookback_check CHECK (((lookback_days >= 1) AND (lookback_days <= 31))),
    CONSTRAINT fx_provider_configs_provider_check CHECK ((provider = ANY (ARRAY['bank_of_canada'::text, 'ecb'::text, 'open_exchange_rates'::text]))),
    CONSTRAINT fx_provider_configs_schedule_check CHECK ((schedule = ANY (ARRAY['manual'::text, 'daily'::text, 'weekdays'::text, 'weekly'::text])))
);

ALTER TABLE ONLY public.fx_provider_configs FORCE ROW LEVEL SECURITY;


--
-- Name: fx_provider_runs; Type: TABLE; Schema: public
--
--
-- Name: fx_provider_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_provider_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    provider_config_id uuid NOT NULL,
    trigger text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    requested_from date,
    requested_to date,
    observations_received integer DEFAULT 0 NOT NULL,
    rates_inserted integer DEFAULT 0 NOT NULL,
    rates_updated integer DEFAULT 0 NOT NULL,
    manual_overrides_preserved integer DEFAULT 0 NOT NULL,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    created_by uuid,
    CONSTRAINT fx_provider_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'failed'::text]))),
    CONSTRAINT fx_provider_runs_trigger_check CHECK ((trigger = ANY (ARRAY['test'::text, 'manual'::text, 'scheduler'::text])))
);

ALTER TABLE ONLY public.fx_provider_runs FORCE ROW LEVEL SECURITY;


--
-- Name: fx_rates; Type: TABLE; Schema: public
--
--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    from_currency text NOT NULL,
    to_currency text NOT NULL,
    as_of date NOT NULL,
    rate_type text DEFAULT 'spot'::text NOT NULL,
    rate numeric(19,10) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    org_id uuid NOT NULL,
    provider_config_id uuid,
    imported_at timestamp with time zone
);

ALTER TABLE ONLY public.fx_rates FORCE ROW LEVEL SECURITY;


--
-- Name: import_jobs; Type: TABLE; Schema: public
--
--
-- Name: import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_jobs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    resource_key text NOT NULL,
    resource_label text,
    format text NOT NULL,
    file_name text,
    mode text DEFAULT 'upsert'::text NOT NULL,
    status text DEFAULT 'committed'::text NOT NULL,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    created_count integer DEFAULT 0 NOT NULL,
    updated_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);

ALTER TABLE ONLY public.import_jobs FORCE ROW LEVEL SECURITY;


--
-- Name: insight_cards; Type: TABLE; Schema: public
--
--
-- Name: insight_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight_cards (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    query jsonb DEFAULT '{}'::jsonb NOT NULL,
    viz_type text DEFAULT 'table'::text NOT NULL,
    viz_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    allowed_roles jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.insight_cards FORCE ROW LEVEL SECURITY;


--
-- Name: insight_dashboard_pins; Type: TABLE; Schema: public
--
--
-- Name: insight_dashboard_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight_dashboard_pins (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    dashboard_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.insight_dashboard_pins FORCE ROW LEVEL SECURITY;


--
-- Name: insight_dashboards; Type: TABLE; Schema: public
--
--
-- Name: insight_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight_dashboards (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    layout jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    allowed_roles jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    is_home boolean DEFAULT false NOT NULL,
    home_for_role text
);

ALTER TABLE ONLY public.insight_dashboards FORCE ROW LEVEL SECURITY;


--
-- Name: intercompany_pairs; Type: TABLE; Schema: public
--
--
-- Name: intercompany_pairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intercompany_pairs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    from_subsidiary_id uuid NOT NULL,
    to_subsidiary_id uuid NOT NULL,
    due_from_account_id uuid NOT NULL,
    due_to_account_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.intercompany_pairs FORCE ROW LEVEL SECURITY;


--
-- Name: inventory_movements; Type: TABLE; Schema: public
--
--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_movements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    kind text NOT NULL,
    moved_at timestamp with time zone NOT NULL,
    stock_location_id uuid NOT NULL,
    lot_id uuid,
    serial_id uuid,
    quantity numeric(19,4) NOT NULL,
    unit_cost numeric(19,4),
    total_value numeric(19,4),
    document_line_id uuid,
    journal_entry_id uuid,
    paired_movement_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT inv_moves_qty_nonzero CHECK ((quantity <> (0)::numeric))
);

ALTER TABLE ONLY public.inventory_movements FORCE ROW LEVEL SECURITY;


--
-- Name: invoice_backups; Type: TABLE; Schema: public
--
--
-- Name: invoice_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_backups (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    document_id uuid NOT NULL,
    billing_request_id uuid,
    backup_type text NOT NULL,
    file_id uuid NOT NULL,
    page_count integer,
    component_manifest jsonb DEFAULT '[]'::jsonb NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.invoice_backups FORCE ROW LEVEL SECURITY;


--
-- Name: item_inventory_profiles; Type: TABLE; Schema: public
--
--
-- Name: item_inventory_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_inventory_profiles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    costing_method text DEFAULT 'moving_average'::text NOT NULL,
    tracking text DEFAULT 'none'::text NOT NULL,
    asset_account_id uuid NOT NULL,
    cogs_account_id uuid NOT NULL,
    adjustment_account_id uuid,
    variance_account_id uuid,
    standard_cost numeric(19,4),
    base_unit text DEFAULT 'ea'::text NOT NULL,
    unit_conversions jsonb DEFAULT '{}'::jsonb NOT NULL,
    reorder_point numeric(19,4),
    preferred_stock_level numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    received_not_billed_account_id uuid
);

ALTER TABLE ONLY public.item_inventory_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: items; Type: TABLE; Schema: public
--
--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    code text,
    name text NOT NULL,
    category text,
    income_account_id uuid,
    expense_account_id uuid,
    default_rate numeric(19,4),
    unit text,
    tax_code_id uuid,
    show_on_timesheet boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    recognition_rule_id uuid,
    deferred_account_id uuid,
    create_plans_on text DEFAULT 'billing'::text NOT NULL,
    revenue_allocation text DEFAULT 'normal'::text NOT NULL,
    standalone_selling_price numeric(19,4),
    default_cost numeric(19,4),
    cost_recovery_account_id uuid,
    CONSTRAINT items_create_plans_on_check CHECK ((create_plans_on = ANY (ARRAY['billing'::text, 'fulfillment'::text, 'arrangement'::text]))),
    CONSTRAINT items_revenue_allocation_check CHECK ((revenue_allocation = ANY (ARRAY['normal'::text, 'exclude'::text, 'software'::text])))
);

ALTER TABLE ONLY public.items FORCE ROW LEVEL SECURITY;


--
-- Name: journal_entries; Type: TABLE; Schema: public
--
--
-- Name: journal_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_entries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    book_id uuid NOT NULL,
    entry_number text NOT NULL,
    posting_date date NOT NULL,
    period_id uuid NOT NULL,
    memo text,
    status text DEFAULT 'draft'::text NOT NULL,
    posted_at timestamp with time zone,
    posted_by uuid,
    source_document_id uuid,
    origin text DEFAULT 'manual'::text NOT NULL,
    reverses_entry_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid NOT NULL
);

ALTER TABLE ONLY public.journal_entries FORCE ROW LEVEL SECURITY;


--
-- Name: journal_lines; Type: TABLE; Schema: public
--
--
-- Name: journal_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.journal_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    line_number integer NOT NULL,
    account_id uuid NOT NULL,
    amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    txn_amount numeric(19,4) NOT NULL,
    fx_rate numeric(19,10) DEFAULT '1'::numeric NOT NULL,
    memo text,
    party_id uuid,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    payment_card_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    quantity numeric(19,4),
    unit text,
    due_date date,
    is_open_item boolean DEFAULT false NOT NULL,
    tax_code_id uuid,
    reconciled_at timestamp with time zone,
    reconciliation_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    subsidiary_id uuid NOT NULL,
    CONSTRAINT jl_nonzero CHECK ((amount <> (0)::numeric))
);

ALTER TABLE ONLY public.journal_lines FORCE ROW LEVEL SECURITY;


--
-- Name: labor_burden_rates; Type: TABLE; Schema: public
--
--
-- Name: labor_burden_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labor_burden_rates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    department_id uuid,
    category text,
    method text DEFAULT 'live'::text NOT NULL,
    rate_percent numeric(19,4) NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.labor_burden_rates FORCE ROW LEVEL SECURITY;


--
-- Name: landed_cost_allocations; Type: TABLE; Schema: public
--
--
-- Name: landed_cost_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landed_cost_allocations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    source_document_line_id uuid,
    target_cost_layer_id uuid NOT NULL,
    basis text NOT NULL,
    amount numeric(19,4) NOT NULL,
    journal_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.landed_cost_allocations FORCE ROW LEVEL SECURITY;


--
-- Name: list_views; Type: TABLE; Schema: public
--
--
-- Name: list_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.list_views (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    record_type text NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    owner_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.list_views FORCE ROW LEVEL SECURITY;


--
-- Name: locations; Type: TABLE; Schema: public
--
--
-- Name: locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.locations FORCE ROW LEVEL SECURITY;


--
-- Name: lots; Type: TABLE; Schema: public
--
--
-- Name: lots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lots (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    lot_number text NOT NULL,
    expires_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.lots FORCE ROW LEVEL SECURITY;


--
-- Name: masking_policies; Type: TABLE; Schema: public
--
--
-- Name: masking_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.masking_policies (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    table_name text NOT NULL,
    column_name text NOT NULL,
    transform text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.masking_policies FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public
--
--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text DEFAULT 'general'::text NOT NULL,
    title text NOT NULL,
    body text,
    href text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: number_sequences; Type: TABLE; Schema: public
--
--
-- Name: number_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.number_sequences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    document_kind text NOT NULL,
    prefix text DEFAULT ''::text NOT NULL,
    next_number integer DEFAULT 1 NOT NULL,
    padding integer DEFAULT 5 NOT NULL,
    gapless boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid
);

ALTER TABLE ONLY public.number_sequences FORCE ROW LEVEL SECURITY;


--
-- Name: org_nav_configs; Type: TABLE; Schema: public
--
--
-- Name: org_nav_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_nav_configs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.org_nav_configs FORCE ROW LEVEL SECURITY;


--
-- Name: orgs; Type: TABLE; Schema: public
--
--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    name text NOT NULL,
    legal_name text,
    base_currency text NOT NULL,
    country text NOT NULL,
    tax_ids jsonb DEFAULT '{}'::jsonb,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    env_kind text DEFAULT 'production'::text NOT NULL,
    sandbox_of uuid,
    sandbox_seed uuid
);


--
-- Name: parties; Type: TABLE; Schema: public
--
--
-- Name: parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parties (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    legal_name text,
    short_code text,
    email text,
    phone text,
    website text,
    tax_ids jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    subsidiary_id uuid
);

ALTER TABLE ONLY public.parties FORCE ROW LEVEL SECURITY;


--
-- Name: party_bank_accounts; Type: TABLE; Schema: public
--
--
-- Name: party_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.party_bank_accounts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    bank_name text,
    country text,
    currency text,
    routing jsonb DEFAULT '{}'::jsonb NOT NULL,
    account_number_encrypted text,
    account_last_four text,
    approved_at date,
    approved_by uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    approval_status text DEFAULT 'approved'::text NOT NULL
);

ALTER TABLE ONLY public.party_bank_accounts FORCE ROW LEVEL SECURITY;


--
-- Name: party_subsidiaries; Type: TABLE; Schema: public
--
--
-- Name: party_subsidiaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.party_subsidiaries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.party_subsidiaries FORCE ROW LEVEL SECURITY;


--
-- Name: payment_bank_profiles; Type: TABLE; Schema: public
--
--
-- Name: payment_bank_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_bank_profiles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    bank_account_id uuid NOT NULL,
    subsidiary_id uuid,
    payment_format_id uuid NOT NULL,
    currency text NOT NULL,
    country text,
    originator_secrets_encrypted text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    sftp_server_id uuid,
    sftp_folder text,
    require_run_approval boolean DEFAULT true NOT NULL,
    require_file_approval boolean DEFAULT false NOT NULL,
    auto_remittance boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_bank_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: payment_cards; Type: TABLE; Schema: public
--
--
-- Name: payment_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_cards (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    holder_party_id uuid NOT NULL,
    liability_account_id uuid NOT NULL,
    label text NOT NULL,
    last_four text,
    network text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_cards FORCE ROW LEVEL SECURITY;


--
-- Name: payment_events; Type: TABLE; Schema: public
--
--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_run_id uuid NOT NULL,
    payment_instruction_id uuid,
    payment_file_id uuid,
    event_type text NOT NULL,
    from_status text,
    to_status text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.payment_events FORCE ROW LEVEL SECURITY;


--
-- Name: payment_file_deliveries; Type: TABLE; Schema: public
--
--
-- Name: payment_file_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_file_deliveries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_file_id uuid NOT NULL,
    channel text NOT NULL,
    target_ref text,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    delivered_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    error text,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_file_deliveries FORCE ROW LEVEL SECURITY;


--
-- Name: payment_files; Type: TABLE; Schema: public
--
--
-- Name: payment_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_files (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_run_id uuid NOT NULL,
    payment_bank_profile_id uuid NOT NULL,
    payment_format_id uuid NOT NULL,
    parent_payment_file_id uuid,
    sequence_number integer NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    content_hash text NOT NULL,
    file_id uuid NOT NULL,
    file_version_id uuid NOT NULL,
    payment_count integer NOT NULL,
    total_amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    status text DEFAULT 'generated'::text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    generated_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejected_by uuid,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_files FORCE ROW LEVEL SECURITY;


--
-- Name: payment_formats; Type: TABLE; Schema: public
--
--
-- Name: payment_formats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_formats (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    rail text NOT NULL,
    direction text DEFAULT 'credit'::text NOT NULL,
    country text,
    currency text,
    file_extension text DEFAULT 'txt'::text NOT NULL,
    content_type text DEFAULT 'text/plain; charset=utf-8'::text NOT NULL,
    formatter_script text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_formats FORCE ROW LEVEL SECURITY;


--
-- Name: payment_instructions; Type: TABLE; Schema: public
--
--
-- Name: payment_instructions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_instructions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_run_id uuid NOT NULL,
    payee_party_id uuid NOT NULL,
    payee_bank_account_id uuid,
    amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    payment_document_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    remittance_email_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    end_to_end_id text,
    payment_reference text,
    mandate_id uuid
);

ALTER TABLE ONLY public.payment_instructions FORCE ROW LEVEL SECURITY;


--
-- Name: payment_mandates; Type: TABLE; Schema: public
--
--
-- Name: payment_mandates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_mandates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    party_bank_account_id uuid NOT NULL,
    scheme text NOT NULL,
    mandate_reference text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    signed_on date,
    valid_from date,
    expires_on date,
    proof_file_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_mandates FORCE ROW LEVEL SECURITY;


--
-- Name: payment_remittances; Type: TABLE; Schema: public
--
--
-- Name: payment_remittances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_remittances (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_instruction_id uuid NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    file_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_remittances FORCE ROW LEVEL SECURITY;


--
-- Name: payment_run_items; Type: TABLE; Schema: public
--
--
-- Name: payment_run_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_run_items (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_run_id uuid NOT NULL,
    payment_instruction_id uuid,
    source_document_id uuid NOT NULL,
    source_open_line_id uuid NOT NULL,
    kind text NOT NULL,
    gross_amount numeric(19,4) NOT NULL,
    discount_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    credit_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    payment_amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    fx_rate numeric(19,10) DEFAULT '1'::numeric NOT NULL,
    status text DEFAULT 'selected'::text NOT NULL,
    exclusion_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_run_items FORCE ROW LEVEL SECURITY;


--
-- Name: payment_runs; Type: TABLE; Schema: public
--
--
-- Name: payment_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    run_number text NOT NULL,
    bank_account_id uuid NOT NULL,
    method text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    scheduled_for date,
    exported_file_ref text,
    exported_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    payment_bank_profile_id uuid,
    subsidiary_id uuid,
    source_schedule_id uuid,
    parent_payment_run_id uuid,
    direction text DEFAULT 'outbound'::text NOT NULL,
    purpose text DEFAULT 'vendor_payments'::text NOT NULL,
    currency text,
    selection_criteria jsonb DEFAULT '{}'::jsonb NOT NULL,
    payment_count integer DEFAULT 0 NOT NULL,
    total_amount numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    submitted_at timestamp with time zone,
    submitted_by uuid,
    approved_at timestamp with time zone,
    approved_by uuid,
    rejected_at timestamp with time zone,
    rejected_by uuid,
    rejection_reason text,
    settled_at timestamp with time zone
);

ALTER TABLE ONLY public.payment_runs FORCE ROW LEVEL SECURITY;


--
-- Name: payment_schedules; Type: TABLE; Schema: public
--
--
-- Name: payment_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    payment_bank_profile_id uuid NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    selection_criteria jsonb DEFAULT '{}'::jsonb NOT NULL,
    action text DEFAULT 'create_draft'::text NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_payment_run_id uuid,
    last_result jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: payment_settlements; Type: TABLE; Schema: public
--
--
-- Name: payment_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_settlements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    payment_instruction_id uuid NOT NULL,
    bank_statement_line_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    effective_on date,
    bank_reference text,
    return_code text,
    return_reason text,
    reversal_document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    reversal_entry_id uuid
);

ALTER TABLE ONLY public.payment_settlements FORCE ROW LEVEL SECURITY;


--
-- Name: payment_terms; Type: TABLE; Schema: public
--
--
-- Name: payment_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_terms (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    net_days integer DEFAULT 30 NOT NULL,
    discount_days integer,
    discount_percent numeric(19,4),
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.payment_terms FORCE ROW LEVEL SECURITY;


--
-- Name: pdf_templates; Type: TABLE; Schema: public
--
--
-- Name: pdf_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pdf_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    record_type text NOT NULL,
    name text NOT NULL,
    description text,
    paper_size text DEFAULT 'letter'::text NOT NULL,
    orientation text DEFAULT 'portrait'::text NOT NULL,
    margin_mm integer DEFAULT 14 NOT NULL,
    header_html text,
    footer_html text,
    source_html text DEFAULT ''::text NOT NULL,
    compiled_html text DEFAULT ''::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.pdf_templates FORCE ROW LEVEL SECURITY;


--
-- Name: performance_obligations; Type: TABLE; Schema: public
--
--
-- Name: performance_obligations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_obligations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    document_line_id uuid,
    item_id uuid,
    description text NOT NULL,
    recognition_rule_id uuid NOT NULL,
    booked_amount numeric(19,4),
    standalone_selling_price numeric(19,4),
    allocated_price numeric(19,4) NOT NULL,
    percent_complete numeric(19,4),
    recognition_starts_on date,
    recognition_ends_on date,
    deferred_account_id uuid,
    recognized_account_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT obligations_status_check CHECK ((status = ANY (ARRAY['open'::text, 'satisfied'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.performance_obligations FORCE ROW LEVEL SECURITY;


--
-- Name: period_locks; Type: TABLE; Schema: public
--
--
-- Name: period_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.period_locks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    period_id uuid NOT NULL,
    book_id uuid NOT NULL,
    subsidiary_id uuid,
    module text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    locked_at timestamp with time zone,
    locked_by uuid,
    reason text,
    reopen_expires_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT period_locks_module_check CHECK ((module = ANY (ARRAY['ar'::text, 'ap'::text, 'banking'::text, 'assets'::text, 'tax'::text, 'gl'::text]))),
    CONSTRAINT period_locks_state_check CHECK ((state = ANY (ARRAY['open'::text, 'soft_closed'::text, 'closed'::text])))
);

ALTER TABLE ONLY public.period_locks FORCE ROW LEVEL SECURITY;


--
-- Name: project_tasks; Type: TABLE; Schema: public
--
--
-- Name: project_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_tasks (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    project_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    estimated_hours numeric(19,4),
    estimated_cost numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.project_tasks FORCE ROW LEVEL SECURITY;


--
-- Name: projects; Type: TABLE; Schema: public
--
--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    customer_id uuid,
    foreman_id uuid,
    manager_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    billing_method text,
    customer_po_number text,
    starts_on date,
    ends_on date,
    notes text,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.projects FORCE ROW LEVEL SECURITY;


--
-- Name: recognition_rules; Type: TABLE; Schema: public
--
--
-- Name: recognition_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recognition_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    method text NOT NULL,
    is_forecast boolean DEFAULT false NOT NULL,
    recognition_periods integer,
    start_date_source text DEFAULT 'obligation'::text NOT NULL,
    end_date_source text DEFAULT 'term'::text NOT NULL,
    period_offset integer DEFAULT 0 NOT NULL,
    start_offset_days integer DEFAULT 0 NOT NULL,
    initial_amount_percent numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    deferred_account_id uuid,
    recognized_account_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT recognition_rules_end_src_check CHECK ((end_date_source = ANY (ARRAY['term'::text, 'obligation'::text, 'contract'::text]))),
    CONSTRAINT recognition_rules_method_check CHECK ((method = ANY (ARRAY['point_in_time'::text, 'straight_line_even'::text, 'straight_line_prorate_first_last'::text, 'straight_line_daily'::text, 'percent_complete'::text, 'milestone'::text, 'usage'::text]))),
    CONSTRAINT recognition_rules_start_src_check CHECK ((start_date_source = ANY (ARRAY['obligation'::text, 'document'::text, 'fulfillment'::text, 'event'::text, 'contract'::text])))
);

ALTER TABLE ONLY public.recognition_rules FORCE ROW LEVEL SECURITY;


--
-- Name: recognition_schedule_lines; Type: TABLE; Schema: public
--
--
-- Name: recognition_schedule_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recognition_schedule_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    period_id uuid NOT NULL,
    sequence integer NOT NULL,
    planned_amount numeric(19,4) NOT NULL,
    recognized_amount numeric(19,4),
    journal_entry_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.recognition_schedule_lines FORCE ROW LEVEL SECURITY;


--
-- Name: recognition_schedules; Type: TABLE; Schema: public
--
--
-- Name: recognition_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recognition_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    obligation_id uuid NOT NULL,
    book_id uuid NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    total_amount numeric(19,4) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT rec_schedules_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'complete'::text])))
);

ALTER TABLE ONLY public.recognition_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliation_matches; Type: TABLE; Schema: public
--
--
-- Name: reconciliation_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_matches (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    reconciliation_id uuid,
    statement_line_id uuid NOT NULL,
    journal_line_id uuid NOT NULL,
    matched_by text NOT NULL,
    confidence numeric(19,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.reconciliation_matches FORCE ROW LEVEL SECURITY;


--
-- Name: reconciliations; Type: TABLE; Schema: public
--
--
-- Name: reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    account_id uuid NOT NULL,
    through_date date NOT NULL,
    statement_balance numeric(19,4) NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    signed_off_by uuid,
    signed_off_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.reconciliations FORCE ROW LEVEL SECURITY;


--
-- Name: recurring_schedules; Type: TABLE; Schema: public
--
--
-- Name: recurring_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    template_document_id uuid NOT NULL,
    cadence text NOT NULL,
    cron text,
    next_run_on date NOT NULL,
    ends_on date,
    auto_post boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.recurring_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: report_definitions; Type: TABLE; Schema: public
--
--
-- Name: report_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_definitions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    kind text DEFAULT 'custom'::text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    query jsonb,
    layout jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    report_type text DEFAULT 'query'::text NOT NULL,
    statement jsonb,
    system boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.report_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: report_runs; Type: TABLE; Schema: public
--
--
-- Name: report_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid,
    definition_id uuid NOT NULL,
    trigger text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error text,
    row_count integer,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    result_csv text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.report_runs FORCE ROW LEVEL SECURITY;


--
-- Name: report_schedules; Type: TABLE; Schema: public
--
--
-- Name: report_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    cadence text NOT NULL,
    day_of_week integer,
    day_of_month integer,
    hour integer DEFAULT 7 NOT NULL,
    minute integer DEFAULT 0 NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    recipient_emails jsonb DEFAULT '[]'::jsonb NOT NULL,
    filters jsonb,
    next_run_at timestamp with time zone NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.report_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: revenue_contracts; Type: TABLE; Schema: public
--
--
-- Name: revenue_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenue_contracts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    contract_number text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    starts_on date,
    ends_on date,
    total_transaction_price numeric(19,4) DEFAULT '0'::numeric NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    currency text
);

ALTER TABLE ONLY public.revenue_contracts FORCE ROW LEVEL SECURITY;


--
-- Name: role_assignments; Type: TABLE; Schema: public
--
--
-- Name: role_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_assignments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.role_assignments FORCE ROW LEVEL SECURITY;


--
-- Name: role_dashboard_layouts; Type: TABLE; Schema: public
--
--
-- Name: role_dashboard_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_dashboard_layouts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    role_key text NOT NULL,
    layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.role_dashboard_layouts FORCE ROW LEVEL SECURITY;


--
-- Name: sandboxes; Type: TABLE; Schema: public
--
--
-- Name: sandboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandboxes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    production_org_id uuid NOT NULL,
    name text NOT NULL,
    tier text DEFAULT 'masked'::text NOT NULL,
    masked boolean DEFAULT true NOT NULL,
    as_of_period_id uuid,
    status text DEFAULT 'provisioning'::text NOT NULL,
    last_error text,
    last_refresh_at timestamp with time zone,
    refresh_schedule text,
    refresh_keep_customizations boolean DEFAULT true NOT NULL,
    storage_rows integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.sandboxes FORCE ROW LEVEL SECURITY;


--
-- Name: saved_reports; Type: TABLE; Schema: public
--
--
-- Name: saved_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_reports (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.saved_reports FORCE ROW LEVEL SECURITY;


--
-- Name: saved_views; Type: TABLE; Schema: public
--
--
-- Name: saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_views (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    query jsonb NOT NULL,
    layout jsonb,
    scope text DEFAULT 'private'::text NOT NULL,
    owner_id uuid NOT NULL,
    allowed_roles jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.saved_views FORCE ROW LEVEL SECURITY;


--
-- Name: script_runs; Type: TABLE; Schema: public
--
--
-- Name: script_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    script_id uuid NOT NULL,
    target_kind text,
    target_id uuid,
    status text NOT NULL,
    logs jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_message text,
    duration_ms integer,
    at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.script_runs FORCE ROW LEVEL SECURITY;


--
-- Name: segment_definitions; Type: TABLE; Schema: public
--
--
-- Name: segment_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_definitions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    plural_name text NOT NULL,
    source_kind text DEFAULT 'custom'::text NOT NULL,
    storage_column text,
    is_hierarchical boolean DEFAULT false NOT NULL,
    show_on_header boolean DEFAULT true NOT NULL,
    show_on_lines boolean DEFAULT true NOT NULL,
    show_in_reports boolean DEFAULT true NOT NULL,
    allow_account_requirement boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT segment_definition_key_format CHECK ((key ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT segment_definition_source CHECK ((((source_kind = 'custom'::text) AND (storage_column IS NULL)) OR ((source_kind = 'builtin'::text) AND (storage_column = ANY (ARRAY['subsidiary_id'::text, 'department_id'::text, 'project_id'::text, 'location_id'::text, 'class_id'::text])))))
);

ALTER TABLE ONLY public.segment_definitions FORCE ROW LEVEL SECURITY;


--
-- Name: segment_values; Type: TABLE; Schema: public
--
--
-- Name: segment_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.segment_values (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    segment_id uuid NOT NULL,
    parent_id uuid,
    code text,
    name text NOT NULL,
    description text,
    subsidiary_id uuid,
    subsidiary_include_children boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.segment_values FORCE ROW LEVEL SECURITY;


--
-- Name: serials; Type: TABLE; Schema: public
--
--
-- Name: serials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.serials (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    serial_number text NOT NULL,
    status text DEFAULT 'in_stock'::text NOT NULL,
    current_stock_location_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.serials FORCE ROW LEVEL SECURITY;


--
-- Name: sftp_daemon; Type: TABLE; Schema: public
--
--
-- Name: sftp_daemon; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sftp_daemon (
    id text DEFAULT 'default'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    port integer DEFAULT 2222 NOT NULL,
    host_key text NOT NULL,
    advertised_host text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: sftp_import_schedules; Type: TABLE; Schema: public
--
--
-- Name: sftp_import_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sftp_import_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    sftp_server_id uuid NOT NULL,
    account_id uuid NOT NULL,
    format text DEFAULT 'auto'::text NOT NULL,
    folder text DEFAULT 'inbound'::text NOT NULL,
    csv_mapping jsonb,
    is_active boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    last_result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.sftp_import_schedules FORCE ROW LEVEL SECURITY;


--
-- Name: sftp_servers; Type: TABLE; Schema: public
--
--
-- Name: sftp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sftp_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    username text NOT NULL,
    password_encrypted text,
    authorized_keys text,
    backend text DEFAULT 's3'::text NOT NULL,
    bucket text,
    root_prefix text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.sftp_servers FORCE ROW LEVEL SECURITY;


--
-- Name: statement_layouts; Type: TABLE; Schema: public
--
--
-- Name: statement_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statement_layouts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    statement text NOT NULL,
    rows jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.statement_layouts FORCE ROW LEVEL SECURITY;


--
-- Name: stock_count_lines; Type: TABLE; Schema: public
--
--
-- Name: stock_count_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_count_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    stock_count_id uuid NOT NULL,
    item_id uuid NOT NULL,
    stock_location_id uuid NOT NULL,
    lot_id uuid,
    expected_quantity numeric(19,4) NOT NULL,
    counted_quantity numeric(19,4),
    adjustment_movement_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.stock_count_lines FORCE ROW LEVEL SECURITY;


--
-- Name: stock_counts; Type: TABLE; Schema: public
--
--
-- Name: stock_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_counts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    location_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    counted_on date NOT NULL,
    posted_entry_id uuid,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.stock_counts FORCE ROW LEVEL SECURITY;


--
-- Name: stock_locations; Type: TABLE; Schema: public
--
--
-- Name: stock_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_locations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    location_id uuid NOT NULL,
    parent_id uuid,
    code text NOT NULL,
    kind text DEFAULT 'bin'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.stock_locations FORCE ROW LEVEL SECURITY;


--
-- Name: subsidiaries; Type: TABLE; Schema: public
--
--
-- Name: subsidiaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subsidiaries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    legal_name text,
    base_currency text NOT NULL,
    country text NOT NULL,
    tax_ids jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_elimination boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.subsidiaries FORCE ROW LEVEL SECURITY;


--
-- Name: sync_runs; Type: TABLE; Schema: public
--
--
-- Name: sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_runs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    source text NOT NULL,
    kind text DEFAULT 'incremental'::text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    synced_through timestamp with time zone,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_message text,
    triggered_by text,
    connection_id uuid
);

ALTER TABLE ONLY public.sync_runs FORCE ROW LEVEL SECURITY;


--
-- Name: tax_codes; Type: TABLE; Schema: public
--
--
-- Name: tax_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_codes (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    country text,
    region text,
    applies_to text DEFAULT 'both'::text NOT NULL,
    collected_account_id uuid,
    paid_account_id uuid,
    recoverable_percent numeric(19,4) DEFAULT '100'::numeric NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.tax_codes FORCE ROW LEVEL SECURITY;


--
-- Name: tax_depreciation_pools; Type: TABLE; Schema: public
--
--
-- Name: tax_depreciation_pools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_depreciation_pools (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    book_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    regime text NOT NULL,
    class_code text NOT NULL,
    rate numeric(19,10) NOT NULL,
    method text DEFAULT 'declining'::text NOT NULL,
    is_separate_class boolean DEFAULT false NOT NULL,
    opening_balance numeric(19,4) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT tax_pools_method_check CHECK ((method = ANY (ARRAY['declining'::text, 'straight_line'::text])))
);

ALTER TABLE ONLY public.tax_depreciation_pools FORCE ROW LEVEL SECURITY;


--
-- Name: tax_filings; Type: TABLE; Schema: public
--
--
-- Name: tax_filings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_filings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    form_code text NOT NULL,
    form_name text NOT NULL,
    country text,
    period_from date NOT NULL,
    period_to date NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    submission_channel text NOT NULL,
    boxes jsonb NOT NULL,
    adjustments jsonb DEFAULT '{}'::jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    filing_reference text,
    filed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT tax_filings_boxes_check CHECK ((jsonb_typeof(boxes) = 'array'::text)),
    CONSTRAINT tax_filings_dates_check CHECK ((period_from <= period_to)),
    CONSTRAINT tax_filings_filed_state_check CHECK ((((status = 'prepared'::text) AND (filed_at IS NULL)) OR ((status = 'filed'::text) AND (filed_at IS NOT NULL)))),
    CONSTRAINT tax_filings_snapshot_hash_check CHECK ((snapshot_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tax_filings_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'filed'::text]))),
    CONSTRAINT tax_filings_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY public.tax_filings FORCE ROW LEVEL SECURITY;


--
-- Name: tax_first_year_rules; Type: TABLE; Schema: public
--
--
-- Name: tax_first_year_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_first_year_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    regime text NOT NULL,
    class_code text,
    acquired_from date,
    acquired_to date,
    first_year_fraction numeric(19,10) DEFAULT 1 NOT NULL,
    enhanced_multiplier numeric(19,10),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.tax_first_year_rules FORCE ROW LEVEL SECURITY;


--
-- Name: tax_group_members; Type: TABLE; Schema: public
--
--
-- Name: tax_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_group_members (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    tax_group_id uuid NOT NULL,
    tax_code_id uuid NOT NULL,
    sequence integer DEFAULT 1 NOT NULL
);


--
-- Name: tax_groups; Type: TABLE; Schema: public
--
--
-- Name: tax_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_groups (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.tax_groups FORCE ROW LEVEL SECURITY;


--
-- Name: tax_pool_periods; Type: TABLE; Schema: public
--
--
-- Name: tax_pool_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_pool_periods (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    pool_id uuid NOT NULL,
    tax_year integer NOT NULL,
    opening_balance numeric(19,4) NOT NULL,
    additions numeric(19,4) DEFAULT 0 NOT NULL,
    dispositions numeric(19,4) DEFAULT 0 NOT NULL,
    net_additions numeric(19,4) DEFAULT 0 NOT NULL,
    immediate_expense numeric(19,4) DEFAULT 0 NOT NULL,
    base numeric(19,4) DEFAULT 0 NOT NULL,
    allowance numeric(19,4) DEFAULT 0 NOT NULL,
    closing_balance numeric(19,4) DEFAULT 0 NOT NULL,
    recapture numeric(19,4) DEFAULT 0 NOT NULL,
    terminal_loss numeric(19,4) DEFAULT 0 NOT NULL,
    short_year_factor numeric(19,10) DEFAULT 1 NOT NULL,
    enhanced_multiplier numeric(19,10),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.tax_pool_periods FORCE ROW LEVEL SECURITY;


--
-- Name: tax_rates; Type: TABLE; Schema: public
--
--
-- Name: tax_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_rates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    tax_code_id uuid NOT NULL,
    rate_percent numeric(19,4) NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.tax_rates FORCE ROW LEVEL SECURITY;


--
-- Name: tax_report_lines; Type: TABLE; Schema: public
--
--
-- Name: tax_report_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_report_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    report_code text NOT NULL,
    line_code text NOT NULL,
    label text NOT NULL,
    tax_code_id uuid,
    basis text,
    sign integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    sequence integer DEFAULT 0 NOT NULL,
    formula text,
    pdf_field text
);

ALTER TABLE ONLY public.tax_report_lines FORCE ROW LEVEL SECURITY;


--
-- Name: tax_return_forms; Type: TABLE; Schema: public
--
--
-- Name: tax_return_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_return_forms (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    country text,
    region text,
    submission_channel text DEFAULT 'portal_manual'::text NOT NULL,
    watermark text,
    official_pdf_file_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    government_format text DEFAULT 'portal_entry'::text NOT NULL,
    submission_url text,
    CONSTRAINT tax_return_forms_channel_check CHECK ((submission_channel = ANY (ARRAY['print_pdf'::text, 'file_upload'::text, 'efile_api'::text, 'portal_manual'::text]))),
    CONSTRAINT tax_return_forms_government_format_check CHECK ((government_format = ANY (ARRAY['portal_entry'::text, 'certified_file'::text, 'api'::text, 'paper'::text])))
);

ALTER TABLE ONLY public.tax_return_forms FORCE ROW LEVEL SECURITY;


--
-- Name: time_entries; Type: TABLE; Schema: public
--
--
-- Name: time_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_entries (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    worked_on date NOT NULL,
    hours numeric(19,4) NOT NULL,
    time_type_id uuid,
    item_id uuid,
    project_id uuid,
    project_task_id uuid,
    department_id uuid,
    memo text,
    memo_is_private boolean DEFAULT false NOT NULL,
    is_billable boolean DEFAULT false NOT NULL,
    cost_rate numeric(19,4),
    bill_rate numeric(19,4),
    status text DEFAULT 'draft'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    cost_journal_entry_id uuid,
    invoiced_by_line_id uuid,
    payroll_batch_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.time_entries FORCE ROW LEVEL SECURITY;


--
-- Name: time_types; Type: TABLE; Schema: public
--
--
-- Name: time_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_types (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    cost_multiplier numeric(19,4) DEFAULT '1'::numeric NOT NULL,
    is_billable_default boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

ALTER TABLE ONLY public.time_types FORCE ROW LEVEL SECURITY;


--
-- Name: trades; Type: TABLE; Schema: public
--
--
-- Name: trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.trades FORCE ROW LEVEL SECURITY;


--
-- Name: user_dashboard_layouts; Type: TABLE; Schema: public
--
--
-- Name: user_dashboard_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_dashboard_layouts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_role text NOT NULL,
    is_customised boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.user_dashboard_layouts FORCE ROW LEVEL SECURITY;


--
-- Name: user_form_preferences; Type: TABLE; Schema: public
--
--
-- Name: user_form_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_form_preferences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    record_type text NOT NULL,
    layout_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.user_form_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: user_list_preferences; Type: TABLE; Schema: public
--
--
-- Name: user_list_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_list_preferences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    record_type text NOT NULL,
    view_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.user_list_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: user_org_access; Type: TABLE; Schema: public
--
--
-- Name: user_org_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_org_access (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    member_user_id uuid NOT NULL,
    org_id uuid NOT NULL,
    acting_user_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: user_permission_overrides; Type: TABLE; Schema: public
--
--
-- Name: user_permission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permission_overrides (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    permission text NOT NULL,
    effect text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.user_permission_overrides FORCE ROW LEVEL SECURITY;


--
-- Name: user_scripts; Type: TABLE; Schema: public
--
--
-- Name: user_scripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_scripts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    trigger_point text NOT NULL,
    document_kind text,
    source text NOT NULL,
    cron text,
    timeout_ms integer DEFAULT 2000 NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    endpoint_slug text
);

ALTER TABLE ONLY public.user_scripts FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public
--
--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password_hash text NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    party_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    locale text,
    home_dashboard_id uuid,
    nav_mode text,
    is_super_admin boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


--
-- Name: vendor_roles; Type: TABLE; Schema: public
--
--
-- Name: vendor_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vendor_roles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    party_id uuid NOT NULL,
    ap_account_id uuid,
    payment_terms_id uuid,
    default_expense_account_id uuid,
    payment_method text,
    eft_notification_email text,
    currency text,
    tax_code_id uuid,
    is_t4a boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.vendor_roles FORCE ROW LEVEL SECURITY;


--
-- Name: worker_comp_groups; Type: TABLE; Schema: public
--
--
-- Name: worker_comp_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_comp_groups (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    rate_percent numeric(19,4),
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.worker_comp_groups FORCE ROW LEVEL SECURITY;


--
-- Name: account_group_members account_group_members_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: account_group_members account_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_group_members
    ADD CONSTRAINT account_group_members_pkey PRIMARY KEY (id);


--
-- Name: account_groups account_groups_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: account_groups account_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_groups
    ADD CONSTRAINT account_groups_pkey PRIMARY KEY (id);


--
-- Name: accounting_books accounting_books_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: accounting_books accounting_books_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_books
    ADD CONSTRAINT accounting_books_pkey PRIMARY KEY (id);


--
-- Name: accounting_periods accounting_periods_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: accounting_periods accounting_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: addresses addresses_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: addresses addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.addresses
    ADD CONSTRAINT addresses_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_policies ai_agent_policies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_agent_policies ai_agent_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_policies
    ADD CONSTRAINT ai_agent_policies_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_runs ai_agent_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_agent_runs ai_agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_runs
    ADD CONSTRAINT ai_agent_runs_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_work_item_evidence ai_work_item_evidence_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_work_item_evidence ai_work_item_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_work_item_evidence
    ADD CONSTRAINT ai_work_item_evidence_pkey PRIMARY KEY (id);


--
-- Name: ai_work_item_feedback ai_work_item_feedback_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_work_item_feedback ai_work_item_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_work_item_feedback
    ADD CONSTRAINT ai_work_item_feedback_pkey PRIMARY KEY (id);


--
-- Name: ai_work_items ai_work_items_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ai_work_items ai_work_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_work_items
    ADD CONSTRAINT ai_work_items_pkey PRIMARY KEY (id);


--
-- Name: allocation_rule_targets allocation_rule_targets_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: allocation_rule_targets allocation_rule_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allocation_rule_targets
    ADD CONSTRAINT allocation_rule_targets_pkey PRIMARY KEY (id);


--
-- Name: allocation_rules allocation_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: allocation_rules allocation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allocation_rules
    ADD CONSTRAINT allocation_rules_pkey PRIMARY KEY (id);


--
-- Name: allocation_runs allocation_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: allocation_runs allocation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allocation_runs
    ADD CONSTRAINT allocation_runs_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_corrections ap_capture_corrections_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_corrections ap_capture_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_corrections
    ADD CONSTRAINT ap_capture_corrections_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_events ap_capture_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_events ap_capture_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_events
    ADD CONSTRAINT ap_capture_events_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_fields ap_capture_fields_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_fields ap_capture_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_fields
    ADD CONSTRAINT ap_capture_fields_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_items ap_capture_items_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_items ap_capture_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_items
    ADD CONSTRAINT ap_capture_items_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_rules ap_capture_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_rules ap_capture_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_rules
    ADD CONSTRAINT ap_capture_rules_pkey PRIMARY KEY (id);


--
-- Name: ap_capture_runs ap_capture_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: ap_capture_runs ap_capture_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_capture_runs
    ADD CONSTRAINT ap_capture_runs_pkey PRIMARY KEY (id);


--
-- Name: api_key_events api_key_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: api_key_events api_key_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_key_events
    ADD CONSTRAINT api_key_events_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_files app_files_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_files app_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_files
    ADD CONSTRAINT app_files_pkey PRIMARY KEY (id);


--
-- Name: app_listings app_listings_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_listings app_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_listings
    ADD CONSTRAINT app_listings_pkey PRIMARY KEY (id);


--
-- Name: app_roles app_roles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_roles app_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_roles
    ADD CONSTRAINT app_roles_pkey PRIMARY KEY (id);


--
-- Name: app_runs app_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_runs app_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_runs
    ADD CONSTRAINT app_runs_pkey PRIMARY KEY (id);


--
-- Name: app_storage app_storage_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_storage app_storage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_storage
    ADD CONSTRAINT app_storage_pkey PRIMARY KEY (id);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);


--
-- Name: approval_delegations approval_delegations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: approval_delegations approval_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_delegations
    ADD CONSTRAINT approval_delegations_pkey PRIMARY KEY (id);


--
-- Name: approval_policies approval_policies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: approval_policies approval_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_policies
    ADD CONSTRAINT approval_policies_pkey PRIMARY KEY (id);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: approval_steps approval_steps_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: approval_steps approval_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_steps
    ADD CONSTRAINT approval_steps_pkey PRIMARY KEY (id);


--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: apps apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apps
    ADD CONSTRAINT apps_pkey PRIMARY KEY (id);


--
-- Name: asset_categories asset_categories_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: asset_categories asset_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_categories
    ADD CONSTRAINT asset_categories_pkey PRIMARY KEY (id);


--
-- Name: asset_events asset_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: asset_events asset_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_events
    ADD CONSTRAINT asset_events_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: bank_match_rules bank_match_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: bank_match_rules bank_match_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_match_rules
    ADD CONSTRAINT bank_match_rules_pkey PRIMARY KEY (id);


--
-- Name: bank_statement_lines bank_statement_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: bank_statement_lines bank_statement_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statement_lines
    ADD CONSTRAINT bank_statement_lines_pkey PRIMARY KEY (id);


--
-- Name: bank_statements bank_statements_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: bank_statements bank_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_statements
    ADD CONSTRAINT bank_statements_pkey PRIMARY KEY (id);


--
-- Name: billing_requests billing_requests_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: billing_requests billing_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_requests
    ADD CONSTRAINT billing_requests_pkey PRIMARY KEY (id);


--
-- Name: billing_schedules billing_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: billing_schedules billing_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_schedules
    ADD CONSTRAINT billing_schedules_pkey PRIMARY KEY (id);


--
-- Name: bom_components bom_components_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: bom_components bom_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bom_components
    ADD CONSTRAINT bom_components_pkey PRIMARY KEY (id);


--
-- Name: budget_lines budget_lines_cell; Type: CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_cell; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_cell UNIQUE NULLS NOT DISTINCT (scenario_id, account_id, period_id, department_id, project_id, location_id, class_id);


--
-- Name: budget_lines budget_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_pkey PRIMARY KEY (id);


--
-- Name: budget_scenarios budget_scenarios_identity; Type: CONSTRAINT; Schema: public
--
--
-- Name: budget_scenarios budget_scenarios_identity; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_scenarios
    ADD CONSTRAINT budget_scenarios_identity UNIQUE (org_id, book_id, fiscal_year, kind, name);


--
-- Name: budget_scenarios budget_scenarios_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: budget_scenarios budget_scenarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_scenarios
    ADD CONSTRAINT budget_scenarios_pkey PRIMARY KEY (id);


--
-- Name: change_set_items change_set_items_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: change_set_items change_set_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_set_items
    ADD CONSTRAINT change_set_items_pkey PRIMARY KEY (id);


--
-- Name: change_sets change_sets_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: change_sets change_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_sets
    ADD CONSTRAINT change_sets_pkey PRIMARY KEY (id);


--
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);


--
-- Name: close_automation_executions close_automation_executions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_automation_executions close_automation_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_executions
    ADD CONSTRAINT close_automation_executions_pkey PRIMARY KEY (id);


--
-- Name: close_automation_rules close_automation_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_automation_rules close_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_rules
    ADD CONSTRAINT close_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_dependencies
    ADD CONSTRAINT close_blueprint_dependencies_pkey PRIMARY KEY (id);


--
-- Name: close_blueprint_steps close_blueprint_steps_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_steps close_blueprint_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_steps
    ADD CONSTRAINT close_blueprint_steps_pkey PRIMARY KEY (id);


--
-- Name: close_blueprints close_blueprints_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_blueprints close_blueprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprints
    ADD CONSTRAINT close_blueprints_pkey PRIMARY KEY (id);


--
-- Name: close_events close_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_events close_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_events
    ADD CONSTRAINT close_events_pkey PRIMARY KEY (id);


--
-- Name: close_exceptions close_exceptions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_exceptions close_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_exceptions
    ADD CONSTRAINT close_exceptions_pkey PRIMARY KEY (id);


--
-- Name: close_policies close_policies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_policies close_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_policies
    ADD CONSTRAINT close_policies_pkey PRIMARY KEY (id);


--
-- Name: close_reopen_requests close_reopen_requests_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_pkey PRIMARY KEY (id);


--
-- Name: close_reporting_packages close_reporting_packages_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_reporting_packages close_reporting_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reporting_packages
    ADD CONSTRAINT close_reporting_packages_pkey PRIMARY KEY (id);


--
-- Name: close_run_tasks close_run_tasks_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_pkey PRIMARY KEY (id);


--
-- Name: close_runs close_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_pkey PRIMARY KEY (id);


--
-- Name: close_signoffs close_signoffs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_signoffs close_signoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_signoffs
    ADD CONSTRAINT close_signoffs_pkey PRIMARY KEY (id);


--
-- Name: close_task_evidence close_task_evidence_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: close_task_evidence close_task_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_task_evidence
    ADD CONSTRAINT close_task_evidence_pkey PRIMARY KEY (id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: consolidated_fx_rates consolidated_fx_rates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: consolidated_fx_rates consolidated_fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidated_fx_rates
    ADD CONSTRAINT consolidated_fx_rates_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: cost_layer_consumptions cost_layer_consumptions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: cost_layer_consumptions cost_layer_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layer_consumptions
    ADD CONSTRAINT cost_layer_consumptions_pkey PRIMARY KEY (id);


--
-- Name: cost_layers cost_layers_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: cost_layers cost_layers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_layers
    ADD CONSTRAINT cost_layers_pkey PRIMARY KEY (id);


--
-- Name: crm_account_assignment_events crm_account_assignment_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_account_assignment_events crm_account_assignment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_assignment_events
    ADD CONSTRAINT crm_account_assignment_events_pkey PRIMARY KEY (id);


--
-- Name: crm_account_profiles crm_account_profiles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_pkey PRIMARY KEY (id);


--
-- Name: crm_account_stage_events crm_account_stage_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_account_stage_events crm_account_stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_stage_events
    ADD CONSTRAINT crm_account_stage_events_pkey PRIMARY KEY (id);


--
-- Name: crm_account_statuses crm_account_statuses_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_account_statuses crm_account_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_statuses
    ADD CONSTRAINT crm_account_statuses_pkey PRIMARY KEY (id);


--
-- Name: crm_activities crm_activities_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_activities crm_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_pkey PRIMARY KEY (id);


--
-- Name: crm_activity_links crm_activity_links_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_links crm_activity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_links
    ADD CONSTRAINT crm_activity_links_pkey PRIMARY KEY (id);


--
-- Name: crm_activity_participants crm_activity_participants_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_participants
    ADD CONSTRAINT crm_activity_participants_pkey PRIMARY KEY (id);


--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_forecast_snapshots
    ADD CONSTRAINT crm_forecast_snapshots_pkey PRIMARY KEY (id);


--
-- Name: crm_lead_sources crm_lead_sources_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_lead_sources crm_lead_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_sources
    ADD CONSTRAINT crm_lead_sources_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunities crm_opportunities_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunity_documents crm_opportunity_documents_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_documents crm_opportunity_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_documents
    ADD CONSTRAINT crm_opportunity_documents_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunity_lines crm_opportunity_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_lines crm_opportunity_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_lines
    ADD CONSTRAINT crm_opportunity_lines_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_stage_events
    ADD CONSTRAINT crm_opportunity_stage_events_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_statuses
    ADD CONSTRAINT crm_opportunity_statuses_pkey PRIMARY KEY (id);


--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_team_members
    ADD CONSTRAINT crm_opportunity_team_members_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_quotas crm_sales_quotas_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_quotas crm_sales_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_quotas
    ADD CONSTRAINT crm_sales_quotas_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_team_members crm_sales_team_members_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_team_members crm_sales_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_team_members
    ADD CONSTRAINT crm_sales_team_members_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_teams crm_sales_teams_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_teams crm_sales_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_teams
    ADD CONSTRAINT crm_sales_teams_pkey PRIMARY KEY (id);


--
-- Name: crm_sales_territories crm_sales_territories_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_territories
    ADD CONSTRAINT crm_sales_territories_pkey PRIMARY KEY (id);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (code);


--
-- Name: custom_field_defs custom_field_defs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: custom_field_defs custom_field_defs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_defs
    ADD CONSTRAINT custom_field_defs_pkey PRIMARY KEY (id);


--
-- Name: custom_record_types custom_record_types_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: custom_record_types custom_record_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_record_types
    ADD CONSTRAINT custom_record_types_pkey PRIMARY KEY (id);


--
-- Name: custom_records custom_records_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: custom_records custom_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_records
    ADD CONSTRAINT custom_records_pkey PRIMARY KEY (id);


--
-- Name: customer_roles customer_roles_party_id_unique; Type: CONSTRAINT; Schema: public
--
--
-- Name: customer_roles customer_roles_party_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_roles
    ADD CONSTRAINT customer_roles_party_id_unique UNIQUE (party_id);


--
-- Name: customer_roles customer_roles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: customer_roles customer_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_roles
    ADD CONSTRAINT customer_roles_pkey PRIMARY KEY (id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: depreciation_book_policies depreciation_book_policies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: depreciation_book_policies depreciation_book_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_book_policies
    ADD CONSTRAINT depreciation_book_policies_pkey PRIMARY KEY (id);


--
-- Name: depreciation_methods depreciation_methods_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: depreciation_methods depreciation_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_methods
    ADD CONSTRAINT depreciation_methods_pkey PRIMARY KEY (id);


--
-- Name: depreciation_schedule_lines depreciation_schedule_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: depreciation_schedule_lines depreciation_schedule_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_schedule_lines
    ADD CONSTRAINT depreciation_schedule_lines_pkey PRIMARY KEY (id);


--
-- Name: depreciation_schedules depreciation_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: depreciation_schedules depreciation_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_schedules
    ADD CONSTRAINT depreciation_schedules_pkey PRIMARY KEY (id);


--
-- Name: document_lines document_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: document_lines document_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_lines
    ADD CONSTRAINT document_lines_pkey PRIMARY KEY (id);


--
-- Name: document_links document_links_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: document_links document_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_links
    ADD CONSTRAINT document_links_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: employee_roles employee_roles_party_id_unique; Type: CONSTRAINT; Schema: public
--
--
-- Name: employee_roles employee_roles_party_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_roles
    ADD CONSTRAINT employee_roles_party_id_unique UNIQUE (party_id);


--
-- Name: employee_roles employee_roles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: employee_roles employee_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_roles
    ADD CONSTRAINT employee_roles_pkey PRIMARY KEY (id);


--
-- Name: fair_value_prices fair_value_prices_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fair_value_prices fair_value_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fair_value_prices
    ADD CONSTRAINT fair_value_prices_pkey PRIMARY KEY (id);


--
-- Name: file_attachments file_attachments_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: file_attachments file_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_attachments
    ADD CONSTRAINT file_attachments_pkey PRIMARY KEY (id);


--
-- Name: file_blobs file_blobs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: file_blobs file_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_blobs
    ADD CONSTRAINT file_blobs_pkey PRIMARY KEY (id);


--
-- Name: file_versions file_versions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: file_versions file_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_versions
    ADD CONSTRAINT file_versions_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: fiscal_calendars fiscal_calendars_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fiscal_calendars fiscal_calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_calendars
    ADD CONSTRAINT fiscal_calendars_pkey PRIMARY KEY (id);


--
-- Name: fixed_assets fixed_assets_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fixed_assets fixed_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fixed_assets
    ADD CONSTRAINT fixed_assets_pkey PRIMARY KEY (id);


--
-- Name: flow_gates flow_gates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: flow_gates flow_gates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_gates
    ADD CONSTRAINT flow_gates_pkey PRIMARY KEY (id);


--
-- Name: flow_locks flow_locks_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: flow_locks flow_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_locks
    ADD CONSTRAINT flow_locks_pkey PRIMARY KEY (id);


--
-- Name: flow_run_effects flow_run_effects_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: flow_run_effects flow_run_effects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_run_effects
    ADD CONSTRAINT flow_run_effects_pkey PRIMARY KEY (id);


--
-- Name: flow_runs flow_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: flow_runs flow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_runs
    ADD CONSTRAINT flow_runs_pkey PRIMARY KEY (id);


--
-- Name: flows flows_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: flows flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flows
    ADD CONSTRAINT flows_pkey PRIMARY KEY (id);


--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);


--
-- Name: form_layouts form_layouts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: form_layouts form_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_layouts
    ADD CONSTRAINT form_layouts_pkey PRIMARY KEY (id);


--
-- Name: form_response_steps form_response_steps_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: form_response_steps form_response_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_response_steps
    ADD CONSTRAINT form_response_steps_pkey PRIMARY KEY (id);


--
-- Name: form_responses form_responses_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: form_responses form_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_responses
    ADD CONSTRAINT form_responses_pkey PRIMARY KEY (id);


--
-- Name: form_template_versions form_template_versions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: form_template_versions form_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_template_versions
    ADD CONSTRAINT form_template_versions_pkey PRIMARY KEY (id);


--
-- Name: form_templates form_templates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: form_templates form_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_templates
    ADD CONSTRAINT form_templates_pkey PRIMARY KEY (id);


--
-- Name: fx_provider_configs fx_provider_configs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fx_provider_configs fx_provider_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_provider_configs
    ADD CONSTRAINT fx_provider_configs_pkey PRIMARY KEY (id);


--
-- Name: fx_provider_runs fx_provider_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fx_provider_runs fx_provider_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_provider_runs
    ADD CONSTRAINT fx_provider_runs_pkey PRIMARY KEY (id);


--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: fx_rates fx_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);


--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: insight_cards insight_cards_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: insight_cards insight_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_cards
    ADD CONSTRAINT insight_cards_pkey PRIMARY KEY (id);


--
-- Name: insight_dashboard_pins insight_dashboard_pins_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: insight_dashboard_pins insight_dashboard_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_dashboard_pins
    ADD CONSTRAINT insight_dashboard_pins_pkey PRIMARY KEY (id);


--
-- Name: insight_dashboards insight_dashboards_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: insight_dashboards insight_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_dashboards
    ADD CONSTRAINT insight_dashboards_pkey PRIMARY KEY (id);


--
-- Name: intercompany_pairs intercompany_pairs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_pkey PRIMARY KEY (id);


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_movements
    ADD CONSTRAINT inventory_movements_pkey PRIMARY KEY (id);


--
-- Name: invoice_backups invoice_backups_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: invoice_backups invoice_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_backups
    ADD CONSTRAINT invoice_backups_pkey PRIMARY KEY (id);


--
-- Name: item_inventory_profiles item_inventory_profiles_item_id_unique; Type: CONSTRAINT; Schema: public
--
--
-- Name: item_inventory_profiles item_inventory_profiles_item_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_inventory_profiles
    ADD CONSTRAINT item_inventory_profiles_item_id_unique UNIQUE (item_id);


--
-- Name: item_inventory_profiles item_inventory_profiles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: item_inventory_profiles item_inventory_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_inventory_profiles
    ADD CONSTRAINT item_inventory_profiles_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: journal_entries journal_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);


--
-- Name: journal_lines journal_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: journal_lines journal_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_pkey PRIMARY KEY (id);


--
-- Name: labor_burden_rates labor_burden_rates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: labor_burden_rates labor_burden_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labor_burden_rates
    ADD CONSTRAINT labor_burden_rates_pkey PRIMARY KEY (id);


--
-- Name: landed_cost_allocations landed_cost_allocations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: landed_cost_allocations landed_cost_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landed_cost_allocations
    ADD CONSTRAINT landed_cost_allocations_pkey PRIMARY KEY (id);


--
-- Name: list_views list_views_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: list_views list_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.list_views
    ADD CONSTRAINT list_views_pkey PRIMARY KEY (id);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: lots lots_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: lots lots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lots
    ADD CONSTRAINT lots_pkey PRIMARY KEY (id);


--
-- Name: masking_policies masking_policies_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: masking_policies masking_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.masking_policies
    ADD CONSTRAINT masking_policies_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: number_sequences number_sequences_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: number_sequences number_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_sequences
    ADD CONSTRAINT number_sequences_pkey PRIMARY KEY (id);


--
-- Name: org_nav_configs org_nav_configs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: org_nav_configs org_nav_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_nav_configs
    ADD CONSTRAINT org_nav_configs_pkey PRIMARY KEY (id);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: parties parties_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: parties parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_pkey PRIMARY KEY (id);


--
-- Name: party_bank_accounts party_bank_accounts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: party_bank_accounts party_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_bank_accounts
    ADD CONSTRAINT party_bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: party_subsidiaries party_subsidiaries_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: party_subsidiaries party_subsidiaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_subsidiaries
    ADD CONSTRAINT party_subsidiaries_pkey PRIMARY KEY (id);


--
-- Name: payment_bank_profiles payment_bank_profiles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_bank_profiles payment_bank_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_bank_profiles
    ADD CONSTRAINT payment_bank_profiles_pkey PRIMARY KEY (id);


--
-- Name: payment_cards payment_cards_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_cards payment_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_cards
    ADD CONSTRAINT payment_cards_pkey PRIMARY KEY (id);


--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_events payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);


--
-- Name: payment_file_deliveries payment_file_deliveries_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_file_deliveries payment_file_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_file_deliveries
    ADD CONSTRAINT payment_file_deliveries_pkey PRIMARY KEY (id);


--
-- Name: payment_files payment_files_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_files payment_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_files
    ADD CONSTRAINT payment_files_pkey PRIMARY KEY (id);


--
-- Name: payment_formats payment_formats_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_formats payment_formats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_formats
    ADD CONSTRAINT payment_formats_pkey PRIMARY KEY (id);


--
-- Name: payment_instructions payment_instructions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_instructions payment_instructions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_instructions
    ADD CONSTRAINT payment_instructions_pkey PRIMARY KEY (id);


--
-- Name: payment_mandates payment_mandates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_mandates payment_mandates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_mandates
    ADD CONSTRAINT payment_mandates_pkey PRIMARY KEY (id);


--
-- Name: payment_remittances payment_remittances_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_remittances payment_remittances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_remittances
    ADD CONSTRAINT payment_remittances_pkey PRIMARY KEY (id);


--
-- Name: payment_run_items payment_run_items_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_run_items payment_run_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_run_items
    ADD CONSTRAINT payment_run_items_pkey PRIMARY KEY (id);


--
-- Name: payment_runs payment_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_runs payment_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_runs
    ADD CONSTRAINT payment_runs_pkey PRIMARY KEY (id);


--
-- Name: payment_schedules payment_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_schedules payment_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_schedules
    ADD CONSTRAINT payment_schedules_pkey PRIMARY KEY (id);


--
-- Name: payment_settlements payment_settlements_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_settlements payment_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_settlements
    ADD CONSTRAINT payment_settlements_pkey PRIMARY KEY (id);


--
-- Name: payment_terms payment_terms_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: payment_terms payment_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_terms
    ADD CONSTRAINT payment_terms_pkey PRIMARY KEY (id);


--
-- Name: pdf_templates pdf_templates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: pdf_templates pdf_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pdf_templates
    ADD CONSTRAINT pdf_templates_pkey PRIMARY KEY (id);


--
-- Name: performance_obligations performance_obligations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: performance_obligations performance_obligations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_obligations
    ADD CONSTRAINT performance_obligations_pkey PRIMARY KEY (id);


--
-- Name: period_locks period_locks_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_pkey PRIMARY KEY (id);


--
-- Name: project_tasks project_tasks_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: project_tasks project_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_tasks
    ADD CONSTRAINT project_tasks_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: recognition_rules recognition_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: recognition_rules recognition_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recognition_rules
    ADD CONSTRAINT recognition_rules_pkey PRIMARY KEY (id);


--
-- Name: recognition_schedule_lines recognition_schedule_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: recognition_schedule_lines recognition_schedule_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recognition_schedule_lines
    ADD CONSTRAINT recognition_schedule_lines_pkey PRIMARY KEY (id);


--
-- Name: recognition_schedules recognition_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: recognition_schedules recognition_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recognition_schedules
    ADD CONSTRAINT recognition_schedules_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_matches reconciliation_matches_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: reconciliation_matches reconciliation_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_matches
    ADD CONSTRAINT reconciliation_matches_pkey PRIMARY KEY (id);


--
-- Name: reconciliations reconciliations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: reconciliations reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliations
    ADD CONSTRAINT reconciliations_pkey PRIMARY KEY (id);


--
-- Name: recurring_schedules recurring_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: recurring_schedules recurring_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_schedules
    ADD CONSTRAINT recurring_schedules_pkey PRIMARY KEY (id);


--
-- Name: report_definitions report_definitions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: report_definitions report_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_definitions
    ADD CONSTRAINT report_definitions_pkey PRIMARY KEY (id);


--
-- Name: report_runs report_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: report_runs report_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_runs
    ADD CONSTRAINT report_runs_pkey PRIMARY KEY (id);


--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schedules
    ADD CONSTRAINT report_schedules_pkey PRIMARY KEY (id);


--
-- Name: revenue_contracts revenue_contracts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: revenue_contracts revenue_contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenue_contracts
    ADD CONSTRAINT revenue_contracts_pkey PRIMARY KEY (id);


--
-- Name: role_assignments role_assignments_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: role_assignments role_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (id);


--
-- Name: role_dashboard_layouts role_dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: role_dashboard_layouts role_dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_dashboard_layouts
    ADD CONSTRAINT role_dashboard_layouts_pkey PRIMARY KEY (id);


--
-- Name: sandboxes sandboxes_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: sandboxes sandboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandboxes
    ADD CONSTRAINT sandboxes_pkey PRIMARY KEY (id);


--
-- Name: saved_reports saved_reports_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: saved_reports saved_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_reports
    ADD CONSTRAINT saved_reports_pkey PRIMARY KEY (id);


--
-- Name: saved_views saved_views_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: saved_views saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_views
    ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id);


--
-- Name: script_runs script_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: script_runs script_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_runs
    ADD CONSTRAINT script_runs_pkey PRIMARY KEY (id);


--
-- Name: segment_definitions segment_definitions_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: segment_definitions segment_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_definitions
    ADD CONSTRAINT segment_definitions_pkey PRIMARY KEY (id);


--
-- Name: segment_values segment_values_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_pkey PRIMARY KEY (id);


--
-- Name: number_sequences sequences_org_kind_sub; Type: CONSTRAINT; Schema: public
--
--
-- Name: number_sequences sequences_org_kind_sub; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_sequences
    ADD CONSTRAINT sequences_org_kind_sub UNIQUE NULLS NOT DISTINCT (org_id, document_kind, subsidiary_id);


--
-- Name: serials serials_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: serials serials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.serials
    ADD CONSTRAINT serials_pkey PRIMARY KEY (id);


--
-- Name: sftp_daemon sftp_daemon_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: sftp_daemon sftp_daemon_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sftp_daemon
    ADD CONSTRAINT sftp_daemon_pkey PRIMARY KEY (id);


--
-- Name: sftp_import_schedules sftp_import_schedules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: sftp_import_schedules sftp_import_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sftp_import_schedules
    ADD CONSTRAINT sftp_import_schedules_pkey PRIMARY KEY (id);


--
-- Name: sftp_servers sftp_servers_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: sftp_servers sftp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sftp_servers
    ADD CONSTRAINT sftp_servers_pkey PRIMARY KEY (id);


--
-- Name: statement_layouts statement_layouts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: statement_layouts statement_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statement_layouts
    ADD CONSTRAINT statement_layouts_pkey PRIMARY KEY (id);


--
-- Name: stock_count_lines stock_count_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: stock_count_lines stock_count_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_count_lines
    ADD CONSTRAINT stock_count_lines_pkey PRIMARY KEY (id);


--
-- Name: stock_counts stock_counts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: stock_counts stock_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_counts
    ADD CONSTRAINT stock_counts_pkey PRIMARY KEY (id);


--
-- Name: stock_locations stock_locations_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: stock_locations stock_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_locations
    ADD CONSTRAINT stock_locations_pkey PRIMARY KEY (id);


--
-- Name: subsidiaries subsidiaries_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: subsidiaries subsidiaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subsidiaries
    ADD CONSTRAINT subsidiaries_pkey PRIMARY KEY (id);


--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: sync_runs sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);


--
-- Name: tax_codes tax_codes_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_codes tax_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_codes
    ADD CONSTRAINT tax_codes_pkey PRIMARY KEY (id);


--
-- Name: tax_depreciation_pools tax_depreciation_pools_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_depreciation_pools tax_depreciation_pools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_depreciation_pools
    ADD CONSTRAINT tax_depreciation_pools_pkey PRIMARY KEY (id);


--
-- Name: tax_filings tax_filings_period_version; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_filings tax_filings_period_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_filings
    ADD CONSTRAINT tax_filings_period_version UNIQUE (org_id, form_code, period_from, period_to, version);


--
-- Name: tax_filings tax_filings_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_filings tax_filings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_filings
    ADD CONSTRAINT tax_filings_pkey PRIMARY KEY (id);


--
-- Name: tax_first_year_rules tax_first_year_rules_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_first_year_rules tax_first_year_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_first_year_rules
    ADD CONSTRAINT tax_first_year_rules_pkey PRIMARY KEY (id);


--
-- Name: tax_group_members tax_group_members_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_group_members tax_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_group_members
    ADD CONSTRAINT tax_group_members_pkey PRIMARY KEY (id);


--
-- Name: tax_groups tax_groups_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_groups tax_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_groups
    ADD CONSTRAINT tax_groups_pkey PRIMARY KEY (id);


--
-- Name: tax_pool_periods tax_pool_periods_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_pool_periods tax_pool_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_pool_periods
    ADD CONSTRAINT tax_pool_periods_pkey PRIMARY KEY (id);


--
-- Name: tax_rates tax_rates_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_rates tax_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);


--
-- Name: tax_report_lines tax_report_lines_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_report_lines tax_report_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_report_lines
    ADD CONSTRAINT tax_report_lines_pkey PRIMARY KEY (id);


--
-- Name: tax_return_forms tax_return_forms_code_org; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_return_forms tax_return_forms_code_org; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_forms
    ADD CONSTRAINT tax_return_forms_code_org UNIQUE (org_id, code);


--
-- Name: tax_return_forms tax_return_forms_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: tax_return_forms tax_return_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_forms
    ADD CONSTRAINT tax_return_forms_pkey PRIMARY KEY (id);


--
-- Name: time_entries time_entries_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: time_entries time_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_entries
    ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);


--
-- Name: time_types time_types_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: time_types time_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_types
    ADD CONSTRAINT time_types_pkey PRIMARY KEY (id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: user_dashboard_layouts user_dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_dashboard_layouts user_dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_dashboard_layouts
    ADD CONSTRAINT user_dashboard_layouts_pkey PRIMARY KEY (id);


--
-- Name: user_form_preferences user_form_preferences_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_form_preferences user_form_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_form_preferences
    ADD CONSTRAINT user_form_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_list_preferences user_list_preferences_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_list_preferences user_list_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_list_preferences
    ADD CONSTRAINT user_list_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_org_access user_org_access_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_org_access user_org_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_org_access
    ADD CONSTRAINT user_org_access_pkey PRIMARY KEY (id);


--
-- Name: user_permission_overrides user_permission_overrides_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_permission_overrides user_permission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_pkey PRIMARY KEY (id);


--
-- Name: user_scripts user_scripts_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: user_scripts user_scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_scripts
    ADD CONSTRAINT user_scripts_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vendor_roles vendor_roles_party_id_unique; Type: CONSTRAINT; Schema: public
--
--
-- Name: vendor_roles vendor_roles_party_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_roles
    ADD CONSTRAINT vendor_roles_party_id_unique UNIQUE (party_id);


--
-- Name: vendor_roles vendor_roles_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: vendor_roles vendor_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vendor_roles
    ADD CONSTRAINT vendor_roles_pkey PRIMARY KEY (id);


--
-- Name: worker_comp_groups worker_comp_groups_pkey; Type: CONSTRAINT; Schema: public
--
--
-- Name: worker_comp_groups worker_comp_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_comp_groups
    ADD CONSTRAINT worker_comp_groups_pkey PRIMARY KEY (id);


--
-- Name: account_group_members_account; Type: INDEX; Schema: public
--
--
-- Name: account_group_members_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_group_members_account ON public.account_group_members USING btree (account_id);


--
-- Name: account_group_members_group_account; Type: INDEX; Schema: public
--
--
-- Name: account_group_members_group_account; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_group_members_group_account ON public.account_group_members USING btree (group_id, account_id);


--
-- Name: account_groups_org_dim; Type: INDEX; Schema: public
--
--
-- Name: account_groups_org_dim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_groups_org_dim ON public.account_groups USING btree (org_id, dimension);


--
-- Name: account_groups_org_dim_key; Type: INDEX; Schema: public
--
--
-- Name: account_groups_org_dim_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_groups_org_dim_key ON public.account_groups USING btree (org_id, dimension, key);


--
-- Name: accounts_org_number; Type: INDEX; Schema: public
--
--
-- Name: accounts_org_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_org_number ON public.accounts USING btree (org_id, number);


--
-- Name: accounts_org_type; Type: INDEX; Schema: public
--
--
-- Name: accounts_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_org_type ON public.accounts USING btree (org_id, type);


--
-- Name: accounts_parent; Type: INDEX; Schema: public
--
--
-- Name: accounts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_parent ON public.accounts USING btree (parent_id);


--
-- Name: addresses_party; Type: INDEX; Schema: public
--
--
-- Name: addresses_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX addresses_party ON public.addresses USING btree (party_id);


--
-- Name: ai_agent_policies_due; Type: INDEX; Schema: public
--
--
-- Name: ai_agent_policies_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agent_policies_due ON public.ai_agent_policies USING btree (enabled, automatic_runs, next_run_at);


--
-- Name: ai_agent_policies_org_agent; Type: INDEX; Schema: public
--
--
-- Name: ai_agent_policies_org_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_agent_policies_org_agent ON public.ai_agent_policies USING btree (org_id, agent_key);


--
-- Name: ai_agent_runs_org_started; Type: INDEX; Schema: public
--
--
-- Name: ai_agent_runs_org_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_agent_runs_org_started ON public.ai_agent_runs USING btree (org_id, started_at);


--
-- Name: ai_conversations_owner_scope; Type: INDEX; Schema: public
--
--
-- Name: ai_conversations_owner_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_owner_scope ON public.ai_conversations USING btree (org_id, user_id, scope, updated_at);


--
-- Name: ai_messages_conversation; Type: INDEX; Schema: public
--
--
-- Name: ai_messages_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_conversation ON public.ai_messages USING btree (conversation_id, created_at);


--
-- Name: ai_work_item_evidence_item; Type: INDEX; Schema: public
--
--
-- Name: ai_work_item_evidence_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_work_item_evidence_item ON public.ai_work_item_evidence USING btree (work_item_id, created_at);


--
-- Name: ai_work_item_feedback_org; Type: INDEX; Schema: public
--
--
-- Name: ai_work_item_feedback_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_work_item_feedback_org ON public.ai_work_item_feedback USING btree (org_id, created_at);


--
-- Name: ai_work_item_feedback_user; Type: INDEX; Schema: public
--
--
-- Name: ai_work_item_feedback_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_work_item_feedback_user ON public.ai_work_item_feedback USING btree (work_item_id, user_id);


--
-- Name: ai_work_items_agent_status; Type: INDEX; Schema: public
--
--
-- Name: ai_work_items_agent_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_work_items_agent_status ON public.ai_work_items USING btree (org_id, agent_key, status);


--
-- Name: ai_work_items_org_fingerprint; Type: INDEX; Schema: public
--
--
-- Name: ai_work_items_org_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_work_items_org_fingerprint ON public.ai_work_items USING btree (org_id, agent_key, fingerprint);


--
-- Name: ai_work_items_org_status_seen; Type: INDEX; Schema: public
--
--
-- Name: ai_work_items_org_status_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_work_items_org_status_seen ON public.ai_work_items USING btree (org_id, status, last_detected_at);


--
-- Name: alloc_runs_rule_period; Type: INDEX; Schema: public
--
--
-- Name: alloc_runs_rule_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alloc_runs_rule_period ON public.allocation_runs USING btree (rule_id, period_id);


--
-- Name: alloc_targets_rule; Type: INDEX; Schema: public
--
--
-- Name: alloc_targets_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alloc_targets_rule ON public.allocation_rule_targets USING btree (rule_id);


--
-- Name: ap_capture_corrections_item; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_corrections_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_corrections_item ON public.ap_capture_corrections USING btree (capture_item_id, corrected_at);


--
-- Name: ap_capture_events_item; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_events_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_events_item ON public.ap_capture_events USING btree (capture_item_id, at);


--
-- Name: ap_capture_fields_run; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_fields_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_fields_run ON public.ap_capture_fields USING btree (run_id, field_key, line_index);


--
-- Name: ap_capture_items_document; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_items_document; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ap_capture_items_document ON public.ap_capture_items USING btree (document_id) WHERE (document_id IS NOT NULL);


--
-- Name: ap_capture_items_hash; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_items_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_items_hash ON public.ap_capture_items USING btree (org_id, content_hash);


--
-- Name: ap_capture_items_queue; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_items_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_items_queue ON public.ap_capture_items USING btree (org_id, status, received_at);


--
-- Name: ap_capture_items_vendor; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_items_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_items_vendor ON public.ap_capture_items USING btree (org_id, vendor_candidate_id);


--
-- Name: ap_capture_rules_identity; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_rules_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ap_capture_rules_identity ON public.ap_capture_rules USING btree (org_id, rule_kind, match, output);


--
-- Name: ap_capture_rules_lookup; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_rules_lookup ON public.ap_capture_rules USING btree (org_id, rule_kind, is_active);


--
-- Name: ap_capture_runs_attempt; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_runs_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ap_capture_runs_attempt ON public.ap_capture_runs USING btree (capture_item_id, attempt);


--
-- Name: ap_capture_runs_org_started; Type: INDEX; Schema: public
--
--
-- Name: ap_capture_runs_org_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ap_capture_runs_org_started ON public.ap_capture_runs USING btree (org_id, started_at);


--
-- Name: api_key_events_key; Type: INDEX; Schema: public
--
--
-- Name: api_key_events_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_key_events_key ON public.api_key_events USING btree (key_id);


--
-- Name: api_key_events_org_created; Type: INDEX; Schema: public
--
--
-- Name: api_key_events_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_key_events_org_created ON public.api_key_events USING btree (org_id, created_at);


--
-- Name: api_keys_hash; Type: INDEX; Schema: public
--
--
-- Name: api_keys_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX api_keys_hash ON public.api_keys USING btree (key_hash);


--
-- Name: api_keys_org; Type: INDEX; Schema: public
--
--
-- Name: api_keys_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_org ON public.api_keys USING btree (org_id);


--
-- Name: api_keys_org_user; Type: INDEX; Schema: public
--
--
-- Name: api_keys_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_org_user ON public.api_keys USING btree (org_id, user_id);


--
-- Name: app_files_version_kind; Type: INDEX; Schema: public
--
--
-- Name: app_files_version_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_files_version_kind ON public.app_files USING btree (version_id, kind);


--
-- Name: app_files_version_path; Type: INDEX; Schema: public
--
--
-- Name: app_files_version_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_files_version_path ON public.app_files USING btree (version_id, path);


--
-- Name: app_from; Type: INDEX; Schema: public
--
--
-- Name: app_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_from ON public.applications USING btree (from_line_id);


--
-- Name: app_listings_key; Type: INDEX; Schema: public
--
--
-- Name: app_listings_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_listings_key ON public.app_listings USING btree (key);


--
-- Name: app_listings_publisher; Type: INDEX; Schema: public
--
--
-- Name: app_listings_publisher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_listings_publisher ON public.app_listings USING btree (publisher_org_id);


--
-- Name: app_roles_org; Type: INDEX; Schema: public
--
--
-- Name: app_roles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_roles_org ON public.app_roles USING btree (org_id);


--
-- Name: app_roles_org_key; Type: INDEX; Schema: public
--
--
-- Name: app_roles_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_roles_org_key ON public.app_roles USING btree (org_id, key);


--
-- Name: app_runs_app_at; Type: INDEX; Schema: public
--
--
-- Name: app_runs_app_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_runs_app_at ON public.app_runs USING btree (app_id, at);


--
-- Name: app_storage_org_app; Type: INDEX; Schema: public
--
--
-- Name: app_storage_org_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_storage_org_app ON public.app_storage USING btree (org_id, app_id);


--
-- Name: app_storage_scope_key; Type: INDEX; Schema: public
--
--
-- Name: app_storage_scope_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_storage_scope_key ON public.app_storage USING btree (app_id, namespace, key);


--
-- Name: app_to; Type: INDEX; Schema: public
--
--
-- Name: app_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_to ON public.applications USING btree (to_line_id);


--
-- Name: app_versions_app_version; Type: INDEX; Schema: public
--
--
-- Name: app_versions_app_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_versions_app_version ON public.app_versions USING btree (app_id, version);


--
-- Name: app_versions_org_app; Type: INDEX; Schema: public
--
--
-- Name: app_versions_org_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_versions_org_app ON public.app_versions USING btree (org_id, app_id);


--
-- Name: approval_delegations_from; Type: INDEX; Schema: public
--
--
-- Name: approval_delegations_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_delegations_from ON public.approval_delegations USING btree (org_id, from_user_id, ends_at);


--
-- Name: approval_delegations_to; Type: INDEX; Schema: public
--
--
-- Name: approval_delegations_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_delegations_to ON public.approval_delegations USING btree (org_id, to_user_id, ends_at);


--
-- Name: approval_requests_status; Type: INDEX; Schema: public
--
--
-- Name: approval_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_status ON public.approval_requests USING btree (org_id, status);


--
-- Name: approval_requests_target; Type: INDEX; Schema: public
--
--
-- Name: approval_requests_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_requests_target ON public.approval_requests USING btree (target_kind, target_id);


--
-- Name: approval_steps_request; Type: INDEX; Schema: public
--
--
-- Name: approval_steps_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_steps_request ON public.approval_steps USING btree (request_id);


--
-- Name: apps_org_key; Type: INDEX; Schema: public
--
--
-- Name: apps_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX apps_org_key ON public.apps USING btree (org_id, key);


--
-- Name: apps_org_status; Type: INDEX; Schema: public
--
--
-- Name: apps_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apps_org_status ON public.apps USING btree (org_id, status);


--
-- Name: asset_events_asset; Type: INDEX; Schema: public
--
--
-- Name: asset_events_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_events_asset ON public.asset_events USING btree (asset_id);


--
-- Name: assets_org_status; Type: INDEX; Schema: public
--
--
-- Name: assets_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assets_org_status ON public.fixed_assets USING btree (org_id, status);


--
-- Name: audit_log_org_at; Type: INDEX; Schema: public
--
--
-- Name: audit_log_org_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_org_at ON public.audit_log USING btree (org_id, at);


--
-- Name: audit_log_row; Type: INDEX; Schema: public
--
--
-- Name: audit_log_row; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_row ON public.audit_log USING btree (table_name, row_id);


--
-- Name: bank_accounts_party; Type: INDEX; Schema: public
--
--
-- Name: bank_accounts_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bank_accounts_party ON public.party_bank_accounts USING btree (party_id);


--
-- Name: billing_requests_org_number; Type: INDEX; Schema: public
--
--
-- Name: billing_requests_org_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX billing_requests_org_number ON public.billing_requests USING btree (org_id, request_number);


--
-- Name: billing_requests_project; Type: INDEX; Schema: public
--
--
-- Name: billing_requests_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_requests_project ON public.billing_requests USING btree (org_id, project_id, status);


--
-- Name: billing_schedules_project; Type: INDEX; Schema: public
--
--
-- Name: billing_schedules_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX billing_schedules_project ON public.billing_schedules USING btree (org_id, project_id, sort_order);


--
-- Name: bom_assembly_component; Type: INDEX; Schema: public
--
--
-- Name: bom_assembly_component; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bom_assembly_component ON public.bom_components USING btree (assembly_item_id, component_item_id);


--
-- Name: books_org_code; Type: INDEX; Schema: public
--
--
-- Name: books_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX books_org_code ON public.accounting_books USING btree (org_id, code);


--
-- Name: budget_lines_org_scenario; Type: INDEX; Schema: public
--
--
-- Name: budget_lines_org_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_lines_org_scenario ON public.budget_lines USING btree (org_id, scenario_id);


--
-- Name: budget_lines_scenario; Type: INDEX; Schema: public
--
--
-- Name: budget_lines_scenario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_lines_scenario ON public.budget_lines USING btree (scenario_id);


--
-- Name: budget_scenarios_org_year_status; Type: INDEX; Schema: public
--
--
-- Name: budget_scenarios_org_year_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX budget_scenarios_org_year_status ON public.budget_scenarios USING btree (org_id, fiscal_year, status);


--
-- Name: change_set_items_set; Type: INDEX; Schema: public
--
--
-- Name: change_set_items_set; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_set_items_set ON public.change_set_items USING btree (change_set_id);


--
-- Name: change_sets_org; Type: INDEX; Schema: public
--
--
-- Name: change_sets_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX change_sets_org ON public.change_sets USING btree (org_id);


--
-- Name: close_automation_execution_once; Type: INDEX; Schema: public
--
--
-- Name: close_automation_execution_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_automation_execution_once ON public.close_automation_executions USING btree (rule_id, event_key);


--
-- Name: close_automation_executions_run; Type: INDEX; Schema: public
--
--
-- Name: close_automation_executions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_automation_executions_run ON public.close_automation_executions USING btree (run_id, created_at);


--
-- Name: close_automation_org_trigger; Type: INDEX; Schema: public
--
--
-- Name: close_automation_org_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_automation_org_trigger ON public.close_automation_rules USING btree (org_id, trigger, is_active);


--
-- Name: close_blueprint_dependencies_blueprint; Type: INDEX; Schema: public
--
--
-- Name: close_blueprint_dependencies_blueprint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_blueprint_dependencies_blueprint ON public.close_blueprint_dependencies USING btree (blueprint_id);


--
-- Name: close_blueprint_dependency_unique; Type: INDEX; Schema: public
--
--
-- Name: close_blueprint_dependency_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_blueprint_dependency_unique ON public.close_blueprint_dependencies USING btree (step_id, depends_on_step_id);


--
-- Name: close_blueprint_steps_key; Type: INDEX; Schema: public
--
--
-- Name: close_blueprint_steps_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_blueprint_steps_key ON public.close_blueprint_steps USING btree (blueprint_id, key);


--
-- Name: close_blueprint_steps_order; Type: INDEX; Schema: public
--
--
-- Name: close_blueprint_steps_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_blueprint_steps_order ON public.close_blueprint_steps USING btree (blueprint_id, sort_order);


--
-- Name: close_blueprints_one_default; Type: INDEX; Schema: public
--
--
-- Name: close_blueprints_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_blueprints_one_default ON public.close_blueprints USING btree (org_id) WHERE (is_default AND is_active);


--
-- Name: close_blueprints_org_name_version; Type: INDEX; Schema: public
--
--
-- Name: close_blueprints_org_name_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_blueprints_org_name_version ON public.close_blueprints USING btree (org_id, name, version);


--
-- Name: close_events_run_at; Type: INDEX; Schema: public
--
--
-- Name: close_events_run_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_events_run_at ON public.close_events USING btree (run_id, at);


--
-- Name: close_exceptions_run_code; Type: INDEX; Schema: public
--
--
-- Name: close_exceptions_run_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_exceptions_run_code ON public.close_exceptions USING btree (run_id, code);


--
-- Name: close_exceptions_run_status; Type: INDEX; Schema: public
--
--
-- Name: close_exceptions_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_exceptions_run_status ON public.close_exceptions USING btree (run_id, status, severity);


--
-- Name: close_policies_org_code; Type: INDEX; Schema: public
--
--
-- Name: close_policies_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_policies_org_code ON public.close_policies USING btree (org_id, code);


--
-- Name: close_reopen_requests_status; Type: INDEX; Schema: public
--
--
-- Name: close_reopen_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_reopen_requests_status ON public.close_reopen_requests USING btree (org_id, status, created_at);


--
-- Name: close_reporting_packages_one_default; Type: INDEX; Schema: public
--
--
-- Name: close_reporting_packages_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_reporting_packages_one_default ON public.close_reporting_packages USING btree (org_id) WHERE (is_default AND is_active);


--
-- Name: close_reporting_packages_org_name; Type: INDEX; Schema: public
--
--
-- Name: close_reporting_packages_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_reporting_packages_org_name ON public.close_reporting_packages USING btree (org_id, name);


--
-- Name: close_run_tasks_key; Type: INDEX; Schema: public
--
--
-- Name: close_run_tasks_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_run_tasks_key ON public.close_run_tasks USING btree (run_id, key);


--
-- Name: close_run_tasks_run_order; Type: INDEX; Schema: public
--
--
-- Name: close_run_tasks_run_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_run_tasks_run_order ON public.close_run_tasks USING btree (run_id, sort_order);


--
-- Name: close_run_tasks_worklist; Type: INDEX; Schema: public
--
--
-- Name: close_run_tasks_worklist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_run_tasks_worklist ON public.close_run_tasks USING btree (org_id, owner_id, status, due_on);


--
-- Name: close_runs_org_status; Type: INDEX; Schema: public
--
--
-- Name: close_runs_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_runs_org_status ON public.close_runs USING btree (org_id, status, target_close_date);


--
-- Name: close_runs_period_book; Type: INDEX; Schema: public
--
--
-- Name: close_runs_period_book; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX close_runs_period_book ON public.close_runs USING btree (org_id, period_id, book_id);


--
-- Name: close_signoffs_run; Type: INDEX; Schema: public
--
--
-- Name: close_signoffs_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_signoffs_run ON public.close_signoffs USING btree (run_id, signed_at);


--
-- Name: close_task_evidence_task; Type: INDEX; Schema: public
--
--
-- Name: close_task_evidence_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX close_task_evidence_task ON public.close_task_evidence USING btree (task_id, created_at);


--
-- Name: connections_org; Type: INDEX; Schema: public
--
--
-- Name: connections_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connections_org ON public.connections USING btree (org_id);


--
-- Name: connections_org_name; Type: INDEX; Schema: public
--
--
-- Name: connections_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX connections_org_name ON public.connections USING btree (org_id, display_name);


--
-- Name: consolidated_fx_period_pair; Type: INDEX; Schema: public
--
--
-- Name: consolidated_fx_period_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consolidated_fx_period_pair ON public.consolidated_fx_rates USING btree (org_id, period_id, from_currency, to_currency);


--
-- Name: contacts_org_name; Type: INDEX; Schema: public
--
--
-- Name: contacts_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_org_name ON public.contacts USING btree (org_id, name);


--
-- Name: contacts_party; Type: INDEX; Schema: public
--
--
-- Name: contacts_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_party ON public.contacts USING btree (party_id);


--
-- Name: cost_layers_item_loc_fifo; Type: INDEX; Schema: public
--
--
-- Name: cost_layers_item_loc_fifo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_layers_item_loc_fifo ON public.cost_layers USING btree (item_id, stock_location_id, received_at);


--
-- Name: count_lines_count; Type: INDEX; Schema: public
--
--
-- Name: count_lines_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX count_lines_count ON public.stock_count_lines USING btree (stock_count_id);


--
-- Name: crm_account_assignment_events_profile; Type: INDEX; Schema: public
--
--
-- Name: crm_account_assignment_events_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_account_assignment_events_profile ON public.crm_account_assignment_events USING btree (account_profile_id, occurred_at);


--
-- Name: crm_account_profiles_party; Type: INDEX; Schema: public
--
--
-- Name: crm_account_profiles_party; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_account_profiles_party ON public.crm_account_profiles USING btree (party_id);


--
-- Name: crm_account_profiles_stage_owner; Type: INDEX; Schema: public
--
--
-- Name: crm_account_profiles_stage_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_account_profiles_stage_owner ON public.crm_account_profiles USING btree (org_id, lifecycle_stage, owner_user_id);


--
-- Name: crm_account_profiles_territory; Type: INDEX; Schema: public
--
--
-- Name: crm_account_profiles_territory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_account_profiles_territory ON public.crm_account_profiles USING btree (org_id, territory_id);


--
-- Name: crm_account_stage_events_profile; Type: INDEX; Schema: public
--
--
-- Name: crm_account_stage_events_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_account_stage_events_profile ON public.crm_account_stage_events USING btree (account_profile_id, occurred_at);


--
-- Name: crm_account_statuses_org_stage; Type: INDEX; Schema: public
--
--
-- Name: crm_account_statuses_org_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_account_statuses_org_stage ON public.crm_account_statuses USING btree (org_id, lifecycle_stage, sequence);


--
-- Name: crm_account_statuses_org_stage_key; Type: INDEX; Schema: public
--
--
-- Name: crm_account_statuses_org_stage_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_account_statuses_org_stage_key ON public.crm_account_statuses USING btree (org_id, lifecycle_stage, key);


--
-- Name: crm_activities_assignee; Type: INDEX; Schema: public
--
--
-- Name: crm_activities_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_activities_assignee ON public.crm_activities USING btree (org_id, assigned_user_id, status, due_at);


--
-- Name: crm_activities_calendar; Type: INDEX; Schema: public
--
--
-- Name: crm_activities_calendar; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_activities_calendar ON public.crm_activities USING btree (org_id, starts_at, ends_at);


--
-- Name: crm_activity_links_subject; Type: INDEX; Schema: public
--
--
-- Name: crm_activity_links_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_activity_links_subject ON public.crm_activity_links USING btree (org_id, subject_kind, subject_id);


--
-- Name: crm_activity_links_unique; Type: INDEX; Schema: public
--
--
-- Name: crm_activity_links_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_activity_links_unique ON public.crm_activity_links USING btree (activity_id, subject_kind, subject_id);


--
-- Name: crm_activity_participants_activity; Type: INDEX; Schema: public
--
--
-- Name: crm_activity_participants_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_activity_participants_activity ON public.crm_activity_participants USING btree (activity_id);


--
-- Name: crm_forecast_snapshots_owner_period; Type: INDEX; Schema: public
--
--
-- Name: crm_forecast_snapshots_owner_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_forecast_snapshots_owner_period ON public.crm_forecast_snapshots USING btree (org_id, owner_user_id, period_start, period_end, as_of);


--
-- Name: crm_lead_sources_org_key; Type: INDEX; Schema: public
--
--
-- Name: crm_lead_sources_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_lead_sources_org_key ON public.crm_lead_sources USING btree (org_id, key);


--
-- Name: crm_opportunities_org_number; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunities_org_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_opportunities_org_number ON public.crm_opportunities USING btree (org_id, opportunity_number);


--
-- Name: crm_opportunities_owner; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunities_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunities_owner ON public.crm_opportunities USING btree (org_id, owner_user_id, expected_close_date);


--
-- Name: crm_opportunities_party; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunities_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunities_party ON public.crm_opportunities USING btree (org_id, party_id);


--
-- Name: crm_opportunities_pipeline; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunities_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunities_pipeline ON public.crm_opportunities USING btree (org_id, status_id, expected_close_date);


--
-- Name: crm_opportunity_documents_document; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_documents_document; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_opportunity_documents_document ON public.crm_opportunity_documents USING btree (document_id);


--
-- Name: crm_opportunity_documents_opportunity; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_documents_opportunity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunity_documents_opportunity ON public.crm_opportunity_documents USING btree (opportunity_id);


--
-- Name: crm_opportunity_lines_number; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_lines_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_opportunity_lines_number ON public.crm_opportunity_lines USING btree (opportunity_id, line_number);


--
-- Name: crm_opportunity_lines_opportunity; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_lines_opportunity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunity_lines_opportunity ON public.crm_opportunity_lines USING btree (opportunity_id);


--
-- Name: crm_opportunity_stage_events_opportunity; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_stage_events_opportunity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunity_stage_events_opportunity ON public.crm_opportunity_stage_events USING btree (opportunity_id, occurred_at);


--
-- Name: crm_opportunity_statuses_org_key; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_statuses_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_opportunity_statuses_org_key ON public.crm_opportunity_statuses USING btree (org_id, key);


--
-- Name: crm_opportunity_statuses_org_sequence; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_statuses_org_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_opportunity_statuses_org_sequence ON public.crm_opportunity_statuses USING btree (org_id, sequence);


--
-- Name: crm_opportunity_team_members_unique; Type: INDEX; Schema: public
--
--
-- Name: crm_opportunity_team_members_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_opportunity_team_members_unique ON public.crm_opportunity_team_members USING btree (opportunity_id, user_id);


--
-- Name: crm_sales_quotas_owner_period; Type: INDEX; Schema: public
--
--
-- Name: crm_sales_quotas_owner_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sales_quotas_owner_period ON public.crm_sales_quotas USING btree (org_id, owner_user_id, period_start, period_end);


--
-- Name: crm_sales_team_members_unique; Type: INDEX; Schema: public
--
--
-- Name: crm_sales_team_members_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sales_team_members_unique ON public.crm_sales_team_members USING btree (team_id, user_id);


--
-- Name: crm_sales_teams_org_key; Type: INDEX; Schema: public
--
--
-- Name: crm_sales_teams_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sales_teams_org_key ON public.crm_sales_teams USING btree (org_id, key);


--
-- Name: crm_sales_territories_org_key; Type: INDEX; Schema: public
--
--
-- Name: crm_sales_territories_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sales_territories_org_key ON public.crm_sales_territories USING btree (org_id, key);


--
-- Name: crm_sales_territories_routing; Type: INDEX; Schema: public
--
--
-- Name: crm_sales_territories_routing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sales_territories_routing ON public.crm_sales_territories USING btree (org_id, is_active, priority);


--
-- Name: custom_field_defs_target; Type: INDEX; Schema: public
--
--
-- Name: custom_field_defs_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_field_defs_target ON public.custom_field_defs USING btree (org_id, target_table, target_kind);


--
-- Name: custom_record_types_org_key; Type: INDEX; Schema: public
--
--
-- Name: custom_record_types_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX custom_record_types_org_key ON public.custom_record_types USING btree (org_id, key);


--
-- Name: custom_record_types_org_status; Type: INDEX; Schema: public
--
--
-- Name: custom_record_types_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_record_types_org_status ON public.custom_record_types USING btree (org_id, status);


--
-- Name: custom_records_org_type_created; Type: INDEX; Schema: public
--
--
-- Name: custom_records_org_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_records_org_type_created ON public.custom_records USING btree (org_id, type_key, created_at);


--
-- Name: custom_records_org_type_status; Type: INDEX; Schema: public
--
--
-- Name: custom_records_org_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_records_org_type_status ON public.custom_records USING btree (org_id, type_key, status);


--
-- Name: custom_records_type_number; Type: INDEX; Schema: public
--
--
-- Name: custom_records_type_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX custom_records_type_number ON public.custom_records USING btree (type_id, record_number);


--
-- Name: dep_book_policies_identity; Type: INDEX; Schema: public
--
--
-- Name: dep_book_policies_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dep_book_policies_identity ON public.depreciation_book_policies USING btree (org_id, book_id, category_id);


--
-- Name: depr_lines_period; Type: INDEX; Schema: public
--
--
-- Name: depr_lines_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX depr_lines_period ON public.depreciation_schedule_lines USING btree (period_id);


--
-- Name: depr_lines_schedule; Type: INDEX; Schema: public
--
--
-- Name: depr_lines_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX depr_lines_schedule ON public.depreciation_schedule_lines USING btree (schedule_id);


--
-- Name: depr_schedules_asset; Type: INDEX; Schema: public
--
--
-- Name: depr_schedules_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX depr_schedules_asset ON public.depreciation_schedules USING btree (asset_id);


--
-- Name: depreciation_methods_org_code; Type: INDEX; Schema: public
--
--
-- Name: depreciation_methods_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX depreciation_methods_org_code ON public.depreciation_methods USING btree (org_id, code);


--
-- Name: doc_lines_document; Type: INDEX; Schema: public
--
--
-- Name: doc_lines_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_lines_document ON public.document_lines USING btree (document_id);


--
-- Name: doc_lines_project_billable; Type: INDEX; Schema: public
--
--
-- Name: doc_lines_project_billable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_lines_project_billable ON public.document_lines USING btree (project_id, is_billable);


--
-- Name: doc_links_from; Type: INDEX; Schema: public
--
--
-- Name: doc_links_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_links_from ON public.document_links USING btree (from_document_id);


--
-- Name: doc_links_to; Type: INDEX; Schema: public
--
--
-- Name: doc_links_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_links_to ON public.document_links USING btree (to_document_id);


--
-- Name: document_lines_extra_dims_gin; Type: INDEX; Schema: public
--
--
-- Name: document_lines_extra_dims_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_lines_extra_dims_gin ON public.document_lines USING gin (extra_dims);


--
-- Name: documents_extra_dims_gin; Type: INDEX; Schema: public
--
--
-- Name: documents_extra_dims_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_extra_dims_gin ON public.documents USING gin (extra_dims);


--
-- Name: documents_org_kind_number; Type: INDEX; Schema: public
--
--
-- Name: documents_org_kind_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documents_org_kind_number ON public.documents USING btree (org_id, kind, document_number);


--
-- Name: documents_org_kind_status; Type: INDEX; Schema: public
--
--
-- Name: documents_org_kind_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_org_kind_status ON public.documents USING btree (org_id, kind, status);


--
-- Name: documents_party; Type: INDEX; Schema: public
--
--
-- Name: documents_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_party ON public.documents USING btree (party_id);


--
-- Name: documents_project; Type: INDEX; Schema: public
--
--
-- Name: documents_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_project ON public.documents USING btree (project_id);


--
-- Name: email_log_job; Type: INDEX; Schema: public
--
--
-- Name: email_log_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_log_job ON public.email_log USING btree (job_id);


--
-- Name: email_log_org; Type: INDEX; Schema: public
--
--
-- Name: email_log_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_log_org ON public.email_log USING btree (org_id, created_at);


--
-- Name: email_log_status; Type: INDEX; Schema: public
--
--
-- Name: email_log_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_log_status ON public.email_log USING btree (org_id, status, created_at);


--
-- Name: fair_value_item; Type: INDEX; Schema: public
--
--
-- Name: fair_value_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fair_value_item ON public.fair_value_prices USING btree (item_id, currency, effective_from);


--
-- Name: file_attachments_file; Type: INDEX; Schema: public
--
--
-- Name: file_attachments_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_attachments_file ON public.file_attachments USING btree (org_id, file_id);


--
-- Name: file_attachments_target; Type: INDEX; Schema: public
--
--
-- Name: file_attachments_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_attachments_target ON public.file_attachments USING btree (org_id, target_table, target_id);


--
-- Name: file_attachments_unique; Type: INDEX; Schema: public
--
--
-- Name: file_attachments_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_attachments_unique ON public.file_attachments USING btree (org_id, file_id, target_table, target_id);


--
-- Name: file_blobs_version; Type: INDEX; Schema: public
--
--
-- Name: file_blobs_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_blobs_version ON public.file_blobs USING btree (version_id);


--
-- Name: file_versions_file; Type: INDEX; Schema: public
--
--
-- Name: file_versions_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_versions_file ON public.file_versions USING btree (file_id);


--
-- Name: file_versions_file_version; Type: INDEX; Schema: public
--
--
-- Name: file_versions_file_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_versions_file_version ON public.file_versions USING btree (file_id, version_number);


--
-- Name: files_folder; Type: INDEX; Schema: public
--
--
-- Name: files_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_folder ON public.files USING btree (org_id, folder_id);


--
-- Name: files_org; Type: INDEX; Schema: public
--
--
-- Name: files_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_org ON public.files USING btree (org_id);


--
-- Name: fiscal_calendars_one_default; Type: INDEX; Schema: public
--
--
-- Name: fiscal_calendars_one_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fiscal_calendars_one_default ON public.fiscal_calendars USING btree (org_id) WHERE is_default;


--
-- Name: fiscal_calendars_org_active; Type: INDEX; Schema: public
--
--
-- Name: fiscal_calendars_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fiscal_calendars_org_active ON public.fiscal_calendars USING btree (org_id, is_active);


--
-- Name: fiscal_calendars_org_name; Type: INDEX; Schema: public
--
--
-- Name: fiscal_calendars_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fiscal_calendars_org_name ON public.fiscal_calendars USING btree (org_id, name);


--
-- Name: fixed_assets_org_subsidiary; Type: INDEX; Schema: public
--
--
-- Name: fixed_assets_org_subsidiary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fixed_assets_org_subsidiary ON public.fixed_assets USING btree (org_id, subsidiary_id);


--
-- Name: flow_gates_assignee; Type: INDEX; Schema: public
--
--
-- Name: flow_gates_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_gates_assignee ON public.flow_gates USING btree (org_id, status, assignee_user_id);


--
-- Name: flow_gates_remind; Type: INDEX; Schema: public
--
--
-- Name: flow_gates_remind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_gates_remind ON public.flow_gates USING btree (org_id, status, remind_at);


--
-- Name: flow_gates_run_node_assignee; Type: INDEX; Schema: public
--
--
-- Name: flow_gates_run_node_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX flow_gates_run_node_assignee ON public.flow_gates USING btree (run_id, node_id, assignee_user_id);


--
-- Name: flow_gates_subject; Type: INDEX; Schema: public
--
--
-- Name: flow_gates_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_gates_subject ON public.flow_gates USING btree (org_id, subject_kind, subject_id);


--
-- Name: flow_locks_org; Type: INDEX; Schema: public
--
--
-- Name: flow_locks_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_locks_org ON public.flow_locks USING btree (org_id, subject_kind);


--
-- Name: flow_locks_subject; Type: INDEX; Schema: public
--
--
-- Name: flow_locks_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX flow_locks_subject ON public.flow_locks USING btree (subject_kind, subject_id);


--
-- Name: flow_run_effects_run_effect; Type: INDEX; Schema: public
--
--
-- Name: flow_run_effects_run_effect; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX flow_run_effects_run_effect ON public.flow_run_effects USING btree (run_id, effect_key);


--
-- Name: flow_runs_org_flow; Type: INDEX; Schema: public
--
--
-- Name: flow_runs_org_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_runs_org_flow ON public.flow_runs USING btree (org_id, flow_id);


--
-- Name: flow_runs_status; Type: INDEX; Schema: public
--
--
-- Name: flow_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_runs_status ON public.flow_runs USING btree (org_id, status);


--
-- Name: flow_runs_subject; Type: INDEX; Schema: public
--
--
-- Name: flow_runs_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flow_runs_subject ON public.flow_runs USING btree (org_id, subject_kind, subject_id);


--
-- Name: flows_org_subject; Type: INDEX; Schema: public
--
--
-- Name: flows_org_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX flows_org_subject ON public.flows USING btree (org_id, subject_kind, enabled);


--
-- Name: folders_org; Type: INDEX; Schema: public
--
--
-- Name: folders_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX folders_org ON public.folders USING btree (org_id);


--
-- Name: folders_parent; Type: INDEX; Schema: public
--
--
-- Name: folders_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX folders_parent ON public.folders USING btree (org_id, parent_folder_id);


--
-- Name: folders_record; Type: INDEX; Schema: public
--
--
-- Name: folders_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX folders_record ON public.folders USING btree (org_id, record_table, record_id);


--
-- Name: form_layouts_org_type; Type: INDEX; Schema: public
--
--
-- Name: form_layouts_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_layouts_org_type ON public.form_layouts USING btree (org_id, record_type, is_default);


--
-- Name: form_layouts_org_type_name; Type: INDEX; Schema: public
--
--
-- Name: form_layouts_org_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_layouts_org_type_name ON public.form_layouts USING btree (org_id, record_type, name);


--
-- Name: form_response_steps_response; Type: INDEX; Schema: public
--
--
-- Name: form_response_steps_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_response_steps_response ON public.form_response_steps USING btree (response_id, at);


--
-- Name: form_responses_org_status; Type: INDEX; Schema: public
--
--
-- Name: form_responses_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_responses_org_status ON public.form_responses USING btree (org_id, status);


--
-- Name: form_responses_org_template; Type: INDEX; Schema: public
--
--
-- Name: form_responses_org_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_responses_org_template ON public.form_responses USING btree (org_id, template_key, submitted_at);


--
-- Name: form_responses_version; Type: INDEX; Schema: public
--
--
-- Name: form_responses_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_responses_version ON public.form_responses USING btree (version_id);


--
-- Name: form_template_versions_org; Type: INDEX; Schema: public
--
--
-- Name: form_template_versions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_template_versions_org ON public.form_template_versions USING btree (org_id);


--
-- Name: form_template_versions_template_version; Type: INDEX; Schema: public
--
--
-- Name: form_template_versions_template_version; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_template_versions_template_version ON public.form_template_versions USING btree (template_id, version);


--
-- Name: form_templates_org_key; Type: INDEX; Schema: public
--
--
-- Name: form_templates_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_templates_org_key ON public.form_templates USING btree (org_id, key);


--
-- Name: form_templates_org_status; Type: INDEX; Schema: public
--
--
-- Name: form_templates_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_templates_org_status ON public.form_templates USING btree (org_id, status);


--
-- Name: fx_provider_configs_due; Type: INDEX; Schema: public
--
--
-- Name: fx_provider_configs_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fx_provider_configs_due ON public.fx_provider_configs USING btree (is_enabled, next_sync_at);


--
-- Name: fx_provider_configs_org; Type: INDEX; Schema: public
--
--
-- Name: fx_provider_configs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fx_provider_configs_org ON public.fx_provider_configs USING btree (org_id);


--
-- Name: fx_provider_runs_config_started; Type: INDEX; Schema: public
--
--
-- Name: fx_provider_runs_config_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fx_provider_runs_config_started ON public.fx_provider_runs USING btree (provider_config_id, started_at);


--
-- Name: fx_provider_runs_one_running; Type: INDEX; Schema: public
--
--
-- Name: fx_provider_runs_one_running; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fx_provider_runs_one_running ON public.fx_provider_runs USING btree (provider_config_id) WHERE (status = 'running'::text);


--
-- Name: fx_provider_runs_org_started; Type: INDEX; Schema: public
--
--
-- Name: fx_provider_runs_org_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fx_provider_runs_org_started ON public.fx_provider_runs USING btree (org_id, started_at);


--
-- Name: fx_rates_org_pair_date_type; Type: INDEX; Schema: public
--
--
-- Name: fx_rates_org_pair_date_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fx_rates_org_pair_date_type ON public.fx_rates USING btree (org_id, from_currency, to_currency, as_of, rate_type);


--
-- Name: fx_rates_provider; Type: INDEX; Schema: public
--
--
-- Name: fx_rates_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fx_rates_provider ON public.fx_rates USING btree (provider_config_id, as_of);


--
-- Name: idx_accounts_name_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_accounts_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_name_trgm ON public.accounts USING gin (name public.gin_trgm_ops);


--
-- Name: idx_accounts_number_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_accounts_number_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_number_trgm ON public.accounts USING gin (number public.gin_trgm_ops);


--
-- Name: idx_document_lines_amount; Type: INDEX; Schema: public
--
--
-- Name: idx_document_lines_amount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_lines_amount ON public.document_lines USING btree (amount);


--
-- Name: idx_documents_memo_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_documents_memo_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_memo_trgm ON public.documents USING gin (memo public.gin_trgm_ops);


--
-- Name: idx_documents_number_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_documents_number_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_number_trgm ON public.documents USING gin (document_number public.gin_trgm_ops);


--
-- Name: idx_documents_org_total; Type: INDEX; Schema: public
--
--
-- Name: idx_documents_org_total; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_org_total ON public.documents USING btree (org_id, total);


--
-- Name: idx_documents_reference_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_documents_reference_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_reference_trgm ON public.documents USING gin (reference_number public.gin_trgm_ops);


--
-- Name: idx_items_code_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_items_code_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_code_trgm ON public.items USING gin (code public.gin_trgm_ops);


--
-- Name: idx_items_name_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_items_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_name_trgm ON public.items USING gin (name public.gin_trgm_ops);


--
-- Name: idx_parties_display_name_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_parties_display_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parties_display_name_trgm ON public.parties USING gin (display_name public.gin_trgm_ops);


--
-- Name: idx_parties_email_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_parties_email_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parties_email_trgm ON public.parties USING gin (email public.gin_trgm_ops);


--
-- Name: idx_parties_legal_name_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_parties_legal_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parties_legal_name_trgm ON public.parties USING gin (legal_name public.gin_trgm_ops);


--
-- Name: idx_projects_code_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_projects_code_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_code_trgm ON public.projects USING gin (code public.gin_trgm_ops);


--
-- Name: idx_projects_name_trgm; Type: INDEX; Schema: public
--
--
-- Name: idx_projects_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_name_trgm ON public.projects USING gin (name public.gin_trgm_ops);


--
-- Name: import_jobs_org_created; Type: INDEX; Schema: public
--
--
-- Name: import_jobs_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_jobs_org_created ON public.import_jobs USING btree (org_id, created_at);


--
-- Name: insight_cards_org_name; Type: INDEX; Schema: public
--
--
-- Name: insight_cards_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_cards_org_name ON public.insight_cards USING btree (org_id, name);


--
-- Name: insight_cards_org_status; Type: INDEX; Schema: public
--
--
-- Name: insight_cards_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_cards_org_status ON public.insight_cards USING btree (org_id, status);


--
-- Name: insight_dashboards_org_home; Type: INDEX; Schema: public
--
--
-- Name: insight_dashboards_org_home; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_dashboards_org_home ON public.insight_dashboards USING btree (org_id, is_home);


--
-- Name: insight_dashboards_org_name; Type: INDEX; Schema: public
--
--
-- Name: insight_dashboards_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_dashboards_org_name ON public.insight_dashboards USING btree (org_id, name);


--
-- Name: insight_dashboards_org_role_home; Type: INDEX; Schema: public
--
--
-- Name: insight_dashboards_org_role_home; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_dashboards_org_role_home ON public.insight_dashboards USING btree (org_id, home_for_role);


--
-- Name: insight_dashboards_org_status; Type: INDEX; Schema: public
--
--
-- Name: insight_dashboards_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_dashboards_org_status ON public.insight_dashboards USING btree (org_id, status);


--
-- Name: insight_pins_dashboard; Type: INDEX; Schema: public
--
--
-- Name: insight_pins_dashboard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_pins_dashboard ON public.insight_dashboard_pins USING btree (dashboard_id);


--
-- Name: insight_pins_unique; Type: INDEX; Schema: public
--
--
-- Name: insight_pins_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX insight_pins_unique ON public.insight_dashboard_pins USING btree (user_id, dashboard_id);


--
-- Name: insight_pins_user; Type: INDEX; Schema: public
--
--
-- Name: insight_pins_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insight_pins_user ON public.insight_dashboard_pins USING btree (org_id, user_id, sort_order);


--
-- Name: intercompany_subsidiary_pair; Type: INDEX; Schema: public
--
--
-- Name: intercompany_subsidiary_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX intercompany_subsidiary_pair ON public.intercompany_pairs USING btree (LEAST(from_subsidiary_id, to_subsidiary_id), GREATEST(from_subsidiary_id, to_subsidiary_id));


--
-- Name: inv_moves_doc_line; Type: INDEX; Schema: public
--
--
-- Name: inv_moves_doc_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inv_moves_doc_line ON public.inventory_movements USING btree (document_line_id);


--
-- Name: inv_moves_item_loc; Type: INDEX; Schema: public
--
--
-- Name: inv_moves_item_loc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inv_moves_item_loc ON public.inventory_movements USING btree (item_id, stock_location_id);


--
-- Name: invoice_backups_document; Type: INDEX; Schema: public
--
--
-- Name: invoice_backups_document; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invoice_backups_document ON public.invoice_backups USING btree (org_id, document_id);


--
-- Name: items_org_code; Type: INDEX; Schema: public
--
--
-- Name: items_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX items_org_code ON public.items USING btree (org_id, code);


--
-- Name: je_org_date; Type: INDEX; Schema: public
--
--
-- Name: je_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX je_org_date ON public.journal_entries USING btree (org_id, posting_date);


--
-- Name: je_org_period; Type: INDEX; Schema: public
--
--
-- Name: je_org_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX je_org_period ON public.journal_entries USING btree (org_id, period_id);


--
-- Name: je_source_doc; Type: INDEX; Schema: public
--
--
-- Name: je_source_doc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX je_source_doc ON public.journal_entries USING btree (source_document_id);


--
-- Name: jl_entry; Type: INDEX; Schema: public
--
--
-- Name: jl_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jl_entry ON public.journal_lines USING btree (entry_id);


--
-- Name: jl_org_account; Type: INDEX; Schema: public
--
--
-- Name: jl_org_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jl_org_account ON public.journal_lines USING btree (org_id, account_id);


--
-- Name: jl_org_party_open; Type: INDEX; Schema: public
--
--
-- Name: jl_org_party_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jl_org_party_open ON public.journal_lines USING btree (org_id, party_id, is_open_item);


--
-- Name: jl_org_project; Type: INDEX; Schema: public
--
--
-- Name: jl_org_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jl_org_project ON public.journal_lines USING btree (org_id, project_id);


--
-- Name: jl_org_sub_account; Type: INDEX; Schema: public
--
--
-- Name: jl_org_sub_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jl_org_sub_account ON public.journal_lines USING btree (org_id, subsidiary_id, account_id);


--
-- Name: journal_lines_extra_dims_gin; Type: INDEX; Schema: public
--
--
-- Name: journal_lines_extra_dims_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX journal_lines_extra_dims_gin ON public.journal_lines USING gin (extra_dims);


--
-- Name: landed_cost_source; Type: INDEX; Schema: public
--
--
-- Name: landed_cost_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landed_cost_source ON public.landed_cost_allocations USING btree (source_document_line_id);


--
-- Name: layer_consumptions_layer; Type: INDEX; Schema: public
--
--
-- Name: layer_consumptions_layer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX layer_consumptions_layer ON public.cost_layer_consumptions USING btree (cost_layer_id);


--
-- Name: layer_consumptions_movement; Type: INDEX; Schema: public
--
--
-- Name: layer_consumptions_movement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX layer_consumptions_movement ON public.cost_layer_consumptions USING btree (issue_movement_id);


--
-- Name: list_views_org_scope_type_name; Type: INDEX; Schema: public
--
--
-- Name: list_views_org_scope_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX list_views_org_scope_type_name ON public.list_views USING btree (org_id, scope, record_type, name);


--
-- Name: list_views_org_type; Type: INDEX; Schema: public
--
--
-- Name: list_views_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX list_views_org_type ON public.list_views USING btree (org_id, record_type, scope);


--
-- Name: lots_item_number; Type: INDEX; Schema: public
--
--
-- Name: lots_item_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lots_item_number ON public.lots USING btree (item_id, lot_number);


--
-- Name: masking_policies_col; Type: INDEX; Schema: public
--
--
-- Name: masking_policies_col; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX masking_policies_col ON public.masking_policies USING btree (org_id, table_name, column_name);


--
-- Name: notifications_user_created; Type: INDEX; Schema: public
--
--
-- Name: notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_created ON public.notifications USING btree (user_id, created_at);


--
-- Name: notifications_user_inbox; Type: INDEX; Schema: public
--
--
-- Name: notifications_user_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_inbox ON public.notifications USING btree (org_id, user_id, read_at);


--
-- Name: obligations_contract; Type: INDEX; Schema: public
--
--
-- Name: obligations_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obligations_contract ON public.performance_obligations USING btree (contract_id);


--
-- Name: obligations_doc_line; Type: INDEX; Schema: public
--
--
-- Name: obligations_doc_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX obligations_doc_line ON public.performance_obligations USING btree (document_line_id);


--
-- Name: org_nav_configs_org; Type: INDEX; Schema: public
--
--
-- Name: org_nav_configs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_nav_configs_org ON public.org_nav_configs USING btree (org_id);


--
-- Name: parties_org_name; Type: INDEX; Schema: public
--
--
-- Name: parties_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX parties_org_name ON public.parties USING btree (org_id, display_name);


--
-- Name: parties_org_shortcode; Type: INDEX; Schema: public
--
--
-- Name: parties_org_shortcode; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX parties_org_shortcode ON public.parties USING btree (org_id, short_code);


--
-- Name: party_subsidiaries_org; Type: INDEX; Schema: public
--
--
-- Name: party_subsidiaries_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX party_subsidiaries_org ON public.party_subsidiaries USING btree (org_id);


--
-- Name: party_subsidiaries_party_sub; Type: INDEX; Schema: public
--
--
-- Name: party_subsidiaries_party_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX party_subsidiaries_party_sub ON public.party_subsidiaries USING btree (party_id, subsidiary_id);


--
-- Name: pay_instructions_run; Type: INDEX; Schema: public
--
--
-- Name: pay_instructions_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pay_instructions_run ON public.payment_instructions USING btree (payment_run_id);


--
-- Name: payment_bank_profiles_org_active; Type: INDEX; Schema: public
--
--
-- Name: payment_bank_profiles_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_bank_profiles_org_active ON public.payment_bank_profiles USING btree (org_id, is_active);


--
-- Name: payment_bank_profiles_org_name; Type: INDEX; Schema: public
--
--
-- Name: payment_bank_profiles_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_bank_profiles_org_name ON public.payment_bank_profiles USING btree (org_id, name);


--
-- Name: payment_events_run_time; Type: INDEX; Schema: public
--
--
-- Name: payment_events_run_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_events_run_time ON public.payment_events USING btree (payment_run_id, created_at);


--
-- Name: payment_file_deliveries_file; Type: INDEX; Schema: public
--
--
-- Name: payment_file_deliveries_file; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_file_deliveries_file ON public.payment_file_deliveries USING btree (payment_file_id, created_at);


--
-- Name: payment_files_hash; Type: INDEX; Schema: public
--
--
-- Name: payment_files_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_files_hash ON public.payment_files USING btree (org_id, content_hash);


--
-- Name: payment_files_run_sequence; Type: INDEX; Schema: public
--
--
-- Name: payment_files_run_sequence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_files_run_sequence ON public.payment_files USING btree (payment_run_id, sequence_number);


--
-- Name: payment_files_run_status; Type: INDEX; Schema: public
--
--
-- Name: payment_files_run_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_files_run_status ON public.payment_files USING btree (payment_run_id, status);


--
-- Name: payment_formats_org_active; Type: INDEX; Schema: public
--
--
-- Name: payment_formats_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_formats_org_active ON public.payment_formats USING btree (org_id, is_active);


--
-- Name: payment_formats_org_code; Type: INDEX; Schema: public
--
--
-- Name: payment_formats_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_formats_org_code ON public.payment_formats USING btree (org_id, code);


--
-- Name: payment_mandates_org_reference; Type: INDEX; Schema: public
--
--
-- Name: payment_mandates_org_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_mandates_org_reference ON public.payment_mandates USING btree (org_id, mandate_reference);


--
-- Name: payment_mandates_party_status; Type: INDEX; Schema: public
--
--
-- Name: payment_mandates_party_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_mandates_party_status ON public.payment_mandates USING btree (party_id, status);


--
-- Name: payment_remittances_instruction; Type: INDEX; Schema: public
--
--
-- Name: payment_remittances_instruction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_remittances_instruction ON public.payment_remittances USING btree (payment_instruction_id, created_at);


--
-- Name: payment_run_items_instruction; Type: INDEX; Schema: public
--
--
-- Name: payment_run_items_instruction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_run_items_instruction ON public.payment_run_items USING btree (payment_instruction_id);


--
-- Name: payment_run_items_run; Type: INDEX; Schema: public
--
--
-- Name: payment_run_items_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_run_items_run ON public.payment_run_items USING btree (payment_run_id);


--
-- Name: payment_run_items_source; Type: INDEX; Schema: public
--
--
-- Name: payment_run_items_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_run_items_source ON public.payment_run_items USING btree (payment_run_id, source_open_line_id);


--
-- Name: payment_schedules_due; Type: INDEX; Schema: public
--
--
-- Name: payment_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_schedules_due ON public.payment_schedules USING btree (is_active, next_run_at);


--
-- Name: payment_schedules_org_name; Type: INDEX; Schema: public
--
--
-- Name: payment_schedules_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_schedules_org_name ON public.payment_schedules USING btree (org_id, name);


--
-- Name: payment_settlements_instruction; Type: INDEX; Schema: public
--
--
-- Name: payment_settlements_instruction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_settlements_instruction ON public.payment_settlements USING btree (payment_instruction_id);


--
-- Name: payment_settlements_status; Type: INDEX; Schema: public
--
--
-- Name: payment_settlements_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_settlements_status ON public.payment_settlements USING btree (org_id, status);


--
-- Name: pdf_templates_org_type; Type: INDEX; Schema: public
--
--
-- Name: pdf_templates_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pdf_templates_org_type ON public.pdf_templates USING btree (org_id, record_type, is_default);


--
-- Name: pdf_templates_org_type_name; Type: INDEX; Schema: public
--
--
-- Name: pdf_templates_org_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pdf_templates_org_type_name ON public.pdf_templates USING btree (org_id, record_type, name);


--
-- Name: period_locks_lookup; Type: INDEX; Schema: public
--
--
-- Name: period_locks_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX period_locks_lookup ON public.period_locks USING btree (org_id, period_id, book_id, module, subsidiary_id);


--
-- Name: period_locks_scope; Type: INDEX; Schema: public
--
--
-- Name: period_locks_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX period_locks_scope ON public.period_locks USING btree (org_id, period_id, book_id, subsidiary_id, module) NULLS NOT DISTINCT;


--
-- Name: periods_calendar_year_num; Type: INDEX; Schema: public
--
--
-- Name: periods_calendar_year_num; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX periods_calendar_year_num ON public.accounting_periods USING btree (org_id, fiscal_calendar_id, fiscal_year, period_number);


--
-- Name: project_tasks_project; Type: INDEX; Schema: public
--
--
-- Name: project_tasks_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_tasks_project ON public.project_tasks USING btree (project_id);


--
-- Name: projects_customer; Type: INDEX; Schema: public
--
--
-- Name: projects_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_customer ON public.projects USING btree (customer_id);


--
-- Name: rec_lines_period; Type: INDEX; Schema: public
--
--
-- Name: rec_lines_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rec_lines_period ON public.recognition_schedule_lines USING btree (period_id);


--
-- Name: rec_lines_schedule; Type: INDEX; Schema: public
--
--
-- Name: rec_lines_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rec_lines_schedule ON public.recognition_schedule_lines USING btree (schedule_id);


--
-- Name: rec_schedules_obligation_book; Type: INDEX; Schema: public
--
--
-- Name: rec_schedules_obligation_book; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rec_schedules_obligation_book ON public.recognition_schedules USING btree (obligation_id, book_id);


--
-- Name: recognition_rules_org_code; Type: INDEX; Schema: public
--
--
-- Name: recognition_rules_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recognition_rules_org_code ON public.recognition_rules USING btree (org_id, code);


--
-- Name: recon_matches_journal_line; Type: INDEX; Schema: public
--
--
-- Name: recon_matches_journal_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recon_matches_journal_line ON public.reconciliation_matches USING btree (journal_line_id);


--
-- Name: recon_matches_stmt_line; Type: INDEX; Schema: public
--
--
-- Name: recon_matches_stmt_line; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recon_matches_stmt_line ON public.reconciliation_matches USING btree (statement_line_id);


--
-- Name: recons_account; Type: INDEX; Schema: public
--
--
-- Name: recons_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recons_account ON public.reconciliations USING btree (account_id);


--
-- Name: recurring_next_run; Type: INDEX; Schema: public
--
--
-- Name: recurring_next_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recurring_next_run ON public.recurring_schedules USING btree (is_active, next_run_on);


--
-- Name: report_definitions_org_kind; Type: INDEX; Schema: public
--
--
-- Name: report_definitions_org_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_definitions_org_kind ON public.report_definitions USING btree (org_id, kind);


--
-- Name: report_definitions_org_slug; Type: INDEX; Schema: public
--
--
-- Name: report_definitions_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_definitions_org_slug ON public.report_definitions USING btree (org_id, slug);


--
-- Name: report_runs_definition; Type: INDEX; Schema: public
--
--
-- Name: report_runs_definition; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_runs_definition ON public.report_runs USING btree (definition_id, created_at);


--
-- Name: report_runs_org_status; Type: INDEX; Schema: public
--
--
-- Name: report_runs_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_runs_org_status ON public.report_runs USING btree (org_id, status);


--
-- Name: report_runs_schedule; Type: INDEX; Schema: public
--
--
-- Name: report_runs_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_runs_schedule ON public.report_runs USING btree (schedule_id);


--
-- Name: report_schedules_definition; Type: INDEX; Schema: public
--
--
-- Name: report_schedules_definition; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_schedules_definition ON public.report_schedules USING btree (definition_id);


--
-- Name: report_schedules_due; Type: INDEX; Schema: public
--
--
-- Name: report_schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_schedules_due ON public.report_schedules USING btree (active, next_run_at);


--
-- Name: report_schedules_org; Type: INDEX; Schema: public
--
--
-- Name: report_schedules_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_schedules_org ON public.report_schedules USING btree (org_id);


--
-- Name: rev_contracts_customer; Type: INDEX; Schema: public
--
--
-- Name: rev_contracts_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rev_contracts_customer ON public.revenue_contracts USING btree (customer_id);


--
-- Name: role_assignments_org_user_role; Type: INDEX; Schema: public
--
--
-- Name: role_assignments_org_user_role; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX role_assignments_org_user_role ON public.role_assignments USING btree (org_id, user_id, role_id);


--
-- Name: role_assignments_role; Type: INDEX; Schema: public
--
--
-- Name: role_assignments_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX role_assignments_role ON public.role_assignments USING btree (role_id);


--
-- Name: role_assignments_user; Type: INDEX; Schema: public
--
--
-- Name: role_assignments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX role_assignments_user ON public.role_assignments USING btree (user_id);


--
-- Name: role_dashboard_layouts_unique; Type: INDEX; Schema: public
--
--
-- Name: role_dashboard_layouts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX role_dashboard_layouts_unique ON public.role_dashboard_layouts USING btree (org_id, role_key);


--
-- Name: sandboxes_org; Type: INDEX; Schema: public
--
--
-- Name: sandboxes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sandboxes_org ON public.sandboxes USING btree (org_id);


--
-- Name: sandboxes_production; Type: INDEX; Schema: public
--
--
-- Name: sandboxes_production; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sandboxes_production ON public.sandboxes USING btree (production_org_id);


--
-- Name: saved_reports_org; Type: INDEX; Schema: public
--
--
-- Name: saved_reports_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_reports_org ON public.saved_reports USING btree (org_id);


--
-- Name: saved_views_org_name; Type: INDEX; Schema: public
--
--
-- Name: saved_views_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_views_org_name ON public.saved_views USING btree (org_id, name);


--
-- Name: saved_views_org_owner; Type: INDEX; Schema: public
--
--
-- Name: saved_views_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_views_org_owner ON public.saved_views USING btree (org_id, owner_id);


--
-- Name: saved_views_org_scope; Type: INDEX; Schema: public
--
--
-- Name: saved_views_org_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_views_org_scope ON public.saved_views USING btree (org_id, scope);


--
-- Name: saved_views_org_slug; Type: INDEX; Schema: public
--
--
-- Name: saved_views_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX saved_views_org_slug ON public.saved_views USING btree (org_id, slug);


--
-- Name: script_runs_script; Type: INDEX; Schema: public
--
--
-- Name: script_runs_script; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX script_runs_script ON public.script_runs USING btree (script_id, at);


--
-- Name: segment_definitions_org_key; Type: INDEX; Schema: public
--
--
-- Name: segment_definitions_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX segment_definitions_org_key ON public.segment_definitions USING btree (org_id, key);


--
-- Name: segment_definitions_org_order; Type: INDEX; Schema: public
--
--
-- Name: segment_definitions_org_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX segment_definitions_org_order ON public.segment_definitions USING btree (org_id, sort_order, name);


--
-- Name: segment_values_org_segment; Type: INDEX; Schema: public
--
--
-- Name: segment_values_org_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX segment_values_org_segment ON public.segment_values USING btree (org_id, segment_id, name);


--
-- Name: segment_values_org_segment_code; Type: INDEX; Schema: public
--
--
-- Name: segment_values_org_segment_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX segment_values_org_segment_code ON public.segment_values USING btree (org_id, segment_id, lower(code)) WHERE (code IS NOT NULL);


--
-- Name: segment_values_parent; Type: INDEX; Schema: public
--
--
-- Name: segment_values_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX segment_values_parent ON public.segment_values USING btree (parent_id);


--
-- Name: serials_item_number; Type: INDEX; Schema: public
--
--
-- Name: serials_item_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX serials_item_number ON public.serials USING btree (item_id, serial_number);


--
-- Name: sftp_import_schedules_active; Type: INDEX; Schema: public
--
--
-- Name: sftp_import_schedules_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sftp_import_schedules_active ON public.sftp_import_schedules USING btree (org_id, is_active);


--
-- Name: sftp_servers_org_username; Type: INDEX; Schema: public
--
--
-- Name: sftp_servers_org_username; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sftp_servers_org_username ON public.sftp_servers USING btree (org_id, username);


--
-- Name: sftp_servers_username; Type: INDEX; Schema: public
--
--
-- Name: sftp_servers_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sftp_servers_username ON public.sftp_servers USING btree (username);


--
-- Name: statement_layouts_org; Type: INDEX; Schema: public
--
--
-- Name: statement_layouts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statement_layouts_org ON public.statement_layouts USING btree (org_id, statement);


--
-- Name: statements_account_date; Type: INDEX; Schema: public
--
--
-- Name: statements_account_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statements_account_date ON public.bank_statements USING btree (account_id, statement_date);


--
-- Name: stmt_lines_match_status; Type: INDEX; Schema: public
--
--
-- Name: stmt_lines_match_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stmt_lines_match_status ON public.bank_statement_lines USING btree (org_id, match_status);


--
-- Name: stmt_lines_statement; Type: INDEX; Schema: public
--
--
-- Name: stmt_lines_statement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stmt_lines_statement ON public.bank_statement_lines USING btree (statement_id);


--
-- Name: stock_locations_org_code; Type: INDEX; Schema: public
--
--
-- Name: stock_locations_org_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stock_locations_org_code ON public.stock_locations USING btree (org_id, location_id, code);


--
-- Name: subsidiaries_org_name; Type: INDEX; Schema: public
--
--
-- Name: subsidiaries_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subsidiaries_org_name ON public.subsidiaries USING btree (org_id, name);


--
-- Name: subsidiaries_org_parent; Type: INDEX; Schema: public
--
--
-- Name: subsidiaries_org_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subsidiaries_org_parent ON public.subsidiaries USING btree (org_id, parent_id);


--
-- Name: subsidiaries_org_root; Type: INDEX; Schema: public
--
--
-- Name: subsidiaries_org_root; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subsidiaries_org_root ON public.subsidiaries USING btree (org_id) WHERE (parent_id IS NULL);


--
-- Name: sync_runs_connection; Type: INDEX; Schema: public
--
--
-- Name: sync_runs_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_runs_connection ON public.sync_runs USING btree (connection_id, started_at);


--
-- Name: sync_runs_org_started; Type: INDEX; Schema: public
--
--
-- Name: sync_runs_org_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_runs_org_started ON public.sync_runs USING btree (org_id, started_at);


--
-- Name: tax_filings_org_period; Type: INDEX; Schema: public
--
--
-- Name: tax_filings_org_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_filings_org_period ON public.tax_filings USING btree (org_id, period_to DESC);


--
-- Name: tax_filings_org_status; Type: INDEX; Schema: public
--
--
-- Name: tax_filings_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_filings_org_status ON public.tax_filings USING btree (org_id, status);


--
-- Name: tax_first_year_rules_lookup; Type: INDEX; Schema: public
--
--
-- Name: tax_first_year_rules_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_first_year_rules_lookup ON public.tax_first_year_rules USING btree (org_id, regime, class_code);


--
-- Name: tax_pool_periods_identity; Type: INDEX; Schema: public
--
--
-- Name: tax_pool_periods_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tax_pool_periods_identity ON public.tax_pool_periods USING btree (org_id, pool_id, tax_year);


--
-- Name: tax_pools_identity; Type: INDEX; Schema: public
--
--
-- Name: tax_pools_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tax_pools_identity ON public.tax_depreciation_pools USING btree (org_id, book_id, subsidiary_id, regime, class_code, is_separate_class);


--
-- Name: tax_pools_org_book; Type: INDEX; Schema: public
--
--
-- Name: tax_pools_org_book; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_pools_org_book ON public.tax_depreciation_pools USING btree (org_id, book_id);


--
-- Name: tax_rates_code; Type: INDEX; Schema: public
--
--
-- Name: tax_rates_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_rates_code ON public.tax_rates USING btree (tax_code_id);


--
-- Name: tax_return_forms_org; Type: INDEX; Schema: public
--
--
-- Name: tax_return_forms_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tax_return_forms_org ON public.tax_return_forms USING btree (org_id);


--
-- Name: time_entries_employee_date; Type: INDEX; Schema: public
--
--
-- Name: time_entries_employee_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_entries_employee_date ON public.time_entries USING btree (employee_party_id, worked_on);


--
-- Name: time_entries_project; Type: INDEX; Schema: public
--
--
-- Name: time_entries_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_entries_project ON public.time_entries USING btree (project_id, is_billable);


--
-- Name: time_entries_status; Type: INDEX; Schema: public
--
--
-- Name: time_entries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_entries_status ON public.time_entries USING btree (org_id, status);


--
-- Name: user_dashboard_layouts_unique; Type: INDEX; Schema: public
--
--
-- Name: user_dashboard_layouts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_dashboard_layouts_unique ON public.user_dashboard_layouts USING btree (org_id, user_id);


--
-- Name: user_form_prefs_user_type; Type: INDEX; Schema: public
--
--
-- Name: user_form_prefs_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_form_prefs_user_type ON public.user_form_preferences USING btree (org_id, user_id, record_type);


--
-- Name: user_list_prefs_user_type; Type: INDEX; Schema: public
--
--
-- Name: user_list_prefs_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_list_prefs_user_type ON public.user_list_preferences USING btree (org_id, user_id, record_type);


--
-- Name: user_org_access_member; Type: INDEX; Schema: public
--
--
-- Name: user_org_access_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_org_access_member ON public.user_org_access USING btree (member_user_id);


--
-- Name: user_org_access_member_org; Type: INDEX; Schema: public
--
--
-- Name: user_org_access_member_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_org_access_member_org ON public.user_org_access USING btree (member_user_id, org_id);


--
-- Name: user_org_access_org; Type: INDEX; Schema: public
--
--
-- Name: user_org_access_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_org_access_org ON public.user_org_access USING btree (org_id);


--
-- Name: user_permission_overrides_org; Type: INDEX; Schema: public
--
--
-- Name: user_permission_overrides_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_permission_overrides_org ON public.user_permission_overrides USING btree (org_id);


--
-- Name: user_permission_overrides_user_permission; Type: INDEX; Schema: public
--
--
-- Name: user_permission_overrides_user_permission; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_permission_overrides_user_permission ON public.user_permission_overrides USING btree (user_id, permission);


--
-- Name: user_scripts_endpoint_slug; Type: INDEX; Schema: public
--
--
-- Name: user_scripts_endpoint_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_scripts_endpoint_slug ON public.user_scripts USING btree (org_id, endpoint_slug);


--
-- Name: user_scripts_trigger; Type: INDEX; Schema: public
--
--
-- Name: user_scripts_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_scripts_trigger ON public.user_scripts USING btree (org_id, trigger_point, document_kind, is_active);


--
-- Name: users_org_email; Type: INDEX; Schema: public
--
--
-- Name: users_org_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_org_email ON public.users USING btree (org_id, email);


--
-- Name: ap_capture_corrections ap_capture_corrections_append_only; Type: TRIGGER; Schema: public
--
--
-- Name: ap_capture_corrections ap_capture_corrections_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_corrections_append_only BEFORE DELETE OR UPDATE ON public.ap_capture_corrections FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_evidence();


--
-- Name: ap_capture_events ap_capture_events_append_only; Type: TRIGGER; Schema: public
--
--
-- Name: ap_capture_events ap_capture_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_events_append_only BEFORE DELETE OR UPDATE ON public.ap_capture_events FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_evidence();


--
-- Name: ap_capture_fields ap_capture_fields_append_only; Type: TRIGGER; Schema: public
--
--
-- Name: ap_capture_fields ap_capture_fields_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_fields_append_only BEFORE DELETE OR UPDATE ON public.ap_capture_fields FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_evidence();


--
-- Name: ap_capture_runs ap_capture_runs_immutable; Type: TRIGGER; Schema: public
--
--
-- Name: ap_capture_runs ap_capture_runs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_runs_immutable AFTER DELETE OR UPDATE ON public.ap_capture_runs FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_finished_ap_capture_run();


--
-- Name: file_blobs ap_capture_source_blob_immutable; Type: TRIGGER; Schema: public
--
--
-- Name: file_blobs ap_capture_source_blob_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_source_blob_immutable BEFORE DELETE OR UPDATE ON public.file_blobs FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_source_blob();


--
-- Name: files ap_capture_source_file_immutable; Type: TRIGGER; Schema: public
--
--
-- Name: files ap_capture_source_file_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_source_file_immutable BEFORE DELETE OR UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_source_file();


--
-- Name: file_versions ap_capture_source_version_immutable; Type: TRIGGER; Schema: public
--
--
-- Name: file_versions ap_capture_source_version_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ap_capture_source_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.file_versions FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_ap_capture_source_version();


--
-- Name: applications application_open_balance; Type: TRIGGER; Schema: public
--
--
-- Name: applications application_open_balance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER application_open_balance AFTER INSERT OR DELETE OR UPDATE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.trg_application_open_balance();


--
-- Name: budget_lines budget_line_guard; Type: TRIGGER; Schema: public
--
--
-- Name: budget_lines budget_line_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER budget_line_guard BEFORE INSERT OR DELETE OR UPDATE ON public.budget_lines FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_budget_line();


--
-- Name: budget_scenarios budget_scenario_guard; Type: TRIGGER; Schema: public
--
--
-- Name: budget_scenarios budget_scenario_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER budget_scenario_guard BEFORE INSERT OR DELETE OR UPDATE ON public.budget_scenarios FOR EACH ROW EXECUTE FUNCTION public.openbooks_guard_budget_scenario();


--
-- Name: document_lines document_lines_extra_dims_guard; Type: TRIGGER; Schema: public
--
--
-- Name: document_lines document_lines_extra_dims_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_lines_extra_dims_guard BEFORE INSERT OR UPDATE OF org_id, extra_dims ON public.document_lines FOR EACH ROW EXECUTE FUNCTION public.row_extra_dims_guard();


--
-- Name: documents document_open_balance; Type: TRIGGER; Schema: public
--
--
-- Name: documents document_open_balance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER document_open_balance AFTER UPDATE OF posted_entry_id, status ON public.documents FOR EACH ROW WHEN (((pg_trigger_depth() = 0) AND ((new.posted_entry_id IS DISTINCT FROM old.posted_entry_id) OR (new.status IS DISTINCT FROM old.status)))) EXECUTE FUNCTION public.trg_document_open_balance();


--
-- Name: documents documents_extra_dims_guard; Type: TRIGGER; Schema: public
--
--
-- Name: documents documents_extra_dims_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER documents_extra_dims_guard BEFORE INSERT OR UPDATE OF org_id, extra_dims ON public.documents FOR EACH ROW EXECUTE FUNCTION public.row_extra_dims_guard();


--
-- Name: intercompany_pairs intercompany_pair_guard; Type: TRIGGER; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pair_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER intercompany_pair_guard BEFORE INSERT OR UPDATE ON public.intercompany_pairs FOR EACH ROW EXECUTE FUNCTION public.intercompany_pair_guard();


--
-- Name: journal_lines jl_balanced_by_subsidiary; Type: TRIGGER; Schema: public
--
--
-- Name: journal_lines jl_balanced_by_subsidiary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER jl_balanced_by_subsidiary AFTER INSERT OR DELETE OR UPDATE ON public.journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.jl_check_balanced_by_subsidiary();


--
-- Name: journal_lines journal_lines_extra_dims_guard; Type: TRIGGER; Schema: public
--
--
-- Name: journal_lines journal_lines_extra_dims_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER journal_lines_extra_dims_guard BEFORE INSERT OR UPDATE OF org_id, extra_dims ON public.journal_lines FOR EACH ROW EXECUTE FUNCTION public.row_extra_dims_guard();


--
-- Name: party_subsidiaries party_subsidiary_guard; Type: TRIGGER; Schema: public
--
--
-- Name: party_subsidiaries party_subsidiary_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER party_subsidiary_guard BEFORE INSERT OR UPDATE ON public.party_subsidiaries FOR EACH ROW EXECUTE FUNCTION public.party_subsidiary_guard();


--
-- Name: orgs seed_builtin_segments_on_org_insert; Type: TRIGGER; Schema: public
--
--
-- Name: orgs seed_builtin_segments_on_org_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER seed_builtin_segments_on_org_insert AFTER INSERT ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.seed_builtin_segments_on_org_insert();


--
-- Name: segment_definitions segment_definition_guard; Type: TRIGGER; Schema: public
--
--
-- Name: segment_definitions segment_definition_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER segment_definition_guard BEFORE DELETE OR UPDATE ON public.segment_definitions FOR EACH ROW EXECUTE FUNCTION public.segment_definition_guard();


--
-- Name: segment_values segment_value_guard; Type: TRIGGER; Schema: public
--
--
-- Name: segment_values segment_value_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER segment_value_guard BEFORE INSERT OR UPDATE ON public.segment_values FOR EACH ROW EXECUTE FUNCTION public.segment_value_guard();


--
-- Name: accounts subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: accounts subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: classes subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: classes subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.classes FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: departments subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: departments subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.departments FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: document_lines subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: document_lines subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.document_lines FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: documents subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: documents subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.documents FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: fixed_assets subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: fixed_assets subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.fixed_assets FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: journal_entries subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: journal_entries subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: journal_lines subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: journal_lines subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.journal_lines FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: locations subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: locations subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.locations FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: number_sequences subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: number_sequences subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.number_sequences FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: parties subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: parties subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.parties FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: projects subsidiary_ref_guard; Type: TRIGGER; Schema: public
--
--
-- Name: projects subsidiary_ref_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_ref_guard BEFORE INSERT OR UPDATE OF subsidiary_id, org_id ON public.projects FOR EACH ROW EXECUTE FUNCTION public.subsidiary_ref_guard();


--
-- Name: subsidiaries subsidiary_tree_guard; Type: TRIGGER; Schema: public
--
--
-- Name: subsidiaries subsidiary_tree_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subsidiary_tree_guard BEFORE INSERT OR DELETE OR UPDATE ON public.subsidiaries FOR EACH ROW EXECUTE FUNCTION public.subsidiary_tree_guard();


--
-- Name: accounting_periods accounting_periods_fiscal_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: accounting_periods accounting_periods_fiscal_calendar_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounting_periods
    ADD CONSTRAINT accounting_periods_fiscal_calendar_id_fkey FOREIGN KEY (fiscal_calendar_id) REFERENCES public.fiscal_calendars(id) DEFERRABLE;


--
-- Name: accounts accounts_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: accounts accounts_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: budget_lines budget_lines_class_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_class_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_class_fk FOREIGN KEY (class_id) REFERENCES public.classes(id) DEFERRABLE;


--
-- Name: budget_lines budget_lines_department_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_department_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_department_fk FOREIGN KEY (department_id) REFERENCES public.departments(id) DEFERRABLE;


--
-- Name: budget_lines budget_lines_location_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_location_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_location_fk FOREIGN KEY (location_id) REFERENCES public.locations(id) DEFERRABLE;


--
-- Name: budget_lines budget_lines_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: budget_lines budget_lines_project_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) DEFERRABLE;


--
-- Name: budget_lines budget_lines_scenario_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_lines budget_lines_scenario_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_lines
    ADD CONSTRAINT budget_lines_scenario_fk FOREIGN KEY (scenario_id) REFERENCES public.budget_scenarios(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: budget_scenarios budget_scenarios_approved_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_scenarios budget_scenarios_approved_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_scenarios
    ADD CONSTRAINT budget_scenarios_approved_by_fk FOREIGN KEY (approved_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: budget_scenarios budget_scenarios_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_scenarios budget_scenarios_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_scenarios
    ADD CONSTRAINT budget_scenarios_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: budget_scenarios budget_scenarios_submitted_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: budget_scenarios budget_scenarios_submitted_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.budget_scenarios
    ADD CONSTRAINT budget_scenarios_submitted_by_fk FOREIGN KEY (submitted_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: classes classes_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: classes classes_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: close_automation_executions close_automation_executions_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_automation_executions close_automation_executions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_executions
    ADD CONSTRAINT close_automation_executions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_automation_executions close_automation_executions_rule_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_automation_executions close_automation_executions_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_executions
    ADD CONSTRAINT close_automation_executions_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.close_automation_rules(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_automation_executions close_automation_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_automation_executions close_automation_executions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_executions
    ADD CONSTRAINT close_automation_executions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_automation_executions close_automation_executions_task_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_automation_executions close_automation_executions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_executions
    ADD CONSTRAINT close_automation_executions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.close_run_tasks(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: close_automation_rules close_automation_rules_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_automation_rules close_automation_rules_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_automation_rules
    ADD CONSTRAINT close_automation_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_dependencies
    ADD CONSTRAINT close_blueprint_dependencies_blueprint_id_fkey FOREIGN KEY (blueprint_id) REFERENCES public.close_blueprints(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_depends_on_step_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_depends_on_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_dependencies
    ADD CONSTRAINT close_blueprint_dependencies_depends_on_step_id_fkey FOREIGN KEY (depends_on_step_id) REFERENCES public.close_blueprint_steps(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_dependencies
    ADD CONSTRAINT close_blueprint_dependencies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_step_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_dependencies close_blueprint_dependencies_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_dependencies
    ADD CONSTRAINT close_blueprint_dependencies_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.close_blueprint_steps(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_steps close_blueprint_steps_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_steps close_blueprint_steps_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_steps
    ADD CONSTRAINT close_blueprint_steps_blueprint_id_fkey FOREIGN KEY (blueprint_id) REFERENCES public.close_blueprints(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprint_steps close_blueprint_steps_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprint_steps close_blueprint_steps_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprint_steps
    ADD CONSTRAINT close_blueprint_steps_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_blueprints close_blueprints_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_blueprints close_blueprints_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_blueprints
    ADD CONSTRAINT close_blueprints_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_events close_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_events close_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_events
    ADD CONSTRAINT close_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_events close_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_events close_events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_events
    ADD CONSTRAINT close_events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_events close_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_events close_events_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_events
    ADD CONSTRAINT close_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_events close_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_events close_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_events
    ADD CONSTRAINT close_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.close_run_tasks(id) DEFERRABLE;


--
-- Name: close_exceptions close_exceptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_exceptions close_exceptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_exceptions
    ADD CONSTRAINT close_exceptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_exceptions close_exceptions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_exceptions close_exceptions_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_exceptions
    ADD CONSTRAINT close_exceptions_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_exceptions close_exceptions_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_exceptions close_exceptions_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_exceptions
    ADD CONSTRAINT close_exceptions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_exceptions close_exceptions_task_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_exceptions close_exceptions_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_exceptions
    ADD CONSTRAINT close_exceptions_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.close_run_tasks(id) DEFERRABLE;


--
-- Name: close_policies close_policies_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_policies close_policies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_policies
    ADD CONSTRAINT close_policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_book_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_book_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.accounting_books(id) DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_period_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.accounting_periods(id) DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_reopen_requests close_reopen_requests_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reopen_requests close_reopen_requests_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reopen_requests
    ADD CONSTRAINT close_reopen_requests_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: close_reporting_packages close_reporting_packages_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_reporting_packages close_reporting_packages_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_reporting_packages
    ADD CONSTRAINT close_reporting_packages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_blueprint_step_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_blueprint_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_blueprint_step_id_fkey FOREIGN KEY (blueprint_step_id) REFERENCES public.close_blueprint_steps(id) DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_owner_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_run_tasks close_run_tasks_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_run_tasks close_run_tasks_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_run_tasks
    ADD CONSTRAINT close_run_tasks_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_runs close_runs_approved_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_runs close_runs_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_blueprint_id_fkey FOREIGN KEY (blueprint_id) REFERENCES public.close_blueprints(id) DEFERRABLE;


--
-- Name: close_runs close_runs_book_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_book_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.accounting_books(id) DEFERRABLE;


--
-- Name: close_runs close_runs_closed_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_runs close_runs_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_runs close_runs_period_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.accounting_periods(id) DEFERRABLE;


--
-- Name: close_runs close_runs_published_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_runs close_runs_reporting_package_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_reporting_package_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_reporting_package_id_fkey FOREIGN KEY (reporting_package_id) REFERENCES public.close_reporting_packages(id) DEFERRABLE;


--
-- Name: close_runs close_runs_started_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_runs close_runs_started_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_runs
    ADD CONSTRAINT close_runs_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_signoffs close_signoffs_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_signoffs close_signoffs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_signoffs
    ADD CONSTRAINT close_signoffs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_signoffs close_signoffs_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_signoffs close_signoffs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_signoffs
    ADD CONSTRAINT close_signoffs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_signoffs close_signoffs_signed_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_signoffs close_signoffs_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_signoffs
    ADD CONSTRAINT close_signoffs_signed_by_fkey FOREIGN KEY (signed_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: close_signoffs close_signoffs_task_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_signoffs close_signoffs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_signoffs
    ADD CONSTRAINT close_signoffs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.close_run_tasks(id) DEFERRABLE;


--
-- Name: close_task_evidence close_task_evidence_file_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_task_evidence close_task_evidence_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_task_evidence
    ADD CONSTRAINT close_task_evidence_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) DEFERRABLE;


--
-- Name: close_task_evidence close_task_evidence_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_task_evidence close_task_evidence_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_task_evidence
    ADD CONSTRAINT close_task_evidence_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_task_evidence close_task_evidence_run_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_task_evidence close_task_evidence_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_task_evidence
    ADD CONSTRAINT close_task_evidence_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.close_runs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: close_task_evidence close_task_evidence_task_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: close_task_evidence close_task_evidence_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.close_task_evidence
    ADD CONSTRAINT close_task_evidence_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.close_run_tasks(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: consolidated_fx_rates consolidated_fx_rates_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: consolidated_fx_rates consolidated_fx_rates_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidated_fx_rates
    ADD CONSTRAINT consolidated_fx_rates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: consolidated_fx_rates consolidated_fx_rates_period_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: consolidated_fx_rates consolidated_fx_rates_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidated_fx_rates
    ADD CONSTRAINT consolidated_fx_rates_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.accounting_periods(id) DEFERRABLE;


--
-- Name: crm_account_assignment_events crm_account_assignment_events_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_assignment_events crm_account_assignment_events_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_assignment_events
    ADD CONSTRAINT crm_account_assignment_events_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_assignment_events crm_account_assignment_events_profile_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_assignment_events crm_account_assignment_events_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_assignment_events
    ADD CONSTRAINT crm_account_assignment_events_profile_fk FOREIGN KEY (account_profile_id) REFERENCES public.crm_account_profiles(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_party_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_party_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_party_fk FOREIGN KEY (party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_source_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_source_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_source_fk FOREIGN KEY (lead_source_id) REFERENCES public.crm_lead_sources(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_status_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_status_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_status_fk FOREIGN KEY (status_id) REFERENCES public.crm_account_statuses(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_account_profiles crm_account_profiles_territory_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_territory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_profiles
    ADD CONSTRAINT crm_account_profiles_territory_fk FOREIGN KEY (territory_id) REFERENCES public.crm_sales_territories(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_account_stage_events crm_account_stage_events_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_stage_events crm_account_stage_events_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_stage_events
    ADD CONSTRAINT crm_account_stage_events_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_stage_events crm_account_stage_events_profile_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_stage_events crm_account_stage_events_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_stage_events
    ADD CONSTRAINT crm_account_stage_events_profile_fk FOREIGN KEY (account_profile_id) REFERENCES public.crm_account_profiles(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_account_statuses crm_account_statuses_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_account_statuses crm_account_statuses_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_account_statuses
    ADD CONSTRAINT crm_account_statuses_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activities crm_activities_assignee_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activities crm_activities_assignee_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_assignee_fk FOREIGN KEY (assigned_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_activities crm_activities_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activities crm_activities_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activities crm_activities_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activities crm_activities_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_activity_links crm_activity_links_activity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_links crm_activity_links_activity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_links
    ADD CONSTRAINT crm_activity_links_activity_fk FOREIGN KEY (activity_id) REFERENCES public.crm_activities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activity_links crm_activity_links_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_links crm_activity_links_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_links
    ADD CONSTRAINT crm_activity_links_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activity_participants crm_activity_participants_activity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_activity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_participants
    ADD CONSTRAINT crm_activity_participants_activity_fk FOREIGN KEY (activity_id) REFERENCES public.crm_activities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activity_participants crm_activity_participants_contact_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_participants
    ADD CONSTRAINT crm_activity_participants_contact_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activity_participants crm_activity_participants_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_participants
    ADD CONSTRAINT crm_activity_participants_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_activity_participants crm_activity_participants_user_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activity_participants
    ADD CONSTRAINT crm_activity_participants_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_forecast_snapshots
    ADD CONSTRAINT crm_forecast_snapshots_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_forecast_snapshots
    ADD CONSTRAINT crm_forecast_snapshots_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_team_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_team_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_forecast_snapshots
    ADD CONSTRAINT crm_forecast_snapshots_team_fk FOREIGN KEY (sales_team_id) REFERENCES public.crm_sales_teams(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_lead_sources crm_lead_sources_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_lead_sources crm_lead_sources_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_sources
    ADD CONSTRAINT crm_lead_sources_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_lead_sources crm_lead_sources_parent_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_lead_sources crm_lead_sources_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_sources
    ADD CONSTRAINT crm_lead_sources_parent_fk FOREIGN KEY (parent_id) REFERENCES public.crm_lead_sources(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_class_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_class_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_class_fk FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_contact_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_contact_fk FOREIGN KEY (primary_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_department_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_department_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_department_fk FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_location_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_location_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_location_fk FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_party_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_party_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_party_fk FOREIGN KEY (party_id) REFERENCES public.parties(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_source_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_source_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_source_fk FOREIGN KEY (lead_source_id) REFERENCES public.crm_lead_sources(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_status_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_status_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_status_fk FOREIGN KEY (status_id) REFERENCES public.crm_opportunity_statuses(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_subsidiary_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_subsidiary_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_subsidiary_fk FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunities crm_opportunities_team_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_team_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunities
    ADD CONSTRAINT crm_opportunities_team_fk FOREIGN KEY (sales_team_id) REFERENCES public.crm_sales_teams(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_opportunity_documents crm_opportunity_documents_document_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_documents crm_opportunity_documents_document_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_documents
    ADD CONSTRAINT crm_opportunity_documents_document_fk FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_documents crm_opportunity_documents_opportunity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_documents crm_opportunity_documents_opportunity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_documents
    ADD CONSTRAINT crm_opportunity_documents_opportunity_fk FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_documents crm_opportunity_documents_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_documents crm_opportunity_documents_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_documents
    ADD CONSTRAINT crm_opportunity_documents_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_lines crm_opportunity_lines_item_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_lines crm_opportunity_lines_item_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_lines
    ADD CONSTRAINT crm_opportunity_lines_item_fk FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunity_lines crm_opportunity_lines_opportunity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_lines crm_opportunity_lines_opportunity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_lines
    ADD CONSTRAINT crm_opportunity_lines_opportunity_fk FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_lines crm_opportunity_lines_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_lines crm_opportunity_lines_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_lines
    ADD CONSTRAINT crm_opportunity_lines_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_from_status_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_from_status_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_stage_events
    ADD CONSTRAINT crm_opportunity_stage_events_from_status_fk FOREIGN KEY (from_status_id) REFERENCES public.crm_opportunity_statuses(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_opportunity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_opportunity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_stage_events
    ADD CONSTRAINT crm_opportunity_stage_events_opportunity_fk FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_stage_events
    ADD CONSTRAINT crm_opportunity_stage_events_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_to_status_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_to_status_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_stage_events
    ADD CONSTRAINT crm_opportunity_stage_events_to_status_fk FOREIGN KEY (to_status_id) REFERENCES public.crm_opportunity_statuses(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_statuses
    ADD CONSTRAINT crm_opportunity_statuses_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_opportunity_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_opportunity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_team_members
    ADD CONSTRAINT crm_opportunity_team_members_opportunity_fk FOREIGN KEY (opportunity_id) REFERENCES public.crm_opportunities(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_team_members
    ADD CONSTRAINT crm_opportunity_team_members_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_user_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_opportunity_team_members
    ADD CONSTRAINT crm_opportunity_team_members_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_sales_quotas crm_sales_quotas_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_quotas crm_sales_quotas_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_quotas
    ADD CONSTRAINT crm_sales_quotas_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_quotas crm_sales_quotas_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_quotas crm_sales_quotas_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_quotas
    ADD CONSTRAINT crm_sales_quotas_owner_fk FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_sales_quotas crm_sales_quotas_team_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_quotas crm_sales_quotas_team_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_quotas
    ADD CONSTRAINT crm_sales_quotas_team_fk FOREIGN KEY (sales_team_id) REFERENCES public.crm_sales_teams(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_sales_team_members crm_sales_team_members_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_team_members crm_sales_team_members_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_team_members
    ADD CONSTRAINT crm_sales_team_members_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_team_members crm_sales_team_members_team_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_team_members crm_sales_team_members_team_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_team_members
    ADD CONSTRAINT crm_sales_team_members_team_fk FOREIGN KEY (team_id) REFERENCES public.crm_sales_teams(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_team_members crm_sales_team_members_user_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_team_members crm_sales_team_members_user_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_team_members
    ADD CONSTRAINT crm_sales_team_members_user_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_teams crm_sales_teams_manager_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_teams crm_sales_teams_manager_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_teams
    ADD CONSTRAINT crm_sales_teams_manager_fk FOREIGN KEY (manager_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_sales_teams crm_sales_teams_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_teams crm_sales_teams_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_teams
    ADD CONSTRAINT crm_sales_teams_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_teams crm_sales_teams_parent_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_teams crm_sales_teams_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_teams
    ADD CONSTRAINT crm_sales_teams_parent_fk FOREIGN KEY (parent_team_id) REFERENCES public.crm_sales_teams(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: crm_sales_territories crm_sales_territories_manager_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_manager_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_territories
    ADD CONSTRAINT crm_sales_territories_manager_fk FOREIGN KEY (manager_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_sales_territories crm_sales_territories_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_territories
    ADD CONSTRAINT crm_sales_territories_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: crm_sales_territories crm_sales_territories_owner_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_territories
    ADD CONSTRAINT crm_sales_territories_owner_fk FOREIGN KEY (default_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;


--
-- Name: crm_sales_territories crm_sales_territories_parent_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sales_territories
    ADD CONSTRAINT crm_sales_territories_parent_fk FOREIGN KEY (parent_id) REFERENCES public.crm_sales_territories(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: depreciation_book_policies dbp_book_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: depreciation_book_policies dbp_book_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_book_policies
    ADD CONSTRAINT dbp_book_fk FOREIGN KEY (book_id) REFERENCES public.accounting_books(id) DEFERRABLE;


--
-- Name: depreciation_book_policies dbp_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: depreciation_book_policies dbp_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_book_policies
    ADD CONSTRAINT dbp_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: depreciation_methods dep_methods_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: depreciation_methods dep_methods_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depreciation_methods
    ADD CONSTRAINT dep_methods_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: departments departments_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: departments departments_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: document_lines document_lines_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: document_lines document_lines_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_lines
    ADD CONSTRAINT document_lines_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: documents documents_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: documents documents_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: fiscal_calendars fiscal_calendars_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: fiscal_calendars fiscal_calendars_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fiscal_calendars
    ADD CONSTRAINT fiscal_calendars_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: fixed_assets fixed_assets_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: fixed_assets fixed_assets_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fixed_assets
    ADD CONSTRAINT fixed_assets_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: fx_rates fx_rates_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: fx_rates fx_rates_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT fx_rates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: intercompany_pairs intercompany_pairs_due_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_due_from_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_due_from_account_id_fkey FOREIGN KEY (due_from_account_id) REFERENCES public.accounts(id) DEFERRABLE;


--
-- Name: intercompany_pairs intercompany_pairs_due_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_due_to_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_due_to_account_id_fkey FOREIGN KEY (due_to_account_id) REFERENCES public.accounts(id) DEFERRABLE;


--
-- Name: intercompany_pairs intercompany_pairs_from_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_from_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_from_subsidiary_id_fkey FOREIGN KEY (from_subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: intercompany_pairs intercompany_pairs_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: intercompany_pairs intercompany_pairs_to_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: intercompany_pairs intercompany_pairs_to_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intercompany_pairs
    ADD CONSTRAINT intercompany_pairs_to_subsidiary_id_fkey FOREIGN KEY (to_subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: journal_entries journal_entries_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: journal_entries journal_entries_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_entries
    ADD CONSTRAINT journal_entries_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: journal_lines journal_lines_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: journal_lines journal_lines_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.journal_lines
    ADD CONSTRAINT journal_lines_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: locations locations_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: locations locations_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locations
    ADD CONSTRAINT locations_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: number_sequences number_sequences_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: number_sequences number_sequences_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.number_sequences
    ADD CONSTRAINT number_sequences_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: parties parties_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: parties parties_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: party_subsidiaries party_subsidiaries_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: party_subsidiaries party_subsidiaries_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_subsidiaries
    ADD CONSTRAINT party_subsidiaries_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: party_subsidiaries party_subsidiaries_party_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: party_subsidiaries party_subsidiaries_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_subsidiaries
    ADD CONSTRAINT party_subsidiaries_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: party_subsidiaries party_subsidiaries_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: party_subsidiaries party_subsidiaries_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.party_subsidiaries
    ADD CONSTRAINT party_subsidiaries_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: period_locks period_locks_book_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_book_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_book_id_fkey FOREIGN KEY (book_id) REFERENCES public.accounting_books(id) DEFERRABLE;


--
-- Name: period_locks period_locks_locked_by_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: period_locks period_locks_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: period_locks period_locks_period_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.accounting_periods(id) DEFERRABLE;


--
-- Name: period_locks period_locks_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: period_locks period_locks_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: projects projects_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: projects projects_subsidiary_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_subsidiary_id_fkey FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: segment_definitions segment_definitions_created_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_definitions segment_definitions_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_definitions
    ADD CONSTRAINT segment_definitions_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: segment_definitions segment_definitions_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_definitions segment_definitions_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_definitions
    ADD CONSTRAINT segment_definitions_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: segment_definitions segment_definitions_updated_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_definitions segment_definitions_updated_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_definitions
    ADD CONSTRAINT segment_definitions_updated_by_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: segment_values segment_values_created_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_created_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_created_by_fk FOREIGN KEY (created_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: segment_values segment_values_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: segment_values segment_values_parent_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_parent_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_parent_fk FOREIGN KEY (parent_id) REFERENCES public.segment_values(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: segment_values segment_values_segment_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_segment_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_segment_fk FOREIGN KEY (segment_id) REFERENCES public.segment_definitions(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: segment_values segment_values_subsidiary_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_subsidiary_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_subsidiary_fk FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) ON DELETE RESTRICT DEFERRABLE;


--
-- Name: segment_values segment_values_updated_by_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: segment_values segment_values_updated_by_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.segment_values
    ADD CONSTRAINT segment_values_updated_by_fk FOREIGN KEY (updated_by) REFERENCES public.users(id) DEFERRABLE;


--
-- Name: subsidiaries subsidiaries_org_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: subsidiaries subsidiaries_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subsidiaries
    ADD CONSTRAINT subsidiaries_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;


--
-- Name: subsidiaries subsidiaries_parent_id_fkey; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: subsidiaries subsidiaries_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subsidiaries
    ADD CONSTRAINT subsidiaries_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.subsidiaries(id) DEFERRABLE;


--
-- Name: tax_first_year_rules tax_fyr_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: tax_first_year_rules tax_fyr_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_first_year_rules
    ADD CONSTRAINT tax_fyr_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: tax_pool_periods tax_pool_periods_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: tax_pool_periods tax_pool_periods_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_pool_periods
    ADD CONSTRAINT tax_pool_periods_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: tax_pool_periods tax_pool_periods_pool_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: tax_pool_periods tax_pool_periods_pool_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_pool_periods
    ADD CONSTRAINT tax_pool_periods_pool_fk FOREIGN KEY (pool_id) REFERENCES public.tax_depreciation_pools(id) DEFERRABLE;


--
-- Name: tax_depreciation_pools tax_pools_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: tax_depreciation_pools tax_pools_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_depreciation_pools
    ADD CONSTRAINT tax_pools_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: tax_return_forms tax_return_forms_org_fk; Type: FK CONSTRAINT; Schema: public
--
--
-- Name: tax_return_forms tax_return_forms_org_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_return_forms
    ADD CONSTRAINT tax_return_forms_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;


--
-- Name: account_group_members; Type: ROW SECURITY; Schema: public
--
--
-- Name: account_group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: account_groups; Type: ROW SECURITY; Schema: public
--
--
-- Name: account_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: accounting_books; Type: ROW SECURITY; Schema: public
--
--
-- Name: accounting_books; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounting_books ENABLE ROW LEVEL SECURITY;

--
-- Name: accounting_periods; Type: ROW SECURITY; Schema: public
--
--
-- Name: accounting_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts; Type: ROW SECURITY; Schema: public
--
--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: addresses; Type: ROW SECURITY; Schema: public
--
--
-- Name: addresses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_policies; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_agent_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_agent_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_conversations; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_messages; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_work_item_evidence; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_work_item_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_work_item_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_work_item_feedback; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_work_item_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_work_item_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_work_items; Type: ROW SECURITY; Schema: public
--
--
-- Name: ai_work_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_work_items ENABLE ROW LEVEL SECURITY;

--
-- Name: allocation_rule_targets; Type: ROW SECURITY; Schema: public
--
--
-- Name: allocation_rule_targets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allocation_rule_targets ENABLE ROW LEVEL SECURITY;

--
-- Name: allocation_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: allocation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allocation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: allocation_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: allocation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allocation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_corrections; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_events ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_fields; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_items; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_items ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_capture_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: ap_capture_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_capture_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: api_key_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: api_key_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_key_events ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public
--
--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: app_files; Type: ROW SECURITY; Schema: public
--
--
-- Name: app_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_files ENABLE ROW LEVEL SECURITY;

--
-- Name: app_roles; Type: ROW SECURITY; Schema: public
--
--
-- Name: app_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: app_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: app_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: app_storage; Type: ROW SECURITY; Schema: public
--
--
-- Name: app_storage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_storage ENABLE ROW LEVEL SECURITY;

--
-- Name: app_versions; Type: ROW SECURITY; Schema: public
--
--
-- Name: app_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: applications; Type: ROW SECURITY; Schema: public
--
--
-- Name: applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_delegations; Type: ROW SECURITY; Schema: public
--
--
-- Name: approval_delegations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_delegations ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_policies; Type: ROW SECURITY; Schema: public
--
--
-- Name: approval_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public
--
--
-- Name: approval_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_steps; Type: ROW SECURITY; Schema: public
--
--
-- Name: approval_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: apps; Type: ROW SECURITY; Schema: public
--
--
-- Name: apps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.apps ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_categories; Type: ROW SECURITY; Schema: public
--
--
-- Name: asset_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: asset_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: asset_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_events ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public
--
--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_match_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: bank_match_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_match_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_statement_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: bank_statement_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_statement_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_statements; Type: ROW SECURITY; Schema: public
--
--
-- Name: bank_statements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_statements ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_requests; Type: ROW SECURITY; Schema: public
--
--
-- Name: billing_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: billing_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: bom_components; Type: ROW SECURITY; Schema: public
--
--
-- Name: bom_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bom_components ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: budget_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: budget_scenarios; Type: ROW SECURITY; Schema: public
--
--
-- Name: budget_scenarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.budget_scenarios ENABLE ROW LEVEL SECURITY;

--
-- Name: change_set_items; Type: ROW SECURITY; Schema: public
--
--
-- Name: change_set_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_set_items ENABLE ROW LEVEL SECURITY;

--
-- Name: change_sets; Type: ROW SECURITY; Schema: public
--
--
-- Name: change_sets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.change_sets ENABLE ROW LEVEL SECURITY;

--
-- Name: classes; Type: ROW SECURITY; Schema: public
--
--
-- Name: classes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

--
-- Name: close_automation_executions; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_automation_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_automation_executions ENABLE ROW LEVEL SECURITY;

--
-- Name: close_automation_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_automation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_automation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: close_blueprint_dependencies; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_blueprint_dependencies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_blueprint_dependencies ENABLE ROW LEVEL SECURITY;

--
-- Name: close_blueprint_steps; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_blueprint_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_blueprint_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: close_blueprints; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_blueprints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_blueprints ENABLE ROW LEVEL SECURITY;

--
-- Name: close_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_events ENABLE ROW LEVEL SECURITY;

--
-- Name: close_exceptions; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: close_policies; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: close_reopen_requests; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_reopen_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_reopen_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: close_reporting_packages; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_reporting_packages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_reporting_packages ENABLE ROW LEVEL SECURITY;

--
-- Name: close_run_tasks; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_run_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_run_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: close_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: close_signoffs; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_signoffs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_signoffs ENABLE ROW LEVEL SECURITY;

--
-- Name: close_task_evidence; Type: ROW SECURITY; Schema: public
--
--
-- Name: close_task_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.close_task_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: connections; Type: ROW SECURITY; Schema: public
--
--
-- Name: connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

--
-- Name: consolidated_fx_rates; Type: ROW SECURITY; Schema: public
--
--
-- Name: consolidated_fx_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consolidated_fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public
--
--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_layer_consumptions; Type: ROW SECURITY; Schema: public
--
--
-- Name: cost_layer_consumptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_layer_consumptions ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_layers; Type: ROW SECURITY; Schema: public
--
--
-- Name: cost_layers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_layers ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_account_assignment_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_account_assignment_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_account_assignment_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_account_assignment_events crm_account_assignment_events_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_assignment_events crm_account_assignment_events_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_account_assignment_events_org_isolation ON public.crm_account_assignment_events USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_account_profiles; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_account_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_account_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_account_profiles crm_account_profiles_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_profiles crm_account_profiles_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_account_profiles_org_isolation ON public.crm_account_profiles USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_account_stage_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_account_stage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_account_stage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_account_stage_events crm_account_stage_events_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_stage_events crm_account_stage_events_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_account_stage_events_org_isolation ON public.crm_account_stage_events USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_account_statuses; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_account_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_account_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_account_statuses crm_account_statuses_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_statuses crm_account_statuses_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_account_statuses_org_isolation ON public.crm_account_statuses USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_activities; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_activities crm_activities_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activities crm_activities_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_activities_org_isolation ON public.crm_activities USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_activity_links; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_activity_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_activity_links ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_activity_links crm_activity_links_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activity_links crm_activity_links_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_activity_links_org_isolation ON public.crm_activity_links USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_activity_participants; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_activity_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_activity_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_activity_participants crm_activity_participants_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activity_participants crm_activity_participants_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_activity_participants_org_isolation ON public.crm_activity_participants USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_forecast_snapshots; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_forecast_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_forecast_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_forecast_snapshots crm_forecast_snapshots_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_forecast_snapshots_org_isolation ON public.crm_forecast_snapshots USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_lead_sources; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_lead_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_lead_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_lead_sources crm_lead_sources_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_lead_sources crm_lead_sources_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_lead_sources_org_isolation ON public.crm_lead_sources USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunities; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunities ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunities crm_opportunities_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunities crm_opportunities_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunities_org_isolation ON public.crm_opportunities USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunity_documents; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunity_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunity_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunity_documents crm_opportunity_documents_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_documents crm_opportunity_documents_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunity_documents_org_isolation ON public.crm_opportunity_documents USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunity_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunity_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunity_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunity_lines crm_opportunity_lines_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_lines crm_opportunity_lines_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunity_lines_org_isolation ON public.crm_opportunity_lines USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunity_stage_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunity_stage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunity_stage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_stage_events crm_opportunity_stage_events_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunity_stage_events_org_isolation ON public.crm_opportunity_stage_events USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunity_statuses; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunity_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunity_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_statuses crm_opportunity_statuses_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunity_statuses_org_isolation ON public.crm_opportunity_statuses USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_opportunity_team_members; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_opportunity_team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_opportunity_team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_team_members crm_opportunity_team_members_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_opportunity_team_members_org_isolation ON public.crm_opportunity_team_members USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sales_quotas; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_sales_quotas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sales_quotas ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sales_quotas crm_sales_quotas_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_quotas crm_sales_quotas_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sales_quotas_org_isolation ON public.crm_sales_quotas USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sales_team_members; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_sales_team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sales_team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sales_team_members crm_sales_team_members_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_team_members crm_sales_team_members_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sales_team_members_org_isolation ON public.crm_sales_team_members USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sales_teams; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_sales_teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sales_teams ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sales_teams crm_sales_teams_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_teams crm_sales_teams_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sales_teams_org_isolation ON public.crm_sales_teams USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: crm_sales_territories; Type: ROW SECURITY; Schema: public
--
--
-- Name: crm_sales_territories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sales_territories ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sales_territories crm_sales_territories_org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_territories crm_sales_territories_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY crm_sales_territories_org_isolation ON public.crm_sales_territories USING ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid)) WITH CHECK ((org_id = (NULLIF(current_setting('openbooks.org_id'::text, true), ''::text))::uuid));


--
-- Name: custom_field_defs; Type: ROW SECURITY; Schema: public
--
--
-- Name: custom_field_defs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_field_defs ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_record_types; Type: ROW SECURITY; Schema: public
--
--
-- Name: custom_record_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_record_types ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_records; Type: ROW SECURITY; Schema: public
--
--
-- Name: custom_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_records ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_roles; Type: ROW SECURITY; Schema: public
--
--
-- Name: customer_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: departments; Type: ROW SECURITY; Schema: public
--
--
-- Name: departments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

--
-- Name: depreciation_book_policies; Type: ROW SECURITY; Schema: public
--
--
-- Name: depreciation_book_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.depreciation_book_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: depreciation_methods; Type: ROW SECURITY; Schema: public
--
--
-- Name: depreciation_methods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.depreciation_methods ENABLE ROW LEVEL SECURITY;

--
-- Name: depreciation_schedule_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: depreciation_schedule_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.depreciation_schedule_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: depreciation_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: depreciation_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.depreciation_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: document_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: document_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: document_links; Type: ROW SECURITY; Schema: public
--
--
-- Name: document_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;

--
-- Name: documents; Type: ROW SECURITY; Schema: public
--
--
-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log; Type: ROW SECURITY; Schema: public
--
--
-- Name: email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_roles; Type: ROW SECURITY; Schema: public
--
--
-- Name: employee_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: fair_value_prices; Type: ROW SECURITY; Schema: public
--
--
-- Name: fair_value_prices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fair_value_prices ENABLE ROW LEVEL SECURITY;

--
-- Name: file_attachments; Type: ROW SECURITY; Schema: public
--
--
-- Name: file_attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.file_attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: files; Type: ROW SECURITY; Schema: public
--
--
-- Name: files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

--
-- Name: fiscal_calendars; Type: ROW SECURITY; Schema: public
--
--
-- Name: fiscal_calendars; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fiscal_calendars ENABLE ROW LEVEL SECURITY;

--
-- Name: fixed_assets; Type: ROW SECURITY; Schema: public
--
--
-- Name: fixed_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fixed_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_gates; Type: ROW SECURITY; Schema: public
--
--
-- Name: flow_gates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flow_gates ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_locks; Type: ROW SECURITY; Schema: public
--
--
-- Name: flow_locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flow_locks ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_run_effects; Type: ROW SECURITY; Schema: public
--
--
-- Name: flow_run_effects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flow_run_effects ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: flow_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flow_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: flows; Type: ROW SECURITY; Schema: public
--
--
-- Name: flows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;

--
-- Name: folders; Type: ROW SECURITY; Schema: public
--
--
-- Name: folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;

--
-- Name: form_layouts; Type: ROW SECURITY; Schema: public
--
--
-- Name: form_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: form_response_steps; Type: ROW SECURITY; Schema: public
--
--
-- Name: form_response_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_response_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: form_responses; Type: ROW SECURITY; Schema: public
--
--
-- Name: form_responses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_responses ENABLE ROW LEVEL SECURITY;

--
-- Name: form_template_versions; Type: ROW SECURITY; Schema: public
--
--
-- Name: form_template_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_template_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: form_templates; Type: ROW SECURITY; Schema: public
--
--
-- Name: form_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_provider_configs; Type: ROW SECURITY; Schema: public
--
--
-- Name: fx_provider_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fx_provider_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_provider_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: fx_provider_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fx_provider_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: fx_rates; Type: ROW SECURITY; Schema: public
--
--
-- Name: fx_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: import_jobs; Type: ROW SECURITY; Schema: public
--
--
-- Name: import_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: insight_cards; Type: ROW SECURITY; Schema: public
--
--
-- Name: insight_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insight_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: insight_dashboard_pins; Type: ROW SECURITY; Schema: public
--
--
-- Name: insight_dashboard_pins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insight_dashboard_pins ENABLE ROW LEVEL SECURITY;

--
-- Name: insight_dashboards; Type: ROW SECURITY; Schema: public
--
--
-- Name: insight_dashboards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.insight_dashboards ENABLE ROW LEVEL SECURITY;

--
-- Name: intercompany_pairs; Type: ROW SECURITY; Schema: public
--
--
-- Name: intercompany_pairs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intercompany_pairs ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public
--
--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_backups; Type: ROW SECURITY; Schema: public
--
--
-- Name: invoice_backups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_backups ENABLE ROW LEVEL SECURITY;

--
-- Name: item_inventory_profiles; Type: ROW SECURITY; Schema: public
--
--
-- Name: item_inventory_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_inventory_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: items; Type: ROW SECURITY; Schema: public
--
--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public
--
--
-- Name: journal_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: journal_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: journal_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: labor_burden_rates; Type: ROW SECURITY; Schema: public
--
--
-- Name: labor_burden_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.labor_burden_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: landed_cost_allocations; Type: ROW SECURITY; Schema: public
--
--
-- Name: landed_cost_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.landed_cost_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: list_views; Type: ROW SECURITY; Schema: public
--
--
-- Name: list_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.list_views ENABLE ROW LEVEL SECURITY;

--
-- Name: locations; Type: ROW SECURITY; Schema: public
--
--
-- Name: locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

--
-- Name: lots; Type: ROW SECURITY; Schema: public
--
--
-- Name: lots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lots ENABLE ROW LEVEL SECURITY;

--
-- Name: masking_policies; Type: ROW SECURITY; Schema: public
--
--
-- Name: masking_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.masking_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public
--
--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: number_sequences; Type: ROW SECURITY; Schema: public
--
--
-- Name: number_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.number_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: account_group_members org_isolation; Type: POLICY; Schema: public
--
--
-- Name: account_group_members org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.account_group_members USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: account_groups org_isolation; Type: POLICY; Schema: public
--
--
-- Name: account_groups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.account_groups USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: accounting_books org_isolation; Type: POLICY; Schema: public
--
--
-- Name: accounting_books org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.accounting_books USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: accounting_periods org_isolation; Type: POLICY; Schema: public
--
--
-- Name: accounting_periods org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.accounting_periods USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: accounts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: accounts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.accounts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: addresses org_isolation; Type: POLICY; Schema: public
--
--
-- Name: addresses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.addresses USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_agent_policies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_agent_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_agent_policies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_agent_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_agent_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_agent_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_conversations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_conversations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_conversations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_messages org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_messages org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_messages USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_work_item_evidence org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_work_item_evidence org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_work_item_evidence USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_work_item_feedback org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_work_item_feedback org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_work_item_feedback USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ai_work_items org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ai_work_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ai_work_items USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: allocation_rule_targets org_isolation; Type: POLICY; Schema: public
--
--
-- Name: allocation_rule_targets org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.allocation_rule_targets USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: allocation_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: allocation_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.allocation_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: allocation_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: allocation_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.allocation_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_corrections org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_corrections org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_corrections USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_fields org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_fields org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_fields USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_items org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_items USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: ap_capture_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: ap_capture_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.ap_capture_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: api_key_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: api_key_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.api_key_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: api_keys org_isolation; Type: POLICY; Schema: public
--
--
-- Name: api_keys org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.api_keys USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: app_files org_isolation; Type: POLICY; Schema: public
--
--
-- Name: app_files org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.app_files USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: app_roles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: app_roles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.app_roles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: app_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: app_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.app_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: app_storage org_isolation; Type: POLICY; Schema: public
--
--
-- Name: app_storage org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.app_storage USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: app_versions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: app_versions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.app_versions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: applications org_isolation; Type: POLICY; Schema: public
--
--
-- Name: applications org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.applications USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: approval_delegations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: approval_delegations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.approval_delegations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: approval_policies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: approval_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.approval_policies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: approval_requests org_isolation; Type: POLICY; Schema: public
--
--
-- Name: approval_requests org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.approval_requests USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: approval_steps org_isolation; Type: POLICY; Schema: public
--
--
-- Name: approval_steps org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.approval_steps USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: apps org_isolation; Type: POLICY; Schema: public
--
--
-- Name: apps org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.apps USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: asset_categories org_isolation; Type: POLICY; Schema: public
--
--
-- Name: asset_categories org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.asset_categories USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: asset_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: asset_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.asset_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: audit_log org_isolation; Type: POLICY; Schema: public
--
--
-- Name: audit_log org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.audit_log USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: bank_match_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: bank_match_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.bank_match_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: bank_statement_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: bank_statement_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.bank_statement_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: bank_statements org_isolation; Type: POLICY; Schema: public
--
--
-- Name: bank_statements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.bank_statements USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: billing_requests org_isolation; Type: POLICY; Schema: public
--
--
-- Name: billing_requests org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.billing_requests USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: billing_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: billing_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.billing_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: bom_components org_isolation; Type: POLICY; Schema: public
--
--
-- Name: bom_components org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.bom_components USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: budget_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: budget_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.budget_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: budget_scenarios org_isolation; Type: POLICY; Schema: public
--
--
-- Name: budget_scenarios org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.budget_scenarios USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: change_set_items org_isolation; Type: POLICY; Schema: public
--
--
-- Name: change_set_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.change_set_items USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: change_sets org_isolation; Type: POLICY; Schema: public
--
--
-- Name: change_sets org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.change_sets USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: classes org_isolation; Type: POLICY; Schema: public
--
--
-- Name: classes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.classes USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_automation_executions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_automation_executions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_automation_executions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_automation_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_automation_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_automation_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_blueprint_dependencies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_blueprint_dependencies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_blueprint_dependencies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_blueprint_steps org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_blueprint_steps org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_blueprint_steps USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_blueprints org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_blueprints org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_blueprints USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_exceptions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_exceptions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_exceptions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_policies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_policies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_reopen_requests org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_reopen_requests org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_reopen_requests USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_reporting_packages org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_reporting_packages org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_reporting_packages USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_run_tasks org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_run_tasks org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_run_tasks USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_signoffs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_signoffs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_signoffs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: close_task_evidence org_isolation; Type: POLICY; Schema: public
--
--
-- Name: close_task_evidence org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.close_task_evidence USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: connections org_isolation; Type: POLICY; Schema: public
--
--
-- Name: connections org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.connections USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: consolidated_fx_rates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: consolidated_fx_rates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.consolidated_fx_rates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: contacts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: contacts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.contacts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: cost_layer_consumptions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: cost_layer_consumptions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.cost_layer_consumptions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: cost_layers org_isolation; Type: POLICY; Schema: public
--
--
-- Name: cost_layers org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.cost_layers USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_account_assignment_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_assignment_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_account_assignment_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_account_profiles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_profiles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_account_profiles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_account_stage_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_stage_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_account_stage_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_account_statuses org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_account_statuses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_account_statuses USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_activities org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activities org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_activities USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_activity_links org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activity_links org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_activity_links USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_activity_participants org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_activity_participants org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_activity_participants USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_forecast_snapshots org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_forecast_snapshots org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_forecast_snapshots USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_lead_sources org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_lead_sources org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_lead_sources USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunities org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunities org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunities USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunity_documents org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_documents org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunity_documents USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunity_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunity_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunity_stage_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_stage_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunity_stage_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunity_statuses org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_statuses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunity_statuses USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_opportunity_team_members org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_opportunity_team_members org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_opportunity_team_members USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_sales_quotas org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_quotas org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_sales_quotas USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_sales_team_members org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_team_members org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_sales_team_members USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_sales_teams org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_teams org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_sales_teams USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: crm_sales_territories org_isolation; Type: POLICY; Schema: public
--
--
-- Name: crm_sales_territories org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.crm_sales_territories USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: custom_field_defs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: custom_field_defs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.custom_field_defs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: custom_record_types org_isolation; Type: POLICY; Schema: public
--
--
-- Name: custom_record_types org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.custom_record_types USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: custom_records org_isolation; Type: POLICY; Schema: public
--
--
-- Name: custom_records org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.custom_records USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: customer_roles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: customer_roles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.customer_roles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: departments org_isolation; Type: POLICY; Schema: public
--
--
-- Name: departments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.departments USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: depreciation_book_policies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: depreciation_book_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.depreciation_book_policies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: depreciation_methods org_isolation; Type: POLICY; Schema: public
--
--
-- Name: depreciation_methods org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.depreciation_methods USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: depreciation_schedule_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: depreciation_schedule_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.depreciation_schedule_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: depreciation_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: depreciation_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.depreciation_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: document_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: document_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.document_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: document_links org_isolation; Type: POLICY; Schema: public
--
--
-- Name: document_links org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.document_links USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: documents org_isolation; Type: POLICY; Schema: public
--
--
-- Name: documents org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.documents USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: email_log org_isolation; Type: POLICY; Schema: public
--
--
-- Name: email_log org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.email_log USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: employee_roles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: employee_roles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.employee_roles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fair_value_prices org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fair_value_prices org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fair_value_prices USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: file_attachments org_isolation; Type: POLICY; Schema: public
--
--
-- Name: file_attachments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.file_attachments USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: files org_isolation; Type: POLICY; Schema: public
--
--
-- Name: files org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.files USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fiscal_calendars org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fiscal_calendars org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fiscal_calendars USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fixed_assets org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fixed_assets org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fixed_assets USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: flow_gates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: flow_gates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.flow_gates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: flow_locks org_isolation; Type: POLICY; Schema: public
--
--
-- Name: flow_locks org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.flow_locks USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: flow_run_effects org_isolation; Type: POLICY; Schema: public
--
--
-- Name: flow_run_effects org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.flow_run_effects USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: flow_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: flow_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.flow_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: flows org_isolation; Type: POLICY; Schema: public
--
--
-- Name: flows org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.flows USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: folders org_isolation; Type: POLICY; Schema: public
--
--
-- Name: folders org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.folders USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: form_layouts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: form_layouts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.form_layouts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: form_response_steps org_isolation; Type: POLICY; Schema: public
--
--
-- Name: form_response_steps org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.form_response_steps USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: form_responses org_isolation; Type: POLICY; Schema: public
--
--
-- Name: form_responses org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.form_responses USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: form_template_versions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: form_template_versions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.form_template_versions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: form_templates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: form_templates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.form_templates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fx_provider_configs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fx_provider_configs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fx_provider_configs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fx_provider_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fx_provider_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fx_provider_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: fx_rates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: fx_rates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.fx_rates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: import_jobs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: import_jobs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.import_jobs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: insight_cards org_isolation; Type: POLICY; Schema: public
--
--
-- Name: insight_cards org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.insight_cards USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: insight_dashboard_pins org_isolation; Type: POLICY; Schema: public
--
--
-- Name: insight_dashboard_pins org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.insight_dashboard_pins USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: insight_dashboards org_isolation; Type: POLICY; Schema: public
--
--
-- Name: insight_dashboards org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.insight_dashboards USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: intercompany_pairs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: intercompany_pairs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.intercompany_pairs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: inventory_movements org_isolation; Type: POLICY; Schema: public
--
--
-- Name: inventory_movements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.inventory_movements USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: invoice_backups org_isolation; Type: POLICY; Schema: public
--
--
-- Name: invoice_backups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.invoice_backups USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: item_inventory_profiles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: item_inventory_profiles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.item_inventory_profiles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: items org_isolation; Type: POLICY; Schema: public
--
--
-- Name: items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.items USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: journal_entries org_isolation; Type: POLICY; Schema: public
--
--
-- Name: journal_entries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.journal_entries USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: journal_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: journal_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.journal_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: labor_burden_rates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: labor_burden_rates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.labor_burden_rates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: landed_cost_allocations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: landed_cost_allocations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.landed_cost_allocations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: list_views org_isolation; Type: POLICY; Schema: public
--
--
-- Name: list_views org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.list_views USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: locations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: locations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.locations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: lots org_isolation; Type: POLICY; Schema: public
--
--
-- Name: lots org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.lots USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: masking_policies org_isolation; Type: POLICY; Schema: public
--
--
-- Name: masking_policies org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.masking_policies USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: notifications org_isolation; Type: POLICY; Schema: public
--
--
-- Name: notifications org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.notifications USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: number_sequences org_isolation; Type: POLICY; Schema: public
--
--
-- Name: number_sequences org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.number_sequences USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: org_nav_configs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: org_nav_configs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.org_nav_configs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: parties org_isolation; Type: POLICY; Schema: public
--
--
-- Name: parties org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.parties USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: party_bank_accounts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: party_bank_accounts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.party_bank_accounts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: party_subsidiaries org_isolation; Type: POLICY; Schema: public
--
--
-- Name: party_subsidiaries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.party_subsidiaries USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_bank_profiles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_bank_profiles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_bank_profiles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_cards org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_cards org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_cards USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_events org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_events org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_events USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_file_deliveries org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_file_deliveries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_file_deliveries USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_files org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_files org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_files USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_formats org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_formats org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_formats USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_instructions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_instructions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_instructions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_mandates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_mandates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_mandates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_remittances org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_remittances org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_remittances USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_run_items org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_run_items org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_run_items USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_settlements org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_settlements org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_settlements USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: payment_terms org_isolation; Type: POLICY; Schema: public
--
--
-- Name: payment_terms org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.payment_terms USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: pdf_templates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: pdf_templates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.pdf_templates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: performance_obligations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: performance_obligations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.performance_obligations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: period_locks org_isolation; Type: POLICY; Schema: public
--
--
-- Name: period_locks org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.period_locks USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: project_tasks org_isolation; Type: POLICY; Schema: public
--
--
-- Name: project_tasks org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.project_tasks USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: projects org_isolation; Type: POLICY; Schema: public
--
--
-- Name: projects org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.projects USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: recognition_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: recognition_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.recognition_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: recognition_schedule_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: recognition_schedule_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.recognition_schedule_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: recognition_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: recognition_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.recognition_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: reconciliation_matches org_isolation; Type: POLICY; Schema: public
--
--
-- Name: reconciliation_matches org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.reconciliation_matches USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: reconciliations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: reconciliations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.reconciliations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: recurring_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: recurring_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.recurring_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: report_definitions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: report_definitions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.report_definitions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: report_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: report_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.report_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: report_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: report_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.report_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: revenue_contracts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: revenue_contracts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.revenue_contracts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: role_assignments org_isolation; Type: POLICY; Schema: public
--
--
-- Name: role_assignments org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.role_assignments USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: role_dashboard_layouts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: role_dashboard_layouts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.role_dashboard_layouts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: saved_reports org_isolation; Type: POLICY; Schema: public
--
--
-- Name: saved_reports org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.saved_reports USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: saved_views org_isolation; Type: POLICY; Schema: public
--
--
-- Name: saved_views org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.saved_views USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: script_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: script_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.script_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: segment_definitions org_isolation; Type: POLICY; Schema: public
--
--
-- Name: segment_definitions org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.segment_definitions USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: segment_values org_isolation; Type: POLICY; Schema: public
--
--
-- Name: segment_values org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.segment_values USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: serials org_isolation; Type: POLICY; Schema: public
--
--
-- Name: serials org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.serials USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: sftp_import_schedules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: sftp_import_schedules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.sftp_import_schedules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: sftp_servers org_isolation; Type: POLICY; Schema: public
--
--
-- Name: sftp_servers org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.sftp_servers USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: statement_layouts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: statement_layouts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.statement_layouts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: stock_count_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: stock_count_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.stock_count_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: stock_counts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: stock_counts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.stock_counts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: stock_locations org_isolation; Type: POLICY; Schema: public
--
--
-- Name: stock_locations org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.stock_locations USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: subsidiaries org_isolation; Type: POLICY; Schema: public
--
--
-- Name: subsidiaries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.subsidiaries USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: sync_runs org_isolation; Type: POLICY; Schema: public
--
--
-- Name: sync_runs org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.sync_runs USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_codes org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_codes org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_codes USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_depreciation_pools org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_depreciation_pools org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_depreciation_pools USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_filings org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_filings org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_filings USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_first_year_rules org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_first_year_rules org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_first_year_rules USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_groups org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_groups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_groups USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_pool_periods org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_pool_periods org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_pool_periods USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_rates org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_rates org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_rates USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_report_lines org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_report_lines org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_report_lines USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: tax_return_forms org_isolation; Type: POLICY; Schema: public
--
--
-- Name: tax_return_forms org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.tax_return_forms USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: time_entries org_isolation; Type: POLICY; Schema: public
--
--
-- Name: time_entries org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.time_entries USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: time_types org_isolation; Type: POLICY; Schema: public
--
--
-- Name: time_types org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.time_types USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: trades org_isolation; Type: POLICY; Schema: public
--
--
-- Name: trades org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.trades USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: user_dashboard_layouts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: user_dashboard_layouts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.user_dashboard_layouts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: user_form_preferences org_isolation; Type: POLICY; Schema: public
--
--
-- Name: user_form_preferences org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.user_form_preferences USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: user_list_preferences org_isolation; Type: POLICY; Schema: public
--
--
-- Name: user_list_preferences org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.user_list_preferences USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: user_permission_overrides org_isolation; Type: POLICY; Schema: public
--
--
-- Name: user_permission_overrides org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.user_permission_overrides USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: user_scripts org_isolation; Type: POLICY; Schema: public
--
--
-- Name: user_scripts org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.user_scripts USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: users org_isolation; Type: POLICY; Schema: public
--
--
-- Name: users org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.users USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: vendor_roles org_isolation; Type: POLICY; Schema: public
--
--
-- Name: vendor_roles org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.vendor_roles USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: worker_comp_groups org_isolation; Type: POLICY; Schema: public
--
--
-- Name: worker_comp_groups org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation ON public.worker_comp_groups USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: org_nav_configs; Type: ROW SECURITY; Schema: public
--
--
-- Name: org_nav_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_nav_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: parties; Type: ROW SECURITY; Schema: public
--
--
-- Name: parties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;

--
-- Name: party_bank_accounts; Type: ROW SECURITY; Schema: public
--
--
-- Name: party_bank_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.party_bank_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: party_subsidiaries; Type: ROW SECURITY; Schema: public
--
--
-- Name: party_subsidiaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.party_subsidiaries ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_bank_profiles; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_bank_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_bank_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_cards; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_events; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_file_deliveries; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_file_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_file_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_files; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_files ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_formats; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_formats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_formats ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_instructions; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_instructions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_instructions ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_mandates; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_mandates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_mandates ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_remittances; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_remittances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_remittances ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_run_items; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_run_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_run_items ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_settlements; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_settlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_terms; Type: ROW SECURITY; Schema: public
--
--
-- Name: payment_terms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: pdf_templates; Type: ROW SECURITY; Schema: public
--
--
-- Name: pdf_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pdf_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: performance_obligations; Type: ROW SECURITY; Schema: public
--
--
-- Name: performance_obligations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.performance_obligations ENABLE ROW LEVEL SECURITY;

--
-- Name: period_locks; Type: ROW SECURITY; Schema: public
--
--
-- Name: period_locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.period_locks ENABLE ROW LEVEL SECURITY;

--
-- Name: project_tasks; Type: ROW SECURITY; Schema: public
--
--
-- Name: project_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public
--
--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: recognition_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: recognition_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recognition_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: recognition_schedule_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: recognition_schedule_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recognition_schedule_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: recognition_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: recognition_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recognition_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_matches; Type: ROW SECURITY; Schema: public
--
--
-- Name: reconciliation_matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliations; Type: ROW SECURITY; Schema: public
--
--
-- Name: reconciliations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: recurring_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: report_definitions; Type: ROW SECURITY; Schema: public
--
--
-- Name: report_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: report_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: report_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.report_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: revenue_contracts; Type: ROW SECURITY; Schema: public
--
--
-- Name: revenue_contracts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenue_contracts ENABLE ROW LEVEL SECURITY;

--
-- Name: role_assignments; Type: ROW SECURITY; Schema: public
--
--
-- Name: role_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: role_dashboard_layouts; Type: ROW SECURITY; Schema: public
--
--
-- Name: role_dashboard_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_dashboard_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: sandboxes sandbox_isolation; Type: POLICY; Schema: public
--
--
-- Name: sandboxes sandbox_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sandbox_isolation ON public.sandboxes USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)) OR ((production_org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((production_org_id)::text = current_setting('app.current_org'::text, true))));


--
-- Name: sandboxes; Type: ROW SECURITY; Schema: public
--
--
-- Name: sandboxes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sandboxes ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_reports; Type: ROW SECURITY; Schema: public
--
--
-- Name: saved_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_views; Type: ROW SECURITY; Schema: public
--
--
-- Name: saved_views; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_views ENABLE ROW LEVEL SECURITY;

--
-- Name: script_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: script_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.script_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: segment_definitions; Type: ROW SECURITY; Schema: public
--
--
-- Name: segment_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.segment_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: segment_values; Type: ROW SECURITY; Schema: public
--
--
-- Name: segment_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.segment_values ENABLE ROW LEVEL SECURITY;

--
-- Name: serials; Type: ROW SECURITY; Schema: public
--
--
-- Name: serials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.serials ENABLE ROW LEVEL SECURITY;

--
-- Name: sftp_import_schedules; Type: ROW SECURITY; Schema: public
--
--
-- Name: sftp_import_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sftp_import_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: sftp_servers; Type: ROW SECURITY; Schema: public
--
--
-- Name: sftp_servers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sftp_servers ENABLE ROW LEVEL SECURITY;

--
-- Name: statement_layouts; Type: ROW SECURITY; Schema: public
--
--
-- Name: statement_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.statement_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_count_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: stock_count_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_count_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_counts; Type: ROW SECURITY; Schema: public
--
--
-- Name: stock_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_locations; Type: ROW SECURITY; Schema: public
--
--
-- Name: stock_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: subsidiaries; Type: ROW SECURITY; Schema: public
--
--
-- Name: subsidiaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subsidiaries ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_runs; Type: ROW SECURITY; Schema: public
--
--
-- Name: sync_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_codes; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_depreciation_pools; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_depreciation_pools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_depreciation_pools ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_filings; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_filings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_filings ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_first_year_rules; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_first_year_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_first_year_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_groups; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_pool_periods; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_pool_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_pool_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_rates; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_report_lines; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_report_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_report_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_return_forms; Type: ROW SECURITY; Schema: public
--
--
-- Name: tax_return_forms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_return_forms ENABLE ROW LEVEL SECURITY;

--
-- Name: time_entries; Type: ROW SECURITY; Schema: public
--
--
-- Name: time_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: time_types; Type: ROW SECURITY; Schema: public
--
--
-- Name: time_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_types ENABLE ROW LEVEL SECURITY;

--
-- Name: trades; Type: ROW SECURITY; Schema: public
--
--
-- Name: trades; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

--
-- Name: user_dashboard_layouts; Type: ROW SECURITY; Schema: public
--
--
-- Name: user_dashboard_layouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_dashboard_layouts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_form_preferences; Type: ROW SECURITY; Schema: public
--
--
-- Name: user_form_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_form_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: user_list_preferences; Type: ROW SECURITY; Schema: public
--
--
-- Name: user_list_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_list_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permission_overrides; Type: ROW SECURITY; Schema: public
--
--
-- Name: user_permission_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: user_scripts; Type: ROW SECURITY; Schema: public
--
--
-- Name: user_scripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_scripts ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public
--
--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: vendor_roles; Type: ROW SECURITY; Schema: public
--
--
-- Name: vendor_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vendor_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_comp_groups; Type: ROW SECURITY; Schema: public
--
--
-- Name: worker_comp_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_comp_groups ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


