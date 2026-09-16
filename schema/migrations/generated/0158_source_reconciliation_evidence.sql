-- OpenBooks forward migration 0158_source_reconciliation_evidence.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Mirror tenants never import bank statements, yet bank reconciliation is a
-- close blocker. The source system (the reference connector today; others where
-- their API exposes it) already holds cleared/reconciled markers per
-- transaction line. This migration gives that evidence a home so the mirror
-- can carry it instead of inventing statement lines:
--
-- - journal_lines gains the source's cleared stamp (date + connector key),
--   append-only: set once from entirely unset, never cleared or retargeted.
-- - reconciliations gains the evidence kind (statement vs source) plus the
--   connector key for source-evidenced sign-offs.
-- - source_reconciliation_state holds the source's last reconciled-through
--   date (and statement balance where the source states one) per
--   reconcilable account, as observed by the mirror.
--
-- Additive and history-preserving: new columns default to the legacy meaning
-- (unstamped lines, statement evidence), no row is touched, and the posted-
-- history guards below admit only the two new append-only evidence
-- transitions beside the existing statement sign-off stamp.
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- 1. The source's cleared stamp on mirrored journal lines. -------------------
ALTER TABLE public.journal_lines
  ADD COLUMN IF NOT EXISTS source_cleared_date date,
  ADD COLUMN IF NOT EXISTS source_cleared_connector text;

ALTER TABLE public.journal_lines DROP CONSTRAINT IF EXISTS journal_lines_source_cleared_evidence;
ALTER TABLE public.journal_lines ADD CONSTRAINT journal_lines_source_cleared_evidence CHECK ((
  (source_cleared_date IS NULL AND source_cleared_connector IS NULL)
  OR (source_cleared_date IS NOT NULL AND source_cleared_connector IS NOT NULL
      AND length(btrim(source_cleared_connector)) > 0)
));

COMMENT ON COLUMN public.journal_lines.source_cleared_date IS
  'Source-system cleared date mirrored as evidence (0158): the day the source connector reports this line cleared. Set once by the mirror; never edited.';
COMMENT ON COLUMN public.journal_lines.source_cleared_connector IS
  'Stable connector key (the connection source key) that reported the cleared stamp. Always set exactly when source_cleared_date is set.';

-- 2. The evidence kind on reconciliation sign-offs. --------------------------
ALTER TABLE public.reconciliations
  ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'statement',
  ADD COLUMN IF NOT EXISTS evidence_connector text;

ALTER TABLE public.reconciliations DROP CONSTRAINT IF EXISTS reconciliations_evidence_kind;
ALTER TABLE public.reconciliations ADD CONSTRAINT reconciliations_evidence_kind CHECK ((
  evidence_kind = ANY (ARRAY['statement'::text, 'source'::text])
));

ALTER TABLE public.reconciliations DROP CONSTRAINT IF EXISTS reconciliations_source_evidence;
ALTER TABLE public.reconciliations ADD CONSTRAINT reconciliations_source_evidence CHECK ((
  (evidence_kind = 'source'::text AND evidence_connector IS NOT NULL
    AND length(btrim(evidence_connector)) > 0)
  OR (evidence_kind = 'statement'::text AND evidence_connector IS NULL)
));

COMMENT ON COLUMN public.reconciliations.evidence_kind IS
  'What the sign-off stands on (0158): statement = matched imported statement lines; source = the connector-mirrored cleared evidence, with no statement lines invented.';
COMMENT ON COLUMN public.reconciliations.evidence_connector IS
  'Stable connector key (the connection source key) for source-evidenced sign-offs; null for statement sign-offs.';

-- 3. Per-account source reconciliation state, as observed by the mirror. -----
CREATE TABLE IF NOT EXISTS public.source_reconciliation_state (
    org_id uuid NOT NULL,
    account_id uuid NOT NULL,
    connector text NOT NULL,
    reconciled_through date NOT NULL,
    source_balance numeric(19,4),
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_reconciliation_state_connector_chk CHECK ((length(btrim(connector)) > 0))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'source_reconciliation_state_pkey'
  ) THEN
    ALTER TABLE ONLY public.source_reconciliation_state
      ADD CONSTRAINT source_reconciliation_state_pkey PRIMARY KEY (org_id, account_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'source_reconciliation_state_account_id_fkey'
  ) THEN
    ALTER TABLE ONLY public.source_reconciliation_state
      ADD CONSTRAINT source_reconciliation_state_account_id_fkey
      FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE;
  END IF;
END
$$;

ALTER TABLE ONLY public.source_reconciliation_state FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'source_reconciliation_state'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.source_reconciliation_state
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.source_reconciliation_state IS 'openbooks:org_isolation:v1';

ALTER TABLE public.source_reconciliation_state ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.source_reconciliation_state IS
  'Source-system reconciliation state mirrored as evidence (0158): per reconcilable account, the connector key, the last reconciled-through date the mirror derived from cleared markers, and the source statement balance where the source states one.';

-- 4. Posted-history guards admit the two new append-only evidence paths. -----
-- Statement sign-off stamping is unchanged. Beside it, the mirror may stamp
-- source-cleared evidence (unset -> set, never moved), and a source-evidenced
-- sign-off may stamp reconciled_at/reconciliation_id on lines that already
-- carry source-cleared evidence (mirror tenants import no statements, so no
-- statement match can exist for them).
CREATE OR REPLACE FUNCTION public.jl_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_status text;
  v_org uuid;
  v_period uuid;
  v_book uuid;
  v_recon_same boolean;
  v_recon_statement_stamp boolean;
  v_recon_source_stamp boolean;
  v_source_same boolean;
  v_source_stamp boolean;
begin
  if tg_op = 'DELETE' and openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  select status, org_id, period_id, book_id into v_status, v_org, v_period, v_book from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
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

-- 5. The governed SELECT-only view carries the new evidence columns. ---------
-- Re-create rather than replace: an installation whose view gained
-- posting_date by a later ALTER lists its columns in a different order than a
-- fresh bootstrap, and CREATE OR REPLACE VIEW refuses to reorder columns
-- ("cannot change name of view column"). Nothing depends on this view, and
-- the read role's grant is restored explicitly below.
DROP VIEW IF EXISTS openbooks_query.journal_lines;
CREATE VIEW openbooks_query.journal_lines WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    entry_id,
    line_number,
    account_id,
    amount,
    currency,
    txn_amount,
    fx_rate,
    memo,
    party_id,
    department_id,
    project_id,
    location_id,
    class_id,
    payment_card_id,
    extra_dims,
    posting_date,
    quantity,
    unit,
    due_date,
    is_open_item,
    tax_code_id,
    reconciled_at,
    reconciliation_id,
    custom,
    subsidiary_id,
    equipment_unit_id,
    source_cleared_date,
    source_cleared_connector
   FROM public.journal_lines
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON openbooks_query.journal_lines TO openbooks_read;
