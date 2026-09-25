-- OpenBooks forward migration 0400_ledger_guard_reversal_and_clone_authority.
--
-- Migration 0380 (append-only) re-created je_guard()/jl_guard() without
-- their amend escapes — intended — but also dropped three load-bearing
-- controls that have nothing to do with amend:
--
-- 1. Reversal evidence (0166, Finding 5.2): posted -> reversed again flips
--    with no supporting mirror entry. A bare flip retires posted history
--    from every posted-only reader with no offsetting economics — the exact
--    silent-suppression shape 0166 closed. Every engine correction path
--    (document-void, posting-replay, source-deletions, inventory, assets,
--    consolidation, payments, revenue, projects, tax provision) posts its
--    mirror reversal through postEntry BEFORE marking the original reversed,
--    so all product paths already satisfy the check synchronously; only
--    unevidenced flips are refused.
-- 2. Clone authority (0316, OM-13): jl_guard() lost the
--    openbooks_clone_authority() INSERT bypass, so the deterministic sandbox
--    clone cannot replay posted history (every journal_lines copy refuses
--    with "lines of a posted journal entry are immutable"). The bypass needs
--    no amend escape: the authority is the conjunction of four GUCs that
--    only the clone transaction holds, and it admits INSERT only.
-- 3. Soft-close-aware delete fence (0338 section G5): the DELETE branch went
--    back to period_module_is_closed (true only for state = 'closed') while
--    the sibling update branches use period_module_blocks_write, so a delete
--    in a soft_closed period slips past the fence — the G5 regression, back.
--
-- This migration re-creates both guards from their 0380 bodies with those
-- three controls restored and nothing else changed: no amend escape returns
-- (0380's append-only direction stands), no data touched. Branch markers
-- (-- Branch: <name>) are load-bearing: the journal-status and journal-line
-- guard suites pin every branch by name so no future rewrite can silently
-- drop one again.
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
  -- Branch: journal-entry-delete (sandbox-wipe passthrough, posted/reversed delete fence).
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
    -- G5 (0338, restored in 0400): the delete fence is soft-close-aware
    -- like its sibling update branches. period_module_is_closed is true
    -- only for state = 'closed', so it let soft_closed deletes through,
    -- contradicting 0246's rule that a soft close fences posting the same
    -- way a hard close does.
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
      raise exception 'period is closed for GL posting';
    end if;
    return old;
  end if;

  -- Branch: posted-immutability (append-only: the only exit from posted is
  -- the evidenced reversal below; the amend same-status replay is gone by
  -- design and intentionally has no branch). The refusal names the remedy,
  -- which exists: corrections append a reversal through the ledger API
  -- (postEntry + markEntryReversed).
  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable: corrections append a reversal through the ledger API instead of editing history', old.id;
  end if;
  -- A posted entry may only leave posted status through controlled reversal
  -- (posted -> reversed). Any other regression — in particular posted ->
  -- draft, which would silently suppress posted history from every
  -- posted-only reader — raises here. No product flow writes posted -> draft.
  if old.status = 'posted' and new.status <> 'reversed' then
    raise exception 'journal entry % is posted and can only be reversed, not set to %', old.id, new.status;
  end if;
  -- Branch: reversal-evidence (0166, restored in 0400). posted -> reversed
  -- retires history, so the economics must already be offset: no economic
  -- header change may accompany the flip (only the lifecycle stamp and
  -- row-audit columns may differ), and a posted mirror reversal must exist
  -- in the same org and book referencing this entry. Existence, not
  -- uniqueness: reversal of a reversal and re-correction generations stay
  -- legal.
  if old.status = 'posted' and new.status = 'reversed' then
    if to_jsonb(old) - 'status' - 'updated_at' - 'updated_by' - 'posted_at'
       is distinct from
       to_jsonb(new) - 'status' - 'updated_at' - 'updated_by' - 'posted_at' then
      raise exception 'journal entry % is posted and can only be reversed without other changes', old.id;
    end if;
    if not exists (
      select 1
        from journal_entries reversal
       where reversal.org_id = old.org_id
         and reversal.book_id = old.book_id
         and reversal.reverses_entry_id = old.id
         and reversal.status = 'posted'
         and public.openbooks_reversal_mirrors(old.org_id, old.id, reversal.id)
    ) then
      raise exception 'journal entry % cannot be reversed without a posted mirror reversal in the same book', old.id;
    end if;
    return new;
  end if;
  -- Branch: reversed-immutable.
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  -- Branch: draft-post (f2/0168 owns the source-module recheck inside this block).
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

COMMENT ON FUNCTION public.je_guard() IS
  'openbooks:je_guard:v7 - append-only kernel guard for journal entry mutations (0380) with the reversal-evidence branch (0166) and the soft-close-aware delete fence (0338 G5) restored (0400); the amend escapes stay removed by design';

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
    -- Branch: clone-authority-insert (0316, restored in 0400). The
    -- deterministic clone replays posted history verbatim into target
    -- periods that may already be closed there; the immutability raise
    -- below would refuse the copy even though the history was valid where
    -- it was written. Under the clone authority an INSERT carries that
    -- history across, still subject to the tenant-coherent parent lookup
    -- above and to every balance and account guard. UPDATE and DELETE fall
    -- through and stay blocked exactly as before. This needs no amend
    -- escape: the authority is the conjunction of four GUCs only the clone
    -- transaction holds.
    if tg_op = 'INSERT' and public.openbooks_clone_authority() then
      return new;
    end if;
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
    -- posted or reversed line admits clone replay, reconciliation-evidence
    -- stamps and party-attribution moves above; everything else is immutable.
    raise exception 'lines of a % journal entry are immutable', v_status;
  end if;
  return coalesce(new, old);
end $$;
