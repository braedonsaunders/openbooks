-- OpenBooks forward migration 0239_tax_consolidated_matching_periods.
-- Posted 1.1502-13 matching per vintage and registered tax year. Write-once:
-- an idempotent re-run reproduces the row; a different amount is a refusal.
-- Not a jsonb patch on tax_pool_periods and not tax_groups (sales-tax codes).
SET search_path=public,pg_catalog;

CREATE TABLE IF NOT EXISTS tax_consolidated_matching_periods (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES orgs(id),
 workpaper_id uuid NOT NULL,
 workpaper_change_id uuid NOT NULL,
 vintage_key text NOT NULL,
 parent_key text,
 tax_year_window_id uuid NOT NULL,
 year_start date NOT NULL,
 year_end date NOT NULL,
 group_key text NOT NULL,
 seller_subsidiary_id uuid NOT NULL,
 buyer_subsidiary_id uuid NOT NULL,
 membership_effective_on date NOT NULL,
 membership_through_on date NOT NULL,
 deferred_opening numeric(19,4) NOT NULL,
 actual_deduction numeric(19,4) NOT NULL,
 recomputed_deduction numeric(19,4) NOT NULL,
 actual_corresponding_amount numeric(19,4) NOT NULL,
 recomputed_corresponding_amount numeric(19,4) NOT NULL,
 seller_matching_amount numeric(19,4) NOT NULL,
 deferred_closing numeric(19,4) NOT NULL,
 prior_matching_period_id uuid,
 replay_change_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid NOT NULL REFERENCES users(id),
 UNIQUE (org_id, id),
 UNIQUE (org_id, workpaper_id, vintage_key, tax_year_window_id),
 CHECK (length(btrim(vintage_key)) BETWEEN 1 AND 400),
 CHECK (length(btrim(group_key)) BETWEEN 1 AND 400),
 CHECK (year_start <= year_end),
 CHECK (membership_effective_on <= membership_through_on),
 CHECK (seller_subsidiary_id <> buyer_subsidiary_id),
 FOREIGN KEY (org_id, workpaper_id) REFERENCES tax_asset_basis_workpapers(org_id,id),
 FOREIGN KEY (org_id, workpaper_change_id) REFERENCES financial_changes(org_id,id),
 FOREIGN KEY (org_id, tax_year_window_id) REFERENCES tax_year_windows(org_id,id),
 FOREIGN KEY (org_id, seller_subsidiary_id) REFERENCES subsidiaries(org_id,id),
 FOREIGN KEY (org_id, buyer_subsidiary_id) REFERENCES subsidiaries(org_id,id),
 FOREIGN KEY (org_id, prior_matching_period_id) REFERENCES tax_consolidated_matching_periods(org_id,id),
 FOREIGN KEY (org_id, replay_change_id) REFERENCES financial_changes(org_id,id),
 CHECK ((prior_matching_period_id IS NULL)=(replay_change_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_consolidated_matching_periods_identity
 ON tax_consolidated_matching_periods(org_id,workpaper_id,vintage_key,tax_year_window_id);
CREATE INDEX IF NOT EXISTS tax_consolidated_matching_periods_window
 ON tax_consolidated_matching_periods(org_id,tax_year_window_id);
CREATE INDEX IF NOT EXISTS tax_consolidated_matching_periods_prior
 ON tax_consolidated_matching_periods(org_id,prior_matching_period_id);
CREATE INDEX IF NOT EXISTS tax_consolidated_matching_periods_replay
 ON tax_consolidated_matching_periods(org_id,replay_change_id);
ALTER TABLE tax_consolidated_matching_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_consolidated_matching_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_consolidated_matching_periods;
CREATE POLICY org_isolation ON tax_consolidated_matching_periods
 USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON tax_consolidated_matching_periods IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE tax_consolidated_matching_periods IS
  'Write-once 1.1502-13 matching per receiving workpaper, vintage and registered tax year. A replacement paper appends new rows that cite prior_matching_period_id; historical amounts stay. Vintage keys are dates-and-parent within one paper, not a global asset key.';

CREATE OR REPLACE FUNCTION tax_consolidated_matching_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE registered tax_year_windows%ROWTYPE;
        paper tax_asset_basis_workpapers%ROWTYPE;
        prior_row tax_consolidated_matching_periods%ROWTYPE;
        replay financial_changes%ROWTYPE;
        paper_subject uuid;
        predecessor_id uuid;
        window_owner uuid;
        fence_id uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'posted 1.1502-13 matching preserves the tax year and cannot be deleted; approve a replacement tax basis workpaper so earlier years can be replayed from the cited historical row — there is no reversal of a computed tax year and posted matching cannot be overwritten';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.created_at,NEW.created_by,NEW.vintage_key,NEW.tax_year_window_id,NEW.workpaper_id,NEW.workpaper_change_id,
      NEW.parent_key,NEW.year_start,NEW.year_end,NEW.group_key,NEW.seller_subsidiary_id,NEW.buyer_subsidiary_id,
      NEW.membership_effective_on,NEW.membership_through_on,NEW.deferred_opening,NEW.actual_deduction,
      NEW.recomputed_deduction,NEW.actual_corresponding_amount,NEW.recomputed_corresponding_amount,
      NEW.seller_matching_amount,NEW.deferred_closing,NEW.prior_matching_period_id,NEW.replay_change_id)
     IS DISTINCT FROM
     (OLD.id,OLD.org_id,OLD.created_at,OLD.created_by,OLD.vintage_key,OLD.tax_year_window_id,OLD.workpaper_id,OLD.workpaper_change_id,
      OLD.parent_key,OLD.year_start,OLD.year_end,OLD.group_key,OLD.seller_subsidiary_id,OLD.buyer_subsidiary_id,
      OLD.membership_effective_on,OLD.membership_through_on,OLD.deferred_opening,OLD.actual_deduction,
      OLD.recomputed_deduction,OLD.actual_corresponding_amount,OLD.recomputed_corresponding_amount,
      OLD.seller_matching_amount,OLD.deferred_closing,OLD.prior_matching_period_id,OLD.replay_change_id) THEN
   RAISE EXCEPTION 'posted 1.1502-13 matching is write-once; a different amount is a refusal — approve a replacement tax basis workpaper so earlier years can be replayed from the cited historical row; there is no reversal of a computed tax year and posted matching cannot be overwritten';
  END IF;
  RETURN NEW;
 END IF;
 -- Same sorted seller/buyer/window-owner fence as native window writes
 -- (lockAssetTaxLifecycle). Peek the window owner without a row lock, then
 -- take every distinct legal-entity key in UUID order before FOR SHARE.
 SELECT subsidiary_id INTO window_owner
   FROM tax_year_windows
  WHERE org_id=NEW.org_id AND id=NEW.tax_year_window_id;
 FOR fence_id IN
   SELECT DISTINCT x FROM unnest(ARRAY[
     NEW.seller_subsidiary_id,
     NEW.buyer_subsidiary_id,
     window_owner
   ]) AS t(x)
   WHERE x IS NOT NULL
   ORDER BY 1
 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('asset-tax-lifecycle:'||NEW.org_id::text||':'||fence_id::text,0));
 END LOOP;
 SELECT * INTO registered FROM tax_year_windows
  WHERE org_id=NEW.org_id AND id=NEW.tax_year_window_id FOR SHARE;
 IF NOT FOUND OR registered.year_start IS DISTINCT FROM NEW.year_start
   OR registered.year_end IS DISTINCT FROM NEW.year_end
   OR registered.regime IS DISTINCT FROM 'us_macrs'
   OR registered.subsidiary_id IS DISTINCT FROM NEW.buyer_subsidiary_id THEN
  RAISE EXCEPTION '1.1502-13 matching dates must match the registered US MACRS tax year of the buyer; reload the year from tax-year setup — do not persist matching against an inferred book calendar or another legal entity''s window';
 END IF;
 SELECT * INTO paper FROM tax_asset_basis_workpapers
  WHERE org_id=NEW.org_id AND id=NEW.workpaper_id;
 IF NOT FOUND OR paper.regime IS DISTINCT FROM 'us_macrs'
   OR paper.change_id IS DISTINCT FROM NEW.workpaper_change_id THEN
  RAISE EXCEPTION '1.1502-13 matching must cite the applied US MACRS workpaper; reverse and re-propose it — do not persist matching without that change';
 END IF;
 IF NEW.prior_matching_period_id IS NOT NULL THEN
  SELECT * INTO prior_row FROM tax_consolidated_matching_periods
   WHERE org_id=NEW.org_id AND id=NEW.prior_matching_period_id;
  IF NOT FOUND
     OR prior_row.vintage_key IS DISTINCT FROM NEW.vintage_key
     OR prior_row.tax_year_window_id IS DISTINCT FROM NEW.tax_year_window_id
     OR prior_row.parent_key IS DISTINCT FROM NEW.parent_key
     OR prior_row.workpaper_id IS NOT DISTINCT FROM NEW.workpaper_id THEN
   RAISE EXCEPTION '1.1502-13 matching replay must cite the historical row for this vintage and tax year on the reversed workpaper — do not borrow another paper''s opening or invent a prior year';
  END IF;
  SELECT w.id INTO predecessor_id
    FROM tax_asset_basis_workpapers w
   WHERE w.org_id=NEW.org_id
     AND w.regime='us_macrs'
     AND w.reversed_by_change_id IS NOT NULL
     AND (
       (paper.source_change_id IS NOT NULL AND w.source_change_id=paper.source_change_id)
       OR (paper.source_event_id IS NOT NULL AND w.source_change_id IS NULL AND w.source_event_id=paper.source_event_id)
     )
   ORDER BY w.created_at DESC, w.id DESC
   LIMIT 1;
  SELECT * INTO replay FROM financial_changes
   WHERE org_id=NEW.org_id AND id=NEW.replay_change_id
     AND domain='asset'
     AND operation IN ('tax_matching_replay','tax_matching_generation_repair')
     AND status='approved';
  IF NOT FOUND THEN
   RAISE EXCEPTION '1.1502-13 matching replay must cite an approved tax_matching_replay or tax_matching_generation_repair; do not append matching from an unapproved change or from a tax year pool re-run';
  END IF;
  IF replay.operation='tax_matching_generation_repair' THEN
   IF predecessor_id IS NULL
      OR EXISTS (
        SELECT 1 FROM tax_consolidated_matching_periods m
         WHERE m.org_id=NEW.org_id AND m.workpaper_id=predecessor_id
      )
      OR prior_row.workpaper_id IS DISTINCT FROM (
        SELECT w.id FROM tax_asset_basis_workpapers w
         WHERE w.org_id=NEW.org_id
           AND w.regime='us_macrs'
           AND w.reversed_by_change_id IS NOT NULL
           AND (
             (paper.source_change_id IS NOT NULL AND w.source_change_id=paper.source_change_id)
             OR (paper.source_event_id IS NOT NULL AND w.source_change_id IS NULL AND w.source_event_id=paper.source_event_id)
           )
           AND EXISTS (
             SELECT 1 FROM tax_consolidated_matching_periods m
              WHERE m.org_id=w.org_id AND m.workpaper_id=w.id
           )
         ORDER BY w.created_at DESC, w.id DESC
         LIMIT 1
      )
      OR replay.before_state->>'skippedPredecessorId' IS DISTINCT FROM predecessor_id::text
      OR replay.before_state->>'repairedFromWorkpaperId' IS DISTINCT FROM prior_row.workpaper_id::text THEN
    RAISE EXCEPTION '1.1502-13 matching generation repair must cite the last same-source paper that still has posted matching after the empty immediately reversed predecessor; ordinary tax_matching_replay cannot skip a generation and a reversed paper cannot receive replay';
   END IF;
  ELSIF predecessor_id IS NULL OR prior_row.workpaper_id IS DISTINCT FROM predecessor_id THEN
   RAISE EXCEPTION '1.1502-13 matching replay must cite the immediately reversed predecessor workpaper for this replacement; reverse that paper and apply its replacement first — do not borrow an older paper''s opening or another source''s matching row';
  END IF;
  SELECT f.subject_id INTO paper_subject
    FROM financial_changes f
   WHERE f.org_id=NEW.org_id AND f.id=NEW.workpaper_change_id;
  IF replay.subject_id IS DISTINCT FROM paper_subject
     OR replay.payload->>'replacementWorkpaperId' IS DISTINCT FROM NEW.workpaper_id::text
     OR replay.payload->>'replacementWorkpaperChangeId' IS DISTINCT FROM NEW.workpaper_change_id::text
     OR jsonb_typeof(replay.payload->'citedHistoricalPeriodIds') IS DISTINCT FROM 'array'
     OR NOT (replay.payload->'citedHistoricalPeriodIds' @> to_jsonb(NEW.prior_matching_period_id::text))
     OR replay.before_state->'membership'->>'groupKey' IS DISTINCT FROM NEW.group_key
     OR replay.before_state->'membership'->>'sellerSubsidiaryId' IS DISTINCT FROM NEW.seller_subsidiary_id::text
     OR replay.before_state->'membership'->>'buyerSubsidiaryId' IS DISTINCT FROM NEW.buyer_subsidiary_id::text
     OR replay.before_state->'membership'->>'effectiveOn' IS DISTINCT FROM NEW.membership_effective_on::text
     OR replay.before_state->'membership'->>'throughOn' IS DISTINCT FROM NEW.membership_through_on::text
     OR jsonb_typeof(replay.before_state->'replayedPeriods') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(replay.before_state->'replayedPeriods') p
        WHERE p->>'vintageKey' IS NOT DISTINCT FROM NEW.vintage_key
          AND p->>'taxYearWindowId' IS NOT DISTINCT FROM NEW.tax_year_window_id::text
          AND p->>'yearStart' IS NOT DISTINCT FROM NEW.year_start::text
          AND p->>'yearEnd' IS NOT DISTINCT FROM NEW.year_end::text
          AND p->>'priorMatchingPeriodId' IS NOT DISTINCT FROM NEW.prior_matching_period_id::text
          AND (p->>'deferredOpening')::numeric IS NOT DISTINCT FROM NEW.deferred_opening
          AND (p->>'actualDeduction')::numeric IS NOT DISTINCT FROM NEW.actual_deduction
          AND (p->>'recomputedDeduction')::numeric IS NOT DISTINCT FROM NEW.recomputed_deduction
          AND (p->>'actualCorrespondingAmount')::numeric IS NOT DISTINCT FROM NEW.actual_corresponding_amount
          AND (p->>'recomputedCorrespondingAmount')::numeric IS NOT DISTINCT FROM NEW.recomputed_corresponding_amount
          AND (p->>'sellerMatchingAmount')::numeric IS NOT DISTINCT FROM NEW.seller_matching_amount
          AND (p->>'deferredClosing')::numeric IS NOT DISTINCT FROM NEW.deferred_closing
     ) THEN
   RAISE EXCEPTION '1.1502-13 matching replay must bind this row to the approved tax_matching_replay snapshot for this replacement workpaper and cited historical row; a same-org unrelated approved replay is not authorization — reload the replacement and approve the replay that names this paper, these cited IDs, and these replayed periods';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_consolidated_matching_period_guard ON tax_consolidated_matching_periods;
CREATE TRIGGER tax_consolidated_matching_period_guard
 BEFORE INSERT OR UPDATE OR DELETE ON tax_consolidated_matching_periods
 FOR EACH ROW EXECUTE FUNCTION tax_consolidated_matching_period_guard();

CREATE OR REPLACE FUNCTION tax_year_window_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_org uuid;
        subject_subsidiary uuid;
        cited boolean;
BEGIN
 IF TG_OP='DELETE' AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 subject_org := CASE WHEN TG_OP='INSERT' THEN NEW.org_id ELSE OLD.org_id END;
 subject_subsidiary := CASE WHEN TG_OP='INSERT' THEN NEW.subsidiary_id ELSE OLD.subsidiary_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended('asset-tax-lifecycle:'||subject_org::text||':'||subject_subsidiary::text,0));
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM tax_pool_periods WHERE org_id=OLD.org_id AND tax_year_window_id=OLD.id)
  OR EXISTS(SELECT 1 FROM tax_basis_window_citations WHERE org_id=OLD.org_id AND tax_year_window_id=OLD.id)
  OR EXISTS(SELECT 1 FROM tax_consolidated_matching_periods WHERE org_id=OLD.org_id AND tax_year_window_id=OLD.id)
  INTO cited;
 IF TG_OP='DELETE' THEN
  IF cited THEN RAISE EXCEPTION 'this tax-year window is cited by a computed result, approved tax workpaper or posted 1.1502-13 matching period and cannot be deleted; preserve its history'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.id,NEW.org_id,NEW.subsidiary_id,NEW.regime,NEW.year_start)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.subsidiary_id,OLD.regime,OLD.year_start) THEN
  RAISE EXCEPTION 'a tax-year window identity cannot be rewritten; delete an unused window through tax-year setup and declare the correct year';
 END IF;
 IF cited AND (NEW.year_end,NEW.filing_year) IS DISTINCT FROM (OLD.year_end,OLD.filing_year) THEN
  RAISE EXCEPTION 'this tax-year window is cited by a computed result, approved tax workpaper or posted 1.1502-13 matching period; its dates and filing label are frozen';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_year_window_history_guard ON tax_year_windows;
CREATE TRIGGER tax_year_window_history_guard BEFORE INSERT OR UPDATE OR DELETE ON tax_year_windows
 FOR EACH ROW EXECUTE FUNCTION tax_year_window_history_guard();

SELECT public.openbooks_refresh_query_catalog();
