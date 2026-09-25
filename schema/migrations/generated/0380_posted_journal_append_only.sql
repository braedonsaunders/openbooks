-- OpenBooks forward migration 0380_posted_journal_append_only.
--
-- Posted journals are append-only: a correction appends a reversal entry
-- through the ledger API (linking reverses_entry_id) and marks the original
-- reversed through the single governed posted -> reversed status transition.
-- In-place rewrites of posted or reversed entries and lines are refused with
-- no session-flag escape hatch.
--
-- What changes, and why. The je_guard() and jl_guard() storage triggers
-- below are re-created from their current bodies (0078 and 0165) with the
-- 'openbooks.amend' escape branches REMOVED:
--
-- - je_guard(): a non-draft entry can no longer be deleted under amend, and
--   a posted -> posted header regeneration under amend no longer passes.
--   The only transitions a posted entry still admits are the governed ones
--   the guards always allowed without amend: posted -> reversed (the
--   reversal marker every correction path writes through markEntryReversed)
--   and draft -> posted (the posting gate, with its period checks intact).
-- - jl_guard(): the original-parent move escape and the posted-line
--   re-materialization escape under amend are removed. The
--   bank-reconciliation and source-cleared evidence branches are kept
--   byte-identical: stamps move null -> set once and never rewrite amounts.
--   A party-attribution carve-out is added in their place: an UPDATE that
--   changes ONLY party_id is admitted when the period is open for GL
--   posting, so the governed party-merge path (which pre-checks closed
--   periods, retains blocked rows, deactivates the absorbed party, and
--   audits the merge) keeps working. Amounts, accounts, subsidiaries,
--   currencies, and every other column stay immutable without exception.
--
-- A GUC the application role can set is not enforcement, so no replacement
-- flag is introduced. The sandbox-wipe carve-outs stay: wiping a sandbox
-- destroys the whole organization, it does not edit history.
--
-- The reversal marker (posted -> reversed) intentionally remains: every
-- correction, void, and source-deletion path links its reversal through
-- reverses_entry_id AND marks the original reversed, and reports, caches,
-- and guards read that marker. The original's financial content is never
-- edited; only the lifecycle status advances.
--
-- No data is touched. The preflight (schema/migrations/preflight/
-- 0380_posted_journal_append_only.sql) refuses the upgrade while a posted
-- or reversed entry carries unbalanced lines or no lines at all — states
-- the append-only regime cannot produce and the new triggers assume absent.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.je_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    -- Append-only (0380): a posted or reversed entry cannot be deleted, with
    -- no session-flag escape. Corrections reverse and repost; they never
    -- remove history.
    if old.status <> 'draft' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    if period_module_is_closed(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl') then
      raise exception 'period is closed for GL posting';
    end if;
    return old;
  end if;

  -- Append-only (0380): the posted -> posted in-place regeneration branch is
  -- gone. A posted entry advances only to reversed through the governed
  -- reversal marker, with every other column frozen; a reversed entry
  -- advances nowhere. Corrections append a reversal through the ledger API.
  if old.status = 'posted' and new.status = 'reversed'
     and to_jsonb(new) - 'status' - 'updated_at' - 'updated_by' - 'posted_at'
       = to_jsonb(old) - 'status' - 'updated_at' - 'updated_by' - 'posted_at' then
    return new;
  end if;
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;
  if old.status = 'posted' then
    raise exception 'journal entry % is posted and immutable: corrections append a reversal through the ledger API instead of editing history', old.id;
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
    -- Original-parent immutability (0165, hardened in 0380): a line that
    -- leaves posted or reversed history for a different entry or
    -- organization is refused, with no session-flag escape. Evidence-only
    -- stamps never move lines, so any such move is a history rewrite.
    if v_old_status is distinct from 'draft'
       and (new.entry_id is distinct from old.entry_id
            or new.org_id is distinct from old.org_id) then
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
    -- Party-attribution moves (0380): the governed party-merge path
    -- re-points an absorbed party on posted lines. That changes NO amount,
    -- account, subsidiary, currency, or memo — party_id is the only column
    -- that may differ — and the move is refused when the period is closed
    -- for GL posting. There is no session-flag escape.
    if tg_op = 'UPDATE'
       and to_jsonb(new) - 'party_id' = to_jsonb(old) - 'party_id'
       and new.party_id is distinct from old.party_id
    then
      if period_module_blocks_write(v_org, v_period, v_book,
           nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
           coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
        raise exception 'period is closed for GL posting';
      end if;
      return new;
    end if;
    -- Append-only (0380): the amend re-materialization branch is gone. A
    -- posted or reversed line admits reconciliation-evidence stamps and
    -- party-attribution moves above; everything else is immutable.
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;
