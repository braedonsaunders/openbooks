-- OpenBooks forward migration 0234_tax_year_windows.
-- Declared tax-year windows per legal entity and regime. Book fiscal
-- calendars, provision runs, and pool-period results are not this registry.
-- Dates are the identity; filing_year may repeat so two short years ending
-- in the same calendar year both survive. Pool periods cite a window id.
SET search_path=public,pg_catalog;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS tax_year_windows (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id),
  subsidiary_id uuid NOT NULL REFERENCES subsidiaries(id),
  regime text NOT NULL,
  year_start date NOT NULL,
  year_end date NOT NULL,
  filing_year integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  UNIQUE (org_id, id),
  UNIQUE (org_id, subsidiary_id, regime, year_start),
  CHECK (year_start <= year_end),
  CHECK (filing_year BETWEEN 1900 AND 9999),
  CHECK (length(btrim(reason)) BETWEEN 8 AND 4000),
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES subsidiaries(org_id, id)
);

DO $tax_year_windows_no_overlap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'tax_year_windows_no_overlap'
       AND conrelid = 'public.tax_year_windows'::regclass
  ) THEN
    ALTER TABLE tax_year_windows
      ADD CONSTRAINT tax_year_windows_no_overlap
      EXCLUDE USING gist (
        org_id WITH =,
        subsidiary_id WITH =,
        regime WITH =,
        daterange(year_start, year_end, '[]') WITH &&
      );
  END IF;
END
$tax_year_windows_no_overlap$;

ALTER TABLE tax_year_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_year_windows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON tax_year_windows;
CREATE POLICY org_isolation ON tax_year_windows
  USING (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON tax_year_windows IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE tax_year_windows IS
  'Declared tax-year windows for one legal entity and regime. filing_year is a label and may repeat; year_start is the identity. Book period gaps must not be min/maxed into a tax year.';

INSERT INTO tax_year_windows (
  org_id, subsidiary_id, regime, year_start, year_end, filing_year, reason, created_by, updated_by
)
SELECT DISTINCT ON (tp.org_id, tp.subsidiary_id, tp.regime, pp.year_start, pp.year_end)
  tp.org_id,
  tp.subsidiary_id,
  tp.regime,
  pp.year_start,
  pp.year_end,
  pp.tax_year,
  'migrated from computed pool period',
  pp.created_by,
  pp.updated_by
  FROM tax_pool_periods pp
  JOIN tax_depreciation_pools tp ON tp.id = pp.pool_id AND tp.org_id = pp.org_id
 ORDER BY tp.org_id, tp.subsidiary_id, tp.regime, pp.year_start, pp.year_end, pp.tax_year
ON CONFLICT (org_id, subsidiary_id, regime, year_start) DO NOTHING;

ALTER TABLE tax_pool_periods ADD COLUMN IF NOT EXISTS tax_year_window_id uuid;

UPDATE tax_pool_periods pp
   SET tax_year_window_id = tw.id
  FROM tax_depreciation_pools tp, tax_year_windows tw
 WHERE tp.id = pp.pool_id AND tp.org_id = pp.org_id
   AND tw.org_id = tp.org_id
   AND tw.subsidiary_id = tp.subsidiary_id
   AND tw.regime = tp.regime
   AND tw.year_start = pp.year_start
   AND tw.year_end = pp.year_end
   AND pp.tax_year_window_id IS NULL;

DO $tax_pool_periods_window_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM tax_pool_periods WHERE tax_year_window_id IS NULL) THEN
    RAISE EXCEPTION
      'tax_pool_periods backfill left a row without tax_year_window_id; declare matching tax year windows — do not invent a book fiscal year';
  END IF;
END
$tax_pool_periods_window_backfill$;

ALTER TABLE tax_pool_periods ALTER COLUMN tax_year_window_id SET NOT NULL;
ALTER TABLE tax_pool_periods DROP CONSTRAINT IF EXISTS tax_pool_periods_window_fk;
ALTER TABLE tax_pool_periods
  ADD CONSTRAINT tax_pool_periods_window_fk
  FOREIGN KEY (tax_year_window_id) REFERENCES tax_year_windows(id);
ALTER TABLE tax_pool_periods DROP CONSTRAINT IF EXISTS tax_pool_periods_window_org_fk;
ALTER TABLE tax_pool_periods
  ADD CONSTRAINT tax_pool_periods_window_org_fk
  FOREIGN KEY (org_id, tax_year_window_id) REFERENCES tax_year_windows(org_id, id);

DROP INDEX IF EXISTS tax_pool_periods_identity;
CREATE UNIQUE INDEX tax_pool_periods_identity
  ON tax_pool_periods (org_id, pool_id, tax_year_window_id);

SELECT public.openbooks_refresh_query_catalog();
