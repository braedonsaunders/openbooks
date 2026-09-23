-- OpenBooks forward migration 0316_clone_closed_period_authority.
--
-- OM-13: creating a sample company (and any sandbox clone) failed whenever
-- the source template held posted history in an already-closed period. The
-- clone transaction rolls back on INSERT INTO journal_lines ... SELECT
-- ob_rebase(...) with P0001 "period is closed for GL posting" from jl_guard:
-- clone.ts sets openbooks.migration + openbooks.amend for the trusted bulk
-- copy, but the amend path still honours closed-period locks, so replaying
-- posted history into a closed target period is refused.
--
-- Owner decision (2026-09-23): allow a clone-only insert exception, narrowly
-- scoped and audited. Updates and deletes of posted history stay blocked.
--
-- This migration adds the single source of truth for that authority,
-- openbooks_clone_authority(), and honours it in the two guards that refuse
-- closed-period INSERTs during a copy:
--
-- - jl_guard(): under the authority, INSERT of a line whose entry is posted
--   or reversed skips the closed-period raise. The tenant-coherent parent
--   lookup, the original-parent UPDATE rule, the reconciliation-evidence
--   branches, and the UPDATE/DELETE amend path are byte-identical to 0165.
-- - depreciation_non_gl_recognition_guard(): under the authority, INSERT of
--   a recognized reporting-book line returns the verbatim row before the
--   live-state revalidation. That revalidation assumes its book/asset/period
--   parents are already visible, which bulk-copy order cannot guarantee
--   inside a reference cycle (the deferred foreign keys validate them at
--   commit instead), and it would refuse the closed target period. The shape
--   checks, the CHECK constraints, the UPDATE/DELETE branches and the audit
--   trigger are unchanged; the row keeps its source recognition instant
--   instead of restamping it.
--
-- The authority holds only when ALL of openbooks.clone, openbooks.migration
-- and openbooks.amend are 'on' inside a maintenance (RLS-bypass) transaction.
-- clone.ts is the only setter, and only inside runClone's transaction; a
-- normal tenant transaction (bypass off) cannot satisfy it no matter which
-- flags a caller sets. je_guard needs no change: it has no INSERT trigger.
-- No data is touched.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The clone authority: true only inside runClone's maintenance transaction,
-- where clone.ts asserts all three flags transaction-locally. Tenant
-- transactions run with app.bypass_rls off, so setting the flags there (or
-- in any other maintenance unit that does not assert openbooks.clone, such
-- as the sandbox wipe) still evaluates false. No caller can widen this: the
-- four GUCs are read here, in one place, and nowhere else.
CREATE OR REPLACE FUNCTION public.openbooks_clone_authority()
RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  select coalesce(current_setting('openbooks.clone', true), 'off') = 'on'
     and coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
     and coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
$$;

COMMENT ON FUNCTION public.openbooks_clone_authority() IS
  'True only inside the deterministic clone transaction (0316): openbooks.clone, openbooks.migration and openbooks.amend asserted together under RLS bypass. Guards honour it for INSERT of posted history only; it never permits UPDATE, DELETE, or tenant-transaction writes.';

CREATE OR REPLACE FUNCTION public.jl_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_org uuid;
  v_period uuid;
  v_book uuid;
  v_old_status text;
  v_old_org uuid;
  v_old_period uuid;
  v_old_book uuid;
  v_line_org uuid;
  v_entry uuid;
  v_recon_same boolean;
  v_recon_statement_stamp boolean;
  v_recon_source_stamp boolean;
  v_source_same boolean;
  v_source_stamp boolean;
begin
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  -- Tenant coherence (restored from 0038 in 0159): a line may only ever
  -- reference a journal entry of its OWN organization. On UPDATE the
  -- ORIGINAL parent is resolved too: the destination alone cannot vouch for
  -- the history the line leaves behind. A miss raises the foreign-key class
  -- error the ledger guards and the kernel-constraints canary rely on.
  if tg_op = 'DELETE' then
    v_line_org := old.org_id;
    v_entry := old.entry_id;
  else
    v_line_org := new.org_id;
    v_entry := new.entry_id;
  end if;
  select status, org_id, period_id, book_id
    into v_status, v_org, v_period, v_book
    from journal_entries
   where id = v_entry and org_id = v_line_org;
  if not found then
    raise exception 'journal entry % does not exist in organization %', v_entry, v_line_org
      using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    select status, org_id, period_id, book_id
      into v_old_status, v_old_org, v_old_period, v_old_book
      from journal_entries
     where id = old.entry_id and org_id = old.org_id;
    if not found then
      raise exception 'journal entry % does not exist in organization %', old.entry_id, old.org_id
        using errcode = '23503';
    end if;
    -- Original-parent immutability (0165): a line that leaves posted or
    -- reversed history for a different entry or organization is refused.
    -- Evidence-only stamps never move lines, so any such move is either a
    -- history rewrite or a trusted replay, and a replay must hold BOTH
    -- periods open. In-place edits of a posted line fall through to the
    -- destination-parent checks below, which see the same entry.
    if v_old_status is distinct from 'draft'
       and (new.entry_id is distinct from old.entry_id
            or new.org_id is distinct from old.org_id) then
      if coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
         and not period_module_blocks_write(v_old_org, v_old_period, v_old_book,
           nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
         and not period_module_blocks_write(v_org, v_period, v_book,
           nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
        return new;
      end if;
      raise exception 'lines of a % journal entry are immutable', v_old_status;
    end if;
  end if;
  if v_status is distinct from 'draft' then
    -- Bank-reconciliation sign-off stamps reconciled_at / reconciliation_id
    -- on posted lines. That is bookkeeping metadata, but it is still permanent
    -- financial-control evidence: it may only transition once from entirely
    -- unset to an extant unsigned reconciliation that already claims the line.
    -- Clearing, retargeting, or partially stamping the evidence is forbidden.
    -- Source-cleared evidence (0158) follows the same append-only rule: the
    -- mirror records the source system's cleared marker once, and a
    -- source-evidenced sign-off stamps only lines already carrying it.
    if tg_op = 'UPDATE'
       and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
         = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
    then
      v_recon_same := new.reconciled_at is not distinct from old.reconciled_at
        and new.reconciliation_id is not distinct from old.reconciliation_id;
      v_source_same := new.source_cleared_date is not distinct from old.source_cleared_date
        and new.source_cleared_connector is not distinct from old.source_cleared_connector;
      if v_recon_same and v_source_same then
        return new;
      end if;
      v_recon_statement_stamp :=
        old.reconciled_at is null
        and old.reconciliation_id is null
        and new.reconciled_at is not null
        and new.reconciliation_id is not null
        and exists (
          select 1
            from reconciliations r
           where r.id = new.reconciliation_id
             and r.org_id = new.org_id
             and r.status <> 'signed_off'
        )
        and exists (
          select 1
            from reconciliation_matches m
           where m.reconciliation_id = new.reconciliation_id
             and m.journal_line_id = new.id
             and m.org_id = new.org_id
        );
      v_recon_source_stamp :=
        old.reconciled_at is null
        and old.reconciliation_id is null
        and new.reconciled_at is not null
        and new.reconciliation_id is not null
        and new.source_cleared_date is not null
        and exists (
          select 1
            from reconciliations r
           where r.id = new.reconciliation_id
             and r.org_id = new.org_id
             and r.status <> 'signed_off'
             and r.evidence_kind = 'source'
        );
      v_source_stamp :=
        old.source_cleared_date is null
        and old.source_cleared_connector is null
        and new.source_cleared_date is not null
        and new.source_cleared_connector is not null
        and length(btrim(new.source_cleared_connector)) > 0;
      if (v_recon_same or v_recon_statement_stamp or v_recon_source_stamp)
         and (v_source_same or v_source_stamp) then
        return new;
      end if;
      raise exception 'journal-line reconciliation evidence is append-only';
    end if;
    -- Re-materializing posted ledger history's GL-Impact projection from its
    -- edited source document (engine-only 'openbooks.amend' flag). A reversed
    -- original remains reversed; a posted entry remains posted. Balance and
    -- account guards still fire on the amended lines.
    if v_status in ('posted', 'reversed')
       and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
      -- Branch: clone-authority-insert (0316). The deterministic clone
      -- replays posted history verbatim into target periods that may already
      -- be closed there; the closed-period raise below would refuse the copy
      -- even though the history was valid where it was written. Under the
      -- clone authority an INSERT carries that history across, still subject
      -- to the tenant-coherent parent lookup above and to every balance and
      -- account guard. UPDATE and DELETE fall through to the period check
      -- and stay blocked in closed periods exactly as before.
      if tg_op = 'INSERT' and public.openbooks_clone_authority() then
        return new;
      end if;
      if period_module_blocks_write(v_org, v_period, v_book,
           nullif(coalesce(to_jsonb(new), to_jsonb(old))->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
        raise exception 'period is closed for GL posting';
      end if;
      return coalesce(new, old);
    end if;
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;

CREATE OR REPLACE FUNCTION public.depreciation_non_gl_recognition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  book_id uuid;
  subsidiary_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.non_gl_recognized_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'recognized reporting-book depreciation is immutable; retain this line and rebuild only unrecognized schedule lines';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.non_gl_recognized_at IS NULL THEN RETURN NEW; END IF;

  -- A recognition completes an existing measurement, never rewrites a posted
  -- one or launders imported/GL evidence into the reporting-only path.
  IF NEW.posted_amount IS NULL OR NEW.posted_amount IS DISTINCT FROM NEW.planned_amount
     OR NEW.journal_entry_id IS NOT NULL OR NEW.source = 'imported'
     OR (TG_OP = 'UPDATE' AND OLD.posted_amount IS NOT NULL) THEN
    RAISE EXCEPTION 'reporting-book recognition requires its unrecognized planned amount and no GL journal';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(NEW) - ARRAY['posted_amount','non_gl_recognized_at','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['posted_amount','non_gl_recognized_at','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'recognize the existing depreciation measurement before proposing a separate correction';
  END IF;
  -- Branch: clone-authority-insert (0316). The deterministic clone replays
  -- recognized reporting-book history verbatim. The referenced book, asset
  -- and period rows may not be visible yet — bulk-copy order is not
  -- topological inside a reference cycle, so a row trigger cannot assume its
  -- parents were copied first (the deferred foreign keys validate them at
  -- commit instead) — and the target period may already be closed there, even
  -- though the recognition was valid where it was written. Skip the
  -- live-state revalidation below for the copied row: the shape checks above
  -- still ran, the CHECK constraints still apply, and the row keeps its
  -- source recognition instant verbatim instead of restamping it. INSERT-only:
  -- an UPDATE or DELETE under the authority still runs every check below.
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  SELECT b.id, a.subsidiary_id INTO book_id, subsidiary_id
    FROM public.depreciation_schedules s
    JOIN public.accounting_books b ON b.id = s.book_id AND b.org_id = s.org_id
    JOIN public.fixed_assets a ON a.id = s.asset_id AND a.org_id = s.org_id
    JOIN public.accounting_periods p ON p.id = NEW.period_id AND p.org_id = s.org_id
   WHERE s.id = NEW.schedule_id AND s.org_id = NEW.org_id
     AND b.is_active AND NOT b.posts_gl
     AND a.status NOT IN ('disposed', 'written_off')
   FOR SHARE OF b;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reporting-book recognition requires an active non-posting book and an active asset and period in the same organization';
  END IF;
  IF NEW.updated_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = NEW.updated_by AND u.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'depreciation recognition actor must belong to the same organization';
  END IF;
  PERFORM public.period_posting_fence(NEW.org_id, NEW.period_id, book_id);
  IF public.period_module_blocks_write(NEW.org_id, NEW.period_id, book_id, subsidiary_id, 'assets', false)
     OR public.period_module_blocks_write(NEW.org_id, NEW.period_id, book_id, subsidiary_id, 'gl', false) THEN
    RAISE EXCEPTION 'the accounting book is closed for depreciation; obtain an authorized period reopening before running depreciation';
  END IF;
  -- An operator cannot backdate the recognition timestamp used by reversal
  -- guards. The effective service period remains NEW.period_id.
  NEW.non_gl_recognized_at := clock_timestamp();
  NEW.updated_at := NEW.non_gl_recognized_at;
  RETURN NEW;
END $$;
