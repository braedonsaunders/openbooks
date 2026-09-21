-- OpenBooks forward migration 0233_tax_asset_basis_workpapers.
-- Independently approved statutory tax-basis workpapers. Book buyerAmount,
-- group_component and acquisition_cost are not a tax basis. Historical rows
-- freeze computed outcomes so a later helper change cannot reprice a filed year.
-- seller_disposition / buyer_addition / remaining_basis are generated
-- numeric(19,4) columns: JSON is the audit evidence, typed money is what
-- pool-run consumes, and the two cannot diverge.
SET search_path=public,pg_catalog;

CREATE OR REPLACE FUNCTION tax_basis_frozen_money(value text) RETURNS numeric(19,4)
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF value IS NULL OR btrim(value)='' THEN RETURN NULL; END IF;
 IF value !~ '^-?[0-9]+(\.[0-9]{1,4})?$' THEN
  RAISE EXCEPTION 'tax basis frozen amount % is not a decimal with at most 4 places; reverse the workpaper and re-propose it', value;
 END IF;
 RETURN value::numeric(19,4);
END $$;

CREATE TABLE IF NOT EXISTS tax_asset_basis_workpapers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES orgs(id),
 asset_id uuid NOT NULL REFERENCES fixed_assets(id),
 change_id uuid NOT NULL REFERENCES financial_changes(id),
 source_change_id uuid REFERENCES financial_changes(id),
 source_event_id uuid REFERENCES asset_events(id),
 receiving_asset_id uuid REFERENCES fixed_assets(id),
 effective_on date NOT NULL,
 source_operation text NOT NULL CHECK (source_operation IN ('partial_disposal','intercompany_transfer')),
 applicable text NOT NULL CHECK (applicable IN ('seller','buyer','both')),
 regime text NOT NULL CHECK (regime IN ('ca_cca','uk_wda','au_pool','nz_pool','us_macrs')),
 assessment text NOT NULL CHECK (length(btrim(assessment)) BETWEEN 8 AND 4000),
 facts jsonb NOT NULL,
 computed jsonb NOT NULL,
 seller_disposition numeric(19,4) GENERATED ALWAYS AS (
  tax_basis_frozen_money(
   CASE regime
    WHEN 'ca_cca' THEN computed->>'dispositionAmount'
    WHEN 'uk_wda' THEN computed->>'disposalValue'
    WHEN 'au_pool' THEN computed->>'poolReduction'
    WHEN 'nz_pool' THEN computed->>'poolReduction'
    WHEN 'us_macrs' THEN COALESCE(computed->>'amountRealized', computed->>'disposedUnadjustedBasis')
   END
  )
 ) STORED,
 buyer_addition numeric(19,4) GENERATED ALWAYS AS (
  CASE
   WHEN source_operation<>'intercompany_transfer' THEN NULL
   WHEN computed->>'recognition'='nontaxable' THEN
    tax_basis_frozen_money(computed->>'carryoverBasis')+tax_basis_frozen_money(computed->>'excessBasis')
   WHEN regime='ca_cca' THEN tax_basis_frozen_money(computed->>'buyerAddition')
   WHEN regime='uk_wda' THEN tax_basis_frozen_money(computed->>'buyerQualifyingExpenditure')
   WHEN regime='au_pool' THEN tax_basis_frozen_money(computed->>'buyerCost')
   WHEN regime='nz_pool' THEN tax_basis_frozen_money(computed->>'buyerDepreciationCost')
   WHEN regime='us_macrs' THEN tax_basis_frozen_money(computed->>'buyerCost')
  END
 ) STORED,
 remaining_basis numeric(19,4) GENERATED ALWAYS AS (
  CASE WHEN regime='us_macrs' THEN tax_basis_frozen_money(computed->>'remainingUnadjustedBasis') END
 ) STORED,
 reversed_by_change_id uuid REFERENCES financial_changes(id),
 reversed_on date,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES users(id),
 UNIQUE(org_id,id),
 UNIQUE(org_id,change_id,regime),
 CHECK (source_change_id IS NOT NULL OR source_event_id IS NOT NULL),
 CHECK ((reversed_by_change_id IS NULL)=(reversed_on IS NULL)),
 CHECK (source_operation<>'partial_disposal' OR (applicable='seller' AND buyer_addition IS NULL)),
 CHECK (
  (applicable IN ('seller','both') AND seller_disposition IS NOT NULL)
  OR (applicable='buyer' AND seller_disposition IS NULL)
 ),
 CHECK (
  (source_operation='intercompany_transfer' AND applicable IN ('buyer','both') AND buyer_addition IS NOT NULL)
  OR ((source_operation='partial_disposal' OR applicable='seller') AND buyer_addition IS NULL)
 ),
 FOREIGN KEY(org_id,change_id) REFERENCES financial_changes(org_id,id)
);

ALTER TABLE tax_asset_basis_workpapers
  ADD COLUMN IF NOT EXISTS seller_disposition numeric(19,4)
    GENERATED ALWAYS AS (
      tax_basis_frozen_money(
        CASE regime
         WHEN 'ca_cca' THEN computed->>'dispositionAmount'
         WHEN 'uk_wda' THEN computed->>'disposalValue'
         WHEN 'au_pool' THEN computed->>'poolReduction'
         WHEN 'nz_pool' THEN computed->>'poolReduction'
         WHEN 'us_macrs' THEN COALESCE(computed->>'amountRealized', computed->>'disposedUnadjustedBasis')
        END
      )
    ) STORED;
ALTER TABLE tax_asset_basis_workpapers
  ADD COLUMN IF NOT EXISTS buyer_addition numeric(19,4)
    GENERATED ALWAYS AS (
      CASE
       WHEN source_operation<>'intercompany_transfer' THEN NULL
       WHEN computed->>'recognition'='nontaxable' THEN
        tax_basis_frozen_money(computed->>'carryoverBasis')+tax_basis_frozen_money(computed->>'excessBasis')
       WHEN regime='ca_cca' THEN tax_basis_frozen_money(computed->>'buyerAddition')
       WHEN regime='uk_wda' THEN tax_basis_frozen_money(computed->>'buyerQualifyingExpenditure')
       WHEN regime='au_pool' THEN tax_basis_frozen_money(computed->>'buyerCost')
       WHEN regime='nz_pool' THEN tax_basis_frozen_money(computed->>'buyerDepreciationCost')
       WHEN regime='us_macrs' THEN tax_basis_frozen_money(computed->>'buyerCost')
      END
    ) STORED;
ALTER TABLE tax_asset_basis_workpapers
  ADD COLUMN IF NOT EXISTS remaining_basis numeric(19,4)
    GENERATED ALWAYS AS (
      CASE WHEN regime='us_macrs' THEN tax_basis_frozen_money(computed->>'remainingUnadjustedBasis') END
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS tax_asset_basis_live_source_change
  ON tax_asset_basis_workpapers(org_id,source_change_id,regime)
  WHERE source_change_id IS NOT NULL AND reversed_by_change_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tax_asset_basis_live_source_event
  ON tax_asset_basis_workpapers(org_id,source_event_id,regime)
  WHERE source_event_id IS NOT NULL AND source_change_id IS NULL AND reversed_by_change_id IS NULL;
CREATE INDEX IF NOT EXISTS tax_asset_basis_workpapers_asset
  ON tax_asset_basis_workpapers(org_id,asset_id,effective_on);
CREATE INDEX IF NOT EXISTS tax_asset_basis_workpapers_receiver
  ON tax_asset_basis_workpapers(org_id,receiving_asset_id,effective_on);
ALTER TABLE tax_asset_basis_workpapers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_asset_basis_workpapers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_asset_basis_workpapers;
CREATE POLICY org_isolation ON tax_asset_basis_workpapers
  USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON tax_asset_basis_workpapers IS 'openbooks:org_isolation:v1';

CREATE OR REPLACE FUNCTION tax_asset_basis_workpaper_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'tax basis workpapers are immutable; approve a tax_basis_reversal';
 END IF;
 IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.reversed_by_change_id IS NOT NULL OR NEW.reversed_on IS NOT NULL THEN
   RAISE EXCEPTION 'a new tax basis workpaper cannot open already reversed';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM financial_changes f
     WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id AND f.domain='asset'
       AND f.operation='tax_basis' AND f.status='approved'
       AND f.effective_on=NEW.effective_on
       AND (f.subject_id=NEW.asset_id OR f.subject_id=NEW.receiving_asset_id)
       AND f.payload->>'assessment' IS NOT DISTINCT FROM NEW.assessment
       AND f.payload->>'sourceOperation' IS NOT DISTINCT FROM NEW.source_operation
       AND f.payload->>'effectiveOn' IS NOT DISTINCT FROM NEW.effective_on::text
       AND f.payload->>'sourceChangeId' IS NOT DISTINCT FROM NEW.source_change_id::text
       AND f.payload->>'sourceEventId' IS NOT DISTINCT FROM NEW.source_event_id::text
       AND f.payload->>'receivingAssetId' IS NOT DISTINCT FROM NEW.receiving_asset_id::text
       AND f.payload->>'sellerAssetId' IS NOT DISTINCT FROM NEW.asset_id::text
       AND (SELECT count(*) FROM jsonb_array_elements(COALESCE(f.payload->'regimes','[]'::jsonb)) elem
             WHERE elem->>'regime'=NEW.regime)=1
       AND (SELECT elem FROM jsonb_array_elements(f.payload->'regimes') elem
             WHERE elem->>'regime'=NEW.regime) IS NOT DISTINCT FROM NEW.facts
       AND f.payload->'computed'->NEW.regime IS NOT DISTINCT FROM NEW.computed
       AND f.before_state->'preview'->'regimes'->NEW.regime IS NOT DISTINCT FROM NEW.computed
       AND f.payload->'applicable'->>NEW.regime IS NOT DISTINCT FROM NEW.applicable
  ) THEN
   RAISE EXCEPTION 'tax basis facts and computed outcomes must match the independently approved workpaper';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(NEW.facts) kv
     WHERE kv.key IN (
       'originalCapitalCost','allocatedCapitalCost','partFairMarketValue','retainedFairMarketValue',
       'statutoryProceeds','fairMarketValue','payment','sellerOriginalCapitalCost',
       'capitalGainsDeductionClaimed','electedAmount','qualifyingExpenditure',
       'allocatedQualifyingExpenditure','greatestQualifyingExpenditureInChain',
       'buyerQualifyingExpenditure','terminationValue','allocatedCost','buyerCost',
       'consideration','disposalExpenditure','buyerPrice','associatedPersonOriginalCost',
       'firstBusinessUseFairMarketValue','associatedPersonEquivalentRate','associatedPersonAtv',
       'originalUnadjustedBasis','remainingUnadjustedBasis','disposedUnadjustedBasis',
       'recoveryPeriodYears','adjustedAmountRealized','carryoverBasis','excessBasis',
       'allocationFraction','taxableUsePercent','capitalGainsInclusionRate'
     )
       AND kv.value ~ '^-'
  ) THEN
   RAISE EXCEPTION 'declared tax basis facts must be nonnegative; a signed net is computed from declared facts, not entered';
  END IF;
  IF NEW.source_change_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM financial_changes s
     WHERE s.org_id=NEW.org_id AND s.id=NEW.source_change_id AND s.domain='asset'
       AND s.operation=NEW.source_operation AND s.status='applied'
       AND s.effective_on=NEW.effective_on
       AND s.subject_id=NEW.asset_id
       AND NOT EXISTS(
         SELECT 1 FROM financial_changes r
          WHERE r.org_id=s.org_id AND r.domain='asset' AND r.operation='reversal'
            AND r.status='applied' AND r.payload->>'sourceChangeId'=s.id::text
       )
  ) THEN
   RAISE EXCEPTION 'tax basis source must be the unreversed applied disposal or transfer';
  END IF;
  IF NEW.source_event_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM asset_events e
     WHERE e.org_id=NEW.org_id AND e.id=NEW.source_event_id AND e.asset_id=NEW.asset_id
       AND e.occurred_on=NEW.effective_on
       AND e.kind IN ('partially_disposed','transferred','disposed','written_off')
       AND (NEW.source_change_id IS NULL OR e.financial_change_id=NEW.source_change_id)
       AND NOT EXISTS(SELECT 1 FROM asset_events r WHERE r.org_id=e.org_id AND r.reverses_event_id=e.id)
  ) THEN
   RAISE EXCEPTION 'tax basis source event must be an unreversed posted disposal or transfer for this asset';
  END IF;
  IF NEW.source_operation='intercompany_transfer' AND (
    NEW.receiving_asset_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM asset_transfer_bases t
       WHERE t.org_id=NEW.org_id AND t.receiving_asset_id=NEW.receiving_asset_id
         AND t.source_asset_id=NEW.asset_id AND t.reversed_by_change_id IS NULL
         AND (NEW.source_change_id IS NULL OR t.change_id=NEW.source_change_id)
    )
  ) THEN
   RAISE EXCEPTION 'an intercompany tax basis must name the unreversed receiving asset of the source transfer';
  END IF;
  IF NEW.source_operation='partial_disposal' AND NEW.receiving_asset_id IS NOT NULL THEN
   RAISE EXCEPTION 'a customer partial disposal has no receiving tax asset';
  END IF;
  IF NEW.facts IS NULL OR NEW.facts='null'::jsonb OR NEW.computed IS NULL OR NEW.computed='null'::jsonb THEN
   RAISE EXCEPTION 'tax basis facts and computed outcomes must be frozen on the workpaper';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.reversed_by_change_id IS NOT NULL OR NEW.reversed_by_change_id IS NULL OR NEW.reversed_on IS NULL
     OR NEW.reversed_on<>OLD.effective_on
     OR (to_jsonb(NEW)-ARRAY['reversed_by_change_id','reversed_on','seller_disposition','buyer_addition','remaining_basis'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reversed_by_change_id','reversed_on','seller_disposition','buyer_addition','remaining_basis'])
     OR NOT EXISTS(
       SELECT 1 FROM financial_changes f
        WHERE f.org_id=OLD.org_id AND f.id=NEW.reversed_by_change_id
          AND f.domain='asset' AND f.operation='tax_basis_reversal' AND f.status='approved'
          AND f.effective_on=OLD.effective_on
          AND f.payload->>'sourceChangeId'=OLD.change_id::text
     )
  THEN
   RAISE EXCEPTION 'only an independently approved tax_basis_reversal on the original workpaper date may close a tax basis workpaper';
  END IF;
  RETURN NEW;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_asset_basis_workpaper_guard ON tax_asset_basis_workpapers;
CREATE TRIGGER tax_asset_basis_workpaper_guard
  BEFORE INSERT OR UPDATE OR DELETE ON tax_asset_basis_workpapers
  FOR EACH ROW EXECUTE FUNCTION tax_asset_basis_workpaper_guard();

ALTER TABLE tax_asset_basis_workpapers ADD COLUMN IF NOT EXISTS applicable text;
UPDATE tax_asset_basis_workpapers SET applicable='both' WHERE applicable IS NULL;
ALTER TABLE tax_asset_basis_workpapers ALTER COLUMN applicable SET NOT NULL;
ALTER TABLE tax_asset_basis_workpapers DROP CONSTRAINT IF EXISTS tax_asset_basis_workpapers_applicable_check;
ALTER TABLE tax_asset_basis_workpapers
  ADD CONSTRAINT tax_asset_basis_workpapers_applicable_check
  CHECK (applicable IN ('seller','buyer','both'));
ALTER TABLE tax_asset_basis_workpapers ALTER COLUMN seller_disposition DROP NOT NULL;

ALTER TABLE tax_pool_periods ADD COLUMN IF NOT EXISTS year_start date;
ALTER TABLE tax_pool_periods ADD COLUMN IF NOT EXISTS year_end date;
UPDATE tax_pool_periods SET year_start=make_date(tax_year,1,1), year_end=make_date(tax_year,12,31)
 WHERE year_start IS NULL OR year_end IS NULL;
ALTER TABLE tax_pool_periods ALTER COLUMN year_start SET NOT NULL;
ALTER TABLE tax_pool_periods ALTER COLUMN year_end SET NOT NULL;

CREATE TABLE IF NOT EXISTS tax_qualifying_activity_cessations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES orgs(id),
 subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),
 regime text NOT NULL,
 ceased_on date NOT NULL,
 resumed_on date,
 evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 8 AND 4000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES users(id),
 UNIQUE(org_id,id),
 CHECK (resumed_on IS NULL OR resumed_on>ceased_on),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES subsidiaries(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_qualifying_activity_cessations_open
  ON tax_qualifying_activity_cessations(org_id,subsidiary_id,regime)
  WHERE resumed_on IS NULL;
ALTER TABLE tax_qualifying_activity_cessations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_qualifying_activity_cessations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_qualifying_activity_cessations;
CREATE POLICY org_isolation ON tax_qualifying_activity_cessations
  USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON tax_qualifying_activity_cessations IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE tax_qualifying_activity_cessations IS
  'CAA 55(4) qualifying-activity cessation. A UK balancing allowance is available only after ceased_on while resumed_on is null or after the run year. Disposing of the last asset is not cessation.';

SELECT public.openbooks_refresh_query_catalog();
