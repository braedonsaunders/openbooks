-- OpenBooks forward migration 0669_reconciliation_signoff_withdrawal.
--
-- A signed-off bank reconciliation may be withdrawn, newest first, when
-- Banking is open for its period: the engine returns the session to an
-- unsigned state and releases the reconciliation stamp it placed on matched
-- journal lines, recording the reason and the prior sign-off in the audit
-- log. The journal-line guard refused every clearing of that stamp. This
-- admits exactly one more transition: clearing a line's stamp wholly, for
-- the reconciliation named by a transaction-scoped marker, once that
-- reconciliation is no longer signed off. Every other ledger rule is
-- unchanged.
--
-- Backfill: none. CREATE OR REPLACE on the guard function only — no schema,
-- data, or privilege change.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

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
  v_recon_withdrawal boolean;
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
    -- on posted lines. That is bookkeeping metadata, but it is still
    -- financial-control evidence: it may transition from entirely unset to an
    -- extant unsigned reconciliation that already claims the line, and clear
    -- only through the governed sign-off withdrawal below. Retargeting or
    -- partially stamping the evidence is forbidden.
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
      -- Governed sign-off withdrawal (0669): the engine has already returned
      -- the reconciliation to an unsigned state under the account lock and
      -- names it in a transaction-scoped marker. Only that reconciliation's
      -- stamp may clear, wholly, and the audit row lands in the same
      -- transaction.
      v_recon_withdrawal :=
        old.reconciled_at is not null
        and old.reconciliation_id is not null
        and new.reconciled_at is null
        and new.reconciliation_id is null
        and current_setting('app.reconciliation_withdrawal', true) = old.reconciliation_id::text
        and exists (
          select 1
            from reconciliations r
           where r.id = old.reconciliation_id
             and r.org_id = old.org_id
             and r.status <> 'signed_off'
        );
      if (v_recon_same or v_recon_statement_stamp or v_recon_source_stamp or v_recon_withdrawal)
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
