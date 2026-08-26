-- OpenBooks forward migration 0024_tax_rate_effective_range_exclusion.
--
-- Tax-rate setup validated effective windows through a BEFORE INSERT/UPDATE
-- trigger (tax_rates_no_overlap_guard) whose SELECT sees only committed rows.
-- Under READ COMMITTED two transactions writing overlapping windows in
-- separate sessions were mutually invisible: both passed the guard and both
-- committed parallel statutory configuration, and loadTaxComponentConfig then
-- resolved which one a document date sees with a nondeterministic ORDER BY.
-- The setup route keeps that preflight trigger for its readable conflict
-- message; this exclusion constraint is the authoritative storage-side guard
-- — the second conflicting writer waits on the first transaction's outcome
-- and fails with SQLSTATE 23P01 the moment it commits, for API, import, pack,
-- and direct writes alike.
--
-- A plain unique index cannot enforce date-range overlap, and GiST needs an
-- operator class for the uuid identity columns before it can index them at
-- all. The range constructor mirrors effective_date_ranges_overlap byte for
-- byte: inclusive bounds on both sides, NULL effective_to open-ended as
-- 'infinity'::date.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- UUID equality operator classes are supplied by btree_gist. This extension
-- is mandatory: silently omitting it would silently omit a statutory-
-- configuration invariant.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE public.tax_rates
  ADD CONSTRAINT tax_rates_effective_range_exclusion
  EXCLUDE USING gist (
    org_id WITH =,
    tax_code_id WITH =,
    (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
  );

COMMENT ON CONSTRAINT tax_rates_effective_range_exclusion
  ON public.tax_rates IS
  'openbooks:tax_rate_effective_range_exclusion:v1 - one effective window per organization and tax code; inclusive date windows may not overlap and a null end is open-ended';
