-- Immutable citations from an applied tax workpaper to the tax year windows
-- it actually read. Frozen date facts travel with the window id so a later
-- same-month successor cannot reinterpret already-applied convention context.
SET search_path=public,pg_catalog;

CREATE TABLE IF NOT EXISTS tax_year_window_citations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  workpaper_id uuid NOT NULL REFERENCES tax_asset_basis_workpapers(id),
  tax_year_window_id uuid NOT NULL REFERENCES tax_year_windows(id),
  subsidiary_id uuid NOT NULL,
  regime text NOT NULL,
  year_start date NOT NULL,
  year_end date NOT NULL,
  filing_year integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, workpaper_id, tax_year_window_id),
  CHECK (year_start <= year_end),
  CHECK (filing_year BETWEEN 1900 AND 9999),
  FOREIGN KEY (org_id, tax_year_window_id) REFERENCES tax_year_windows(org_id, id)
);

ALTER TABLE tax_year_window_citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_year_window_citations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_year_window_citations;
CREATE POLICY org_isolation ON tax_year_window_citations
  USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON tax_year_window_citations IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE tax_year_window_citations IS
  'Applied workpaper citations of registered tax year windows. Facts are frozen at apply; a later calendar successor is not this set.';

SELECT public.openbooks_refresh_query_catalog();
