-- OpenBooks forward migration 0235_tax_year_window_citations.
-- Exact approved workpaper calendar reads, including original transferor years
-- and adjacent convention context. No citations are inferred from date overlap.
SET search_path=public,pg_catalog;

CREATE TABLE IF NOT EXISTS tax_basis_window_citations (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES orgs(id),
 workpaper_id uuid NOT NULL,
 tax_year_window_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 regime text NOT NULL,
 year_start date NOT NULL,
 year_end date NOT NULL,
 filing_year integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES users(id),
 CHECK (year_start <= year_end),
 CHECK (filing_year BETWEEN 1900 AND 9999),
 FOREIGN KEY (org_id, workpaper_id) REFERENCES tax_asset_basis_workpapers(org_id,id),
 FOREIGN KEY (org_id, tax_year_window_id) REFERENCES tax_year_windows(org_id,id),
 FOREIGN KEY (org_id, subsidiary_id) REFERENCES subsidiaries(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_basis_window_citations_identity
 ON tax_basis_window_citations(org_id,workpaper_id,tax_year_window_id);
CREATE INDEX IF NOT EXISTS tax_basis_window_citations_window
 ON tax_basis_window_citations(org_id,tax_year_window_id);
ALTER TABLE tax_basis_window_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_basis_window_citations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_basis_window_citations;
CREATE POLICY org_isolation ON tax_basis_window_citations
 USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON tax_basis_window_citations IS 'openbooks:org_isolation:v1';

CREATE OR REPLACE FUNCTION tax_basis_window_citation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE registered tax_year_windows%ROWTYPE;
        paper tax_asset_basis_workpapers%ROWTYPE;
        evidence jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'tax-year citations preserve approved workpaper evidence and cannot be deleted';
 END IF;
 IF TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'tax-year citations preserve approved workpaper evidence and cannot be rewritten';
 END IF;
 -- Same fence as native setup, pool runs and approved asset changes. Domain
 -- callers acquire every lineage entity in sorted order before any row lock.
 PERFORM pg_advisory_xact_lock(hashtextextended('asset-tax-lifecycle:'||NEW.org_id::text||':'||NEW.subsidiary_id::text,0));
 SELECT * INTO registered FROM tax_year_windows
  WHERE org_id=NEW.org_id AND id=NEW.tax_year_window_id FOR SHARE;
 IF NOT FOUND OR registered.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
   OR registered.regime IS DISTINCT FROM NEW.regime
   OR registered.year_start IS DISTINCT FROM NEW.year_start
   OR registered.year_end IS DISTINCT FROM NEW.year_end
   OR registered.filing_year IS DISTINCT FROM NEW.filing_year THEN
  RAISE EXCEPTION 'tax-year citation does not match the registered identity and dates; reload the years and obtain a new approval';
 END IF;
 SELECT * INTO paper FROM tax_asset_basis_workpapers WHERE org_id=NEW.org_id AND id=NEW.workpaper_id;
 IF NOT FOUND OR paper.regime IS DISTINCT FROM NEW.regime OR paper.created_by IS DISTINCT FROM NEW.created_by THEN
  RAISE EXCEPTION 'tax-year citation must belong to the applying workpaper, its regime and actor';
 END IF;
 evidence := jsonb_build_object('id',NEW.tax_year_window_id::text,'subsidiaryId',NEW.subsidiary_id::text,
  'regime',NEW.regime,'yearStart',NEW.year_start::text,'yearEnd',NEW.year_end::text,'filingYear',NEW.filing_year);
 IF jsonb_typeof(paper.computed->'taxYearWindows') IS DISTINCT FROM 'array'
  OR NOT (paper.computed->'taxYearWindows' @> jsonb_build_array(evidence))
  OR NOT EXISTS(SELECT 1 FROM financial_changes f WHERE f.org_id=paper.org_id AND f.id=paper.change_id
    AND f.domain='asset' AND f.operation='tax_basis' AND f.status='approved'
    AND f.payload->'computed'->paper.regime IS NOT DISTINCT FROM paper.computed) THEN
  RAISE EXCEPTION 'tax-year citation must match the independently approved calendar read set while the workpaper is being applied';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_basis_window_citation_guard ON tax_basis_window_citations;
CREATE TRIGGER tax_basis_window_citation_guard BEFORE INSERT OR UPDATE OR DELETE ON tax_basis_window_citations
 FOR EACH ROW EXECUTE FUNCTION tax_basis_window_citation_guard();

-- Deferral permits the parent and its whole read set to be inserted atomically.
-- Missing citations must roll back the workpaper, not look like an applied one.
CREATE OR REPLACE FUNCTION tax_basis_window_citations_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb;
        expected_count integer;
        actual_count integer;
BEGIN
 IF openbooks_sandbox_wipe_allowed(NEW.org_id) AND NOT EXISTS(
   SELECT 1 FROM tax_asset_basis_workpapers WHERE org_id=NEW.org_id AND id=NEW.id
 ) THEN RETURN NEW; END IF;
 expected := NEW.computed->'taxYearWindows';
 IF jsonb_typeof(expected) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'an applied tax workpaper must freeze its explicit calendar read set; re-propose it with the registered years';
 END IF;
 expected_count := jsonb_array_length(expected);
 SELECT count(*) INTO actual_count FROM tax_basis_window_citations
  WHERE org_id=NEW.org_id AND workpaper_id=NEW.id;
 IF expected_count<>actual_count OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(expected) e
   WHERE NOT EXISTS(
    SELECT 1 FROM tax_basis_window_citations c WHERE c.org_id=NEW.org_id AND c.workpaper_id=NEW.id
     AND e.value=jsonb_build_object('id',c.tax_year_window_id::text,'subsidiaryId',c.subsidiary_id::text,
      'regime',c.regime,'yearStart',c.year_start::text,'yearEnd',c.year_end::text,'filingYear',c.filing_year)
   )
 ) THEN
  RAISE EXCEPTION 'the applied tax workpaper is missing its approved tax-year citations; no partial evidence may be committed';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_basis_window_citations_complete ON tax_asset_basis_workpapers;
CREATE CONSTRAINT TRIGGER tax_basis_window_citations_complete AFTER INSERT ON tax_asset_basis_workpapers
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tax_basis_window_citations_complete();

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
  INTO cited;
 IF TG_OP='DELETE' THEN
  IF cited THEN RAISE EXCEPTION 'this tax-year window is cited by a computed result or approved tax workpaper and cannot be deleted; preserve its history'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.id,NEW.org_id,NEW.subsidiary_id,NEW.regime,NEW.year_start)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.subsidiary_id,OLD.regime,OLD.year_start) THEN
  RAISE EXCEPTION 'a tax-year window identity cannot be rewritten; delete an unused window through tax-year setup and declare the correct year';
 END IF;
 IF cited AND (NEW.year_end,NEW.filing_year) IS DISTINCT FROM (OLD.year_end,OLD.filing_year) THEN
  RAISE EXCEPTION 'this tax-year window is cited by a computed result or approved tax workpaper; its dates and filing label are frozen';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_year_window_history_guard ON tax_year_windows;
CREATE TRIGGER tax_year_window_history_guard BEFORE INSERT OR UPDATE OR DELETE ON tax_year_windows
 FOR EACH ROW EXECUTE FUNCTION tax_year_window_history_guard();

-- A storage caller cannot attach a result to another entity's or regime's year,
-- or retain an id while substituting different dates. Share the mutation fence.
CREATE OR REPLACE FUNCTION tax_pool_period_window_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pool tax_depreciation_pools%ROWTYPE;
        registered tax_year_windows%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'computed tax pool years cannot be deleted; re-run the latest window from Fixed Assets tax pools';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.org_id,NEW.pool_id,NEW.tax_year_window_id)
  IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.pool_id,OLD.tax_year_window_id) THEN
  RAISE EXCEPTION 'a computed tax pool year cannot be reassigned to another pool or window';
 END IF;
 SELECT * INTO pool FROM tax_depreciation_pools WHERE org_id=NEW.org_id AND id=NEW.pool_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'tax pool result must belong to a pool in the same organization'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('asset-tax-lifecycle:'||NEW.org_id::text||':'||pool.subsidiary_id::text,0));
 SELECT * INTO registered FROM tax_year_windows WHERE org_id=NEW.org_id AND id=NEW.tax_year_window_id FOR SHARE;
 IF NOT FOUND OR registered.subsidiary_id IS DISTINCT FROM pool.subsidiary_id
  OR registered.regime IS DISTINCT FROM pool.regime
  OR registered.year_start IS DISTINCT FROM NEW.year_start OR registered.year_end IS DISTINCT FROM NEW.year_end
  OR registered.filing_year IS DISTINCT FROM NEW.tax_year THEN
  RAISE EXCEPTION 'tax pool result dates, legal entity, regime and filing label must match its registered window';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tax_pool_period_window_guard ON tax_pool_periods;
CREATE TRIGGER tax_pool_period_window_guard BEFORE INSERT OR UPDATE OR DELETE ON tax_pool_periods
 FOR EACH ROW EXECUTE FUNCTION tax_pool_period_window_guard();

SELECT public.openbooks_refresh_query_catalog();
