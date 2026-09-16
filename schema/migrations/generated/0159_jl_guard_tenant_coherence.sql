-- OpenBooks forward migration 0159_jl_guard_tenant_coherence.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- 0158 re-created public.jl_guard() to admit the append-only source-cleared
-- evidence transitions, but its rewrite looked the parent journal entry up by
-- id alone. 0038 had scoped that lookup by the line's organization and raised
-- a 23503 ("journal entry % does not exist in organization %") when a line
-- referenced another tenant's entry; without it a cross-organization line
-- was refused only by later guards with a different error, and the
-- kernel-constraints canary (which pins the tenant-coherence contract) went
-- red on every fresh bootstrap. This migration re-creates jl_guard() as the
-- 0158 body plus the restored org-scoped lookup. No data is touched.
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
  -- Tenant coherence (restored from 0038): a line may only ever reference a
  -- journal entry of its OWN organization. The entry lookup is scoped by the
  -- line's org and a miss raises the foreign-key class error the ledger
  -- guards and the kernel-constraints canary rely on.
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
