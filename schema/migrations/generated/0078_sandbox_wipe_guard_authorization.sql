-- OpenBooks forward migration 0078_sandbox_wipe_guard_authorization.
--
-- A session GUC is caller-controlled state, not tenant authorization.  The
-- historical wipe shortcuts treated `openbooks.sandbox_wipe` (and the older
-- `app.sandbox_wipe`) as sufficient authority, so a production transaction
-- could set the flag and rewrite posted ledger rows, retained evidence, or
-- skip maintenance of derived financial summaries.  Every replacement below
-- routes the only teardown exemption through the canonical helper, and only
-- for DELETE.  INSERT and UPDATE always execute their production guards and
-- derived-state maintenance.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.depreciation_evidence_attachment_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if old.target_table = 'fixed_assets' and exists (
    select 1
      from depreciation_inputs i
      join depreciation_schedules s on s.id = i.schedule_id
     where i.org_id = old.org_id and i.evidence_file_id = old.file_id and s.asset_id = old.target_id
  ) then
    raise exception 'file attachment is retained by depreciation evidence';
  end if;
  return coalesce(new, old);
end $$;

CREATE OR REPLACE FUNCTION public.inventory_provisional_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  raise exception 'inventory provisional evidence is immutable';
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_guard_depreciation_evidence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  posted boolean;
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'depreciation input evidence is append-preserved';
  end if;

  select exists (
    select 1 from depreciation_schedule_lines
     where input_id = old.id and posted_amount is not null
  ) into posted;
  if posted then
    raise exception 'posted depreciation input evidence is immutable';
  end if;

  if old.voided_at is not null
     or new.voided_at is null
     or new.voided_by is null
     or new.org_id is distinct from old.org_id
     or new.schedule_id is distinct from old.schedule_id
     or new.period_id is distinct from old.period_id
     or new.kind is distinct from old.kind
     or new.manual_amount is distinct from old.manual_amount
     or new.production_units is distinct from old.production_units
     or new.memo is distinct from old.memo
     or new.evidence_file_id is distinct from old.evidence_file_id
     or new.supersedes_input_id is distinct from old.supersedes_input_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'depreciation input evidence may only be voided before posting';
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    if old.status <> 'draft' then
      perform period_posting_fence(old.org_id, old.period_id, old.book_id);
      if period_module_is_closed(old.org_id, old.period_id, old.book_id,
           nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl') then
        raise exception 'period is closed for GL posting';
      end if;
    end if;
    return old;
  end if;

  if old.status in ('posted', 'reversed') and new.status = old.status
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
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

  if old.status = 'draft' and new.status = 'posted' then
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and l.org_id = new.org_id
            and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl',
              coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_old_in boolean;
  v_new_in boolean;
  v_old_month date;
  v_new_month date;
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('posted', 'reversed') then
      perform openbooks_gl_activity_entry_delta(new.id, new.org_id, date_trunc('month', new.posting_date)::date, 1);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'reversed') then
      perform openbooks_gl_activity_entry_delta(old.id, old.org_id, date_trunc('month', old.posting_date)::date, -1);
    end if;
    return null;
  end if;
  v_old_in := old.status in ('posted', 'reversed');
  v_new_in := new.status in ('posted', 'reversed');
  v_old_month := date_trunc('month', old.posting_date)::date;
  v_new_month := date_trunc('month', new.posting_date)::date;
  if v_old_in and not v_new_in then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1);
  elsif v_new_in and not v_old_in then
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  elsif v_old_in and v_new_in and v_old_month <> v_new_month then
    perform openbooks_gl_activity_entry_delta(old.id, old.org_id, v_old_month, -1);
    perform openbooks_gl_activity_entry_delta(new.id, new.org_id, v_new_month, 1);
  end if;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_gl_activity_line() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_date date;
  v_org uuid;
  v_book uuid;
  v_month date;
  v_entry uuid;
  v_line_org uuid;
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and (new.entry_id, new.org_id) is distinct from (old.entry_id, old.org_id) then
    select status, posting_date, org_id, book_id
      into v_status, v_date, v_org, v_book
      from journal_entries
     where id = old.entry_id and org_id = old.org_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, old.account_id, v_book, v_month, old.subsidiary_id,
        -greatest(old.amount, 0), -greatest(-old.amount, 0), -1);
    end if;
    select status, posting_date, org_id, book_id
      into v_status, v_date, v_org, v_book
      from journal_entries
     where id = new.entry_id and org_id = new.org_id;
    if v_status in ('posted', 'reversed') then
      v_month := date_trunc('month', v_date)::date;
      perform openbooks_gl_activity_apply(v_org, new.account_id, v_book, v_month, new.subsidiary_id,
        greatest(new.amount, 0), greatest(-new.amount, 0), 1);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    v_entry := old.entry_id;
    v_line_org := old.org_id;
  else
    v_entry := new.entry_id;
    v_line_org := new.org_id;
  end if;
  select status, posting_date, org_id, book_id
    into v_status, v_date, v_org, v_book
    from journal_entries
   where id = v_entry and org_id = v_line_org;
  if v_status is null or v_status not in ('posted', 'reversed') then
    return null;
  end if;
  v_month := date_trunc('month', v_date)::date;
  if tg_op in ('UPDATE', 'DELETE') then
    perform openbooks_gl_activity_apply(v_org, old.account_id, v_book, v_month, old.subsidiary_id,
      -greatest(old.amount, 0), -greatest(-old.amount, 0), -1);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform openbooks_gl_activity_apply(v_org, new.account_id, v_book, v_month, new.subsidiary_id,
      greatest(new.amount, 0), greatest(-new.amount, 0), 1);
  end if;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_je_cascade_posting_date() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update journal_lines
     set posting_date = new.posting_date
   where entry_id = new.id
     and org_id = new.org_id
     and posting_date is distinct from new.posting_date;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.openbooks_party_payment_stats() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.unapplied_at is null then
      perform openbooks_party_payment_stats_delta(new.from_line_id, new.to_line_id, 1);
    end if;
  elsif tg_op = 'DELETE' then
    if old.unapplied_at is null then
      perform openbooks_party_payment_stats_delta(old.from_line_id, old.to_line_id, -1);
    end if;
  else
    if old.unapplied_at is null and new.unapplied_at is not null then
      perform openbooks_party_payment_stats_delta(old.from_line_id, old.to_line_id, -1);
    elsif old.unapplied_at is not null and new.unapplied_at is null then
      perform openbooks_party_payment_stats_delta(new.from_line_id, new.to_line_id, 1);
    end if;
  end if;
  return null;
end $$;

CREATE OR REPLACE FUNCTION public.posted_document_financial_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
    raise exception 'document % is % — its financial identity (totals, dates, currency, party, kind, number) is immutable outside the governed amend path', old.id, old.status;
  end if;
  return new;
end $$;

CREATE OR REPLACE FUNCTION public.protect_country_tax_pack_installation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'country tax pack installation evidence is immutable';
  END IF;
  IF OLD.status = 'active'
     AND NEW.status = 'superseded'
     AND NEW.org_id = OLD.org_id
     AND NEW.pack_code = OLD.pack_code
     AND NEW.country = OLD.country
     AND NEW.version = OLD.version
     AND NEW.content_hash = OLD.content_hash
     AND NEW.manifest = OLD.manifest
     AND NEW.installed_at = OLD.installed_at
     AND NEW.installed_by IS NOT DISTINCT FROM OLD.installed_by
     AND NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'country tax pack installation may only transition from active to superseded';
END;
$$;

CREATE OR REPLACE FUNCTION public.subscription_amendment_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'applied' THEN
    RAISE EXCEPTION 'applied subscription amendments are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_period_invoice_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'subscription period invoice lineage is immutable';
END $$;

CREATE OR REPLACE FUNCTION public.subscription_plan_version_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF OLD.status IN ('published','superseded') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'published subscription plan versions are immutable';
    END IF;
    IF ROW(OLD.plan_id,OLD.effective_from,OLD.name,OLD.description,OLD.currency_code,OLD.interval,OLD.interval_count,OLD.billing_timing,OLD.published_at,OLD.published_by)
      IS DISTINCT FROM ROW(NEW.plan_id,NEW.effective_from,NEW.name,NEW.description,NEW.currency_code,NEW.interval,NEW.interval_count,NEW.billing_timing,NEW.published_at,NEW.published_by)
    THEN
      RAISE EXCEPTION 'published subscription plan commercial terms are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.subscription_version_component_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE parent_version uuid; parent_status text;
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  parent_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO parent_status FROM subscription_plan_versions WHERE id=parent_version;
  IF parent_status IN ('published','superseded') THEN
    RAISE EXCEPTION 'components of published subscription plan versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION public.recurring_occurrence_document_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'recurring occurrence lineage is immutable';
END $$;

CREATE OR REPLACE FUNCTION public.enforce_payment_instruction_posting_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_token uuid;
  subject_id uuid;
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  subject_id := COALESCE(NEW.id, OLD.id);

  SELECT r.status, r.posting_claim_token
    INTO run_status, run_token
    FROM public.payment_runs r
   WHERE r.id = COALESCE(NEW.payment_run_id, OLD.payment_run_id)
     AND r.org_id = COALESCE(NEW.org_id, OLD.org_id);
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF run_status <> 'processing' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF run_token IS NOT NULL
     AND current_setting('openbooks.payment_run_claim', true)
         = COALESCE(NEW.payment_run_id, OLD.payment_run_id)::text || ':' || run_token::text THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status IN ('settled', 'returned', 'rejected') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'payment instruction ' || subject_id::text ||
              ' belongs to a processing payment run; only the current posting claim may mutate it',
    DETAIL = 'Present the live lease as openbooks.payment_run_claim = <runId>:<postingClaimToken> inside the writing transaction.',
    HINT = 'The claim was recovered, retired, or never taken; re-claim the run before writing its instructions.';
END;
$$;

-- Document total tie-outs are invariants, not teardown switches.  The line
-- trigger skips only an authorized DELETE because the parent row is removed by
-- the same sandbox teardown; inserts and updates still refresh and validate.
CREATE OR REPLACE FUNCTION public.assert_document_totals_match_lines(p_document_id uuid, p_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_kind text;
    v_stored_subtotal numeric;
    v_stored_tax numeric;
    v_stored_total numeric;
    v_line_count integer;
    v_amount_sum numeric;
    v_tax_sum numeric;
    v_debit_sum numeric;
    v_want_subtotal numeric;
    v_want_tax numeric;
    v_want_total numeric;
BEGIN
    SELECT kind, subtotal, tax_total, total
      INTO v_kind, v_stored_subtotal, v_stored_tax, v_stored_total
      FROM public.documents
     WHERE id = p_document_id AND org_id = p_org_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT count(*)::int,
           coalesce(sum(l.amount), 0),
           coalesce(sum(l.tax_amount), 0),
           coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0)
      INTO v_line_count, v_amount_sum, v_tax_sum, v_debit_sum
      FROM public.document_lines l
     WHERE l.document_id = p_document_id AND l.org_id = p_org_id;
    IF v_line_count = 0 THEN
        RETURN;
    END IF;
    IF v_kind IN ('journal', 'pay_run') THEN
        v_want_tax := v_tax_sum;
        v_want_total := v_debit_sum;
        v_want_subtotal := v_debit_sum - v_tax_sum;
    ELSE
        v_want_subtotal := v_amount_sum;
        v_want_tax := v_tax_sum;
        v_want_total := v_amount_sum + v_tax_sum;
    END IF;
    IF v_stored_subtotal IS DISTINCT FROM v_want_subtotal
       OR v_stored_tax IS DISTINCT FROM v_want_tax
       OR v_stored_total IS DISTINCT FROM v_want_total THEN
        RAISE EXCEPTION
            'document % header totals do not tie to its lines: stored subtotal %, tax_total %, total % but its % line(s) sum to subtotal %, tax_total %, total %',
            p_document_id, v_stored_subtotal, v_stored_tax, v_stored_total,
            v_line_count, v_want_subtotal, v_want_tax, v_want_total
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_document_totals_from_lines(p_document_id uuid, p_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_kind text;
    v_line_count integer;
    v_amount_sum numeric;
    v_tax_sum numeric;
    v_debit_sum numeric;
    v_want_subtotal numeric;
    v_want_total numeric;
BEGIN
    SELECT kind INTO v_kind
      FROM public.documents
     WHERE id = p_document_id AND org_id = p_org_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT count(*)::int,
           coalesce(sum(l.amount), 0),
           coalesce(sum(l.tax_amount), 0),
           coalesce(sum(l.amount) FILTER (WHERE l.amount > 0), 0)
      INTO v_line_count, v_amount_sum, v_tax_sum, v_debit_sum
      FROM public.document_lines l
     WHERE l.document_id = p_document_id AND l.org_id = p_org_id;
    IF v_kind IN ('journal', 'pay_run') THEN
        v_want_total := v_debit_sum;
        v_want_subtotal := v_debit_sum - v_tax_sum;
    ELSE
        v_want_subtotal := v_amount_sum;
        v_want_total := v_amount_sum + v_tax_sum;
    END IF;
    UPDATE public.documents d
       SET subtotal = v_want_subtotal,
           tax_total = v_tax_sum,
           total = v_want_total,
           updated_at = greatest(clock_timestamp(), d.updated_at + interval '1 microsecond')
     WHERE d.id = p_document_id
       AND d.org_id = p_org_id
       AND (d.subtotal, d.tax_total, d.total) IS DISTINCT FROM
           (v_want_subtotal, v_tax_sum, v_want_total);
END;
$$;

CREATE OR REPLACE FUNCTION public.document_lines_total_line_refresh() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF tg_op = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(old.org_id) THEN
        RETURN NULL;
    ELSIF tg_op = 'DELETE' THEN
        PERFORM public.refresh_document_totals_from_lines(old.document_id, old.org_id);
    ELSIF tg_op = 'UPDATE' THEN
        IF (old.document_id, old.org_id) IS DISTINCT FROM (new.document_id, new.org_id) THEN
            PERFORM public.refresh_document_totals_from_lines(old.document_id, old.org_id);
        END IF;
        PERFORM public.refresh_document_totals_from_lines(new.document_id, new.org_id);
    ELSE
        PERFORM public.refresh_document_totals_from_lines(new.document_id, new.org_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.documents_total_line_tieout() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM public.assert_document_totals_match_lines(new.id, new.org_id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.document_lines_total_line_tieout() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF tg_op = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(old.org_id) THEN
        RETURN NULL;
    ELSIF tg_op = 'DELETE' THEN
        PERFORM public.assert_document_totals_match_lines(old.document_id, old.org_id);
    ELSIF tg_op = 'UPDATE' THEN
        IF (old.document_id, old.org_id) IS DISTINCT FROM (new.document_id, new.org_id) THEN
            PERFORM public.assert_document_totals_match_lines(old.document_id, old.org_id);
        END IF;
        PERFORM public.assert_document_totals_match_lines(new.document_id, new.org_id);
    ELSE
        PERFORM public.assert_document_totals_match_lines(new.document_id, new.org_id);
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.openbooks_sandbox_wipe_allowed(uuid) IS
  'Returns true only when the transaction-local wipe GUC is on and the target organization is a sandbox; DELETE-only trigger exemptions must call this helper.';
