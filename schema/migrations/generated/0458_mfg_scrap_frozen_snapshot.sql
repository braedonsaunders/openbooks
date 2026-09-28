-- OpenBooks forward migration 0458_mfg_scrap_frozen_snapshot.
--
-- Freeze the scrap valuation snapshot on mfg_scrap_events. Every new column
-- is nullable: events recorded before this upgrade keep all seven null, the
-- sole legacy state, and are refused by name on the approval, posting,
-- replay, and report paths (owned downstream) — never priced as zero and
-- never backfilled or inferred. The stage writer fills the group at once;
-- the coherence checks below refuse a torn group, and the immutability
-- trigger refuses any later rewrite of a frozen snapshot while admitting the
-- single controlled legacy-to-complete normalization.
--
-- Treatment branches (exact): evidence prices normal scrap at zero with no
-- frozen lineage; pre_issue_component prices abnormal component scrap before
-- issue against the plan fingerprint; post_issue_component and operation
-- price abnormal scrap after issue or at the operation with no fingerprint
-- and no frozen lot/serial. The fingerprint is always lower-hex 64.
--
-- The frozen lot/serial lineage points at tenant-safe (org_id, id) parent
-- keys added here. The financial_changes evidence ledger gains the
-- manufacturing domain (discovered by shape, never assumed by name) with a
-- same-organization subject/payload binding for the controlled scrap
-- restatement, including the engine-derived approval_required, plus one
-- live proposal per event. Clone replay admission is preserved.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Tenant-safe lot parent: the (org_id, id) anchor the frozen lot reference
-- points at. Implied by the id primary key, so no backfill.
ALTER TABLE ONLY public.lots
  ADD CONSTRAINT lots_org_id_id_uniq UNIQUE (org_id, id);

-- Tenant-safe serial parent: the (org_id, id) anchor the frozen serial
-- reference points at. Implied by the id primary key, so no backfill.
ALTER TABLE ONLY public.serials
  ADD CONSTRAINT serials_org_id_id_uniq UNIQUE (org_id, id);

-- Frozen valuation snapshot (7): treatment, frozen value and unit cost in
-- minor money, frozen lot/serial lineage, plan fingerprint, and the
-- engine-derived approval flag. Null until staged; legacy rows keep all
-- seven null and are refused by name downstream, never priced as zero.
ALTER TABLE public.mfg_scrap_events
  ADD COLUMN treatment text,
  ADD COLUMN frozen_value numeric(19,4),
  ADD COLUMN frozen_unit_cost numeric(19,4),
  ADD COLUMN lot_id uuid,
  ADD COLUMN serial_id uuid,
  ADD COLUMN plan_fingerprint text,
  ADD COLUMN approval_required boolean;

-- The frozen lot reference. Frozen lineage never couples to live inventory
-- configuration beyond the tenant-safe parent key.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_events_org_lot_fk
    FOREIGN KEY (org_id, lot_id)
    REFERENCES public.lots(org_id, id) ON DELETE RESTRICT DEFERRABLE;
CREATE INDEX mfg_scrap_events_org_lot_idx
  ON public.mfg_scrap_events (org_id, lot_id);

-- The frozen serial reference, under the same tenant-safe terms.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_events_org_serial_fk
    FOREIGN KEY (org_id, serial_id)
    REFERENCES public.serials(org_id, id) ON DELETE RESTRICT DEFERRABLE;
CREATE INDEX mfg_scrap_events_org_serial_idx
  ON public.mfg_scrap_events (org_id, serial_id);

-- Coherence: the snapshot group is absent together (legacy) or treated with
-- a frozen approval flag; a partial group is a torn write, not a priceable
-- state. The per-treatment checks below admit only the matching branch.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_snapshot_legacy_or_complete_chk CHECK (
    (treatment IS NULL AND frozen_value IS NULL AND frozen_unit_cost IS NULL
      AND lot_id IS NULL AND serial_id IS NULL AND plan_fingerprint IS NULL
      AND approval_required IS NULL)
    OR (treatment IN ('evidence', 'pre_issue_component', 'post_issue_component', 'operation')
      AND approval_required IS NOT NULL));

-- Coherence: evidence prices normal scrap at zero with no frozen lineage.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_snapshot_evidence_chk CHECK (
    treatment <> 'evidence'
    OR (classification = 'normal'
      AND frozen_value = 0.0000
      AND frozen_unit_cost IS NULL
      AND plan_fingerprint IS NULL
      AND lot_id IS NULL
      AND serial_id IS NULL
      AND approval_required = false));

-- Coherence: pre-issue component scrap is abnormal, tied to a component but
-- no operation, positively valued, and fingerprinted to the plan.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_snapshot_pre_issue_chk CHECK (
    treatment <> 'pre_issue_component'
    OR (classification = 'abnormal'
      AND component_item_id IS NOT NULL
      AND operation_id IS NULL
      AND frozen_value > 0
      AND frozen_unit_cost IS NOT NULL
      AND frozen_unit_cost >= 0
      AND plan_fingerprint ~ '^[0-9a-f]{64}$'
      AND approval_required IS NOT NULL));

-- Coherence: post-issue component scrap is abnormal, tied to a component at
-- an operation, positively valued, with no fingerprint or frozen lot/serial.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_snapshot_post_issue_chk CHECK (
    treatment <> 'post_issue_component'
    OR (classification = 'abnormal'
      AND component_item_id IS NOT NULL
      AND operation_id IS NOT NULL
      AND frozen_value > 0
      AND frozen_unit_cost IS NOT NULL
      AND frozen_unit_cost >= 0
      AND plan_fingerprint IS NULL
      AND lot_id IS NULL
      AND serial_id IS NULL
      AND approval_required IS NOT NULL));

-- Coherence: operation scrap is abnormal, tied to an operation with no
-- component, positively valued, with no fingerprint or frozen lot/serial.
ALTER TABLE ONLY public.mfg_scrap_events
  ADD CONSTRAINT mfg_scrap_snapshot_operation_chk CHECK (
    treatment <> 'operation'
    OR (classification = 'abnormal'
      AND operation_id IS NOT NULL
      AND component_item_id IS NULL
      AND frozen_value > 0
      AND frozen_unit_cost IS NOT NULL
      AND frozen_unit_cost >= 0
      AND plan_fingerprint IS NULL
      AND lot_id IS NULL
      AND serial_id IS NULL
      AND approval_required IS NOT NULL));

-- Immutability: the snapshot group moves only as the single legacy-to-
-- complete normalization written by the controlled restatement apply; the
-- coherence checks above admit only the complete end state. Lineage and
-- classification are never re-pointed, and posting linkage is made once and
-- never rewritten or cleared. No INSERT trigger, so migrated all-null legacy
-- rows stay constructible. Any refusal rolls the whole transaction back.
CREATE FUNCTION public.mfg_scrap_snapshot_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS
$fn$
BEGIN
  IF (NEW.work_order_id IS DISTINCT FROM OLD.work_order_id)
    OR (NEW.operation_id IS DISTINCT FROM OLD.operation_id)
    OR (NEW.component_item_id IS DISTINCT FROM OLD.component_item_id)
    OR (NEW.quantity IS DISTINCT FROM OLD.quantity)
    OR (NEW.reason_id IS DISTINCT FROM OLD.reason_id)
    OR (NEW.classification IS DISTINCT FROM OLD.classification)
  THEN
    RAISE EXCEPTION 'scrap event % for work order % carries frozen lineage that cannot be re-pointed; file a new event instead', NEW.id, NEW.work_order_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.treatment IS NOT NULL OR NEW.treatment IS NULL THEN
    IF (NEW.treatment IS DISTINCT FROM OLD.treatment)
      OR (NEW.frozen_value IS DISTINCT FROM OLD.frozen_value)
      OR (NEW.frozen_unit_cost IS DISTINCT FROM OLD.frozen_unit_cost)
      OR (NEW.lot_id IS DISTINCT FROM OLD.lot_id)
      OR (NEW.serial_id IS DISTINCT FROM OLD.serial_id)
      OR (NEW.plan_fingerprint IS DISTINCT FROM OLD.plan_fingerprint)
      OR (NEW.approval_required IS DISTINCT FROM OLD.approval_required)
    THEN
      RAISE EXCEPTION 'scrap event % for work order % carries a frozen valuation snapshot that cannot be rewritten; normalize a legacy event only through a controlled restatement proposal', NEW.id, NEW.work_order_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.posted_entry_id IS NOT NULL
    AND NEW.posted_entry_id IS DISTINCT FROM OLD.posted_entry_id
  THEN
    RAISE EXCEPTION 'scrap event % is already linked to posted entry %; posting linkage cannot be rewritten or cleared, correct through reversal or an adjusting entry', NEW.id, OLD.posted_entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mfg_scrap_snapshot_immutable_trg
  BEFORE UPDATE ON public.mfg_scrap_events
  FOR EACH ROW EXECUTE FUNCTION public.mfg_scrap_snapshot_immutable_guard();

-- The manufacturing domain joins the financial-change evidence ledger. The
-- domain check dates to 0202 as an inline (system-named) constraint, so the
-- name is discovered by shape and never assumed; the replacement keeps the
-- discovered name and admits exactly one new domain.
DO
$do$
DECLARE
  domain_check_name text;
BEGIN
  SELECT c.conname INTO domain_check_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'financial_changes'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%lease%revenue%asset%consolidation%';
  IF domain_check_name IS NULL THEN
    RAISE EXCEPTION 'financial_changes domain check carrying the lease/revenue/asset/consolidation domains was not found; refusing to extend an unknown ledger guard'
      USING ERRCODE = 'check_violation';
  END IF;
  EXECUTE format('ALTER TABLE public.financial_changes DROP CONSTRAINT %I', domain_check_name);
  EXECUTE format('ALTER TABLE public.financial_changes ADD CONSTRAINT %I CHECK (domain IN (''lease'', ''revenue'', ''asset'', ''consolidation'', ''manufacturing''))', domain_check_name);
END
$do$;

-- Manufacturing restatement binding on the evidence guard. The clone replay
-- admission below is preserved verbatim: the sandbox/sample-company clone
-- replays immutable terminal history under the clone authority while every
-- ordinary session keeps the born-draft and binding refusals.
CREATE OR REPLACE FUNCTION financial_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'financial changes are immutable evidence; propose a correcting change';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subsidiaries WHERE id=NEW.subsidiary_id AND org_id=NEW.org_id) THEN
    RAISE EXCEPTION 'financial change subsidiary must belong to the organization';
  END IF;
  IF TG_OP='INSERT' THEN
    -- OM-13c clone replay: the sandbox/sample-company clone replays
    -- immutable terminal history verbatim under the clone authority (0316:
    -- openbooks.clone with openbooks.migration and openbooks.amend asserted
    -- together inside runClone's own RLS-bypass maintenance transaction).
    -- Admit that replayed INSERT while every ordinary session keeps the
    -- born-draft refusal below. UPDATE and DELETE of this history stay
    -- blocked: this admission returns only on the INSERT path.
    IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'financial changes must start as draft'; END IF;
    -- MF-06c frozen scrap snapshots: a manufacturing change is admitted only
    -- for the controlled scrap restatement, bound by value to the staged
    -- event, its work order, and the booking subsidiary. The payload carries
    -- the engine-derived approval_required as immutable proposal evidence;
    -- no request, UI, or API surface supplies it, and the proposal payload
    -- is frozen after insert by the immutability check below.
    IF NEW.domain = 'manufacturing' THEN
      IF NEW.operation <> 'scrap_snapshot_restatement' THEN
        RAISE EXCEPTION 'manufacturing financial changes admit only the scrap_snapshot_restatement operation, not %', NEW.operation;
      END IF;
      IF NEW.payload IS NULL OR jsonb_typeof(NEW.payload) <> 'object' THEN
        RAISE EXCEPTION 'manufacturing scrap restatement proposals must carry an object payload binding the event, work order, subsidiary, and approval flag';
      END IF;
      IF NOT (NEW.payload ? 'event_id')
        OR NOT (NEW.payload ? 'work_order_id')
        OR NOT (NEW.payload ? 'subsidiary_id')
        OR NOT (NEW.payload ? 'requiredSubsidiaryIds') THEN
        RAISE EXCEPTION 'manufacturing scrap restatement proposals must bind event_id, work_order_id, subsidiary_id, and requiredSubsidiaryIds in the payload';
      END IF;
      IF jsonb_typeof(NEW.payload -> 'requiredSubsidiaryIds') <> 'array'
        OR jsonb_typeof(NEW.payload -> 'approval_required') <> 'boolean' THEN
        RAISE EXCEPTION 'manufacturing scrap restatement proposals must bind requiredSubsidiaryIds as an array and the engine-derived approval_required as a boolean';
      END IF;
      IF (NEW.payload ->> 'event_id') <> NEW.subject_id::text THEN
        RAISE EXCEPTION 'manufacturing scrap restatement subject must be the bound event';
      END IF;
      IF NOT EXISTS (
        SELECT 1
          FROM public.mfg_scrap_events scrap_event
          JOIN public.mfg_work_orders work_order
            ON work_order.org_id = scrap_event.org_id
           AND work_order.id = scrap_event.work_order_id
         WHERE scrap_event.org_id = NEW.org_id
           AND scrap_event.id = NEW.subject_id
           AND scrap_event.work_order_id::text = (NEW.payload ->> 'work_order_id')
           AND (NEW.payload ->> 'subsidiary_id') IS NOT DISTINCT FROM work_order.subsidiary_id::text
      ) THEN
        RAISE EXCEPTION 'manufacturing scrap restatement must bind the same-organization event, its work order, and that work order''s subsidiary';
      END IF;
      IF (NEW.payload -> 'requiredSubsidiaryIds') <> jsonb_build_array(NEW.subsidiary_id::text) THEN
        RAISE EXCEPTION 'manufacturing scrap restatement requiredSubsidiaryIds must be exactly the booking subsidiary';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'financial change proposal is immutable; create a new proposal';
  END IF;
  IF NOT ((OLD.status='draft' AND NEW.status='pending') OR
          (OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR
          (OLD.status='approved' AND NEW.status='applied')) THEN
    RAISE EXCEPTION 'invalid financial change transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'pending' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'financial change approval cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;

-- One live restatement proposal per event: a second draft, pending, or
-- approved proposal for the same event conflicts by name while rejected and
-- applied history stays append-only evidence.
CREATE UNIQUE INDEX financial_changes_manufacturing_live_proposal_uniq
  ON public.financial_changes (org_id, domain, operation, subject_id)
  WHERE domain = 'manufacturing'
    AND operation = 'scrap_snapshot_restatement'
    AND status IN ('draft', 'pending', 'approved');

-- No new tables, so no catalog relation registration; refresh column metadata.
SELECT public.openbooks_refresh_query_catalog();
