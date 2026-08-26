-- OpenBooks forward migration 0042_tax_rate_domain_constraints.
--
-- Two storage invariants the authoritative tax configuration never had:
--
-- 1. tax_rates.rate_percent domain. The generic Setup path coerced the rate
--    as a generic decimal and PostgreSQL accepted any sign, so a negative
--    rate saved "successfully" and then failed every later document at
--    calculation time (engine/src/tax.ts refuses negative rates). Storage now
--    enforces the calculation engine's exact-decimal contract: a rate is a
--    nonnegative numeric(19,4) percent. A statutory 0% rate stays legal.
-- 2. Tenant natural-key uniqueness for the authoritative tax and dimension
--    tables. The Setup route checked duplicates with an autocommit SELECT
--    before a later insert transaction, so two concurrent writers could both
--    observe "no row" and commit parallel authoritative definitions sharing
--    one business key. Tables that already carry database uniqueness (for
--    example tax_jurisdictions) are untouched.
--
-- Rollout never rewrites tax policy and never picks a winning duplicate. The
-- preflights identify legacy violations and abort before any DDL with the
-- exact rows; an accountant or operator must record the intended correction
-- and rerun this migration.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $tax_rate_domain_preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT 'tax_rates.rate_percent'::text AS invariant,
             r.id AS row_id,
             r.org_id,
             jsonb_build_object(
               'taxCodeId', r.tax_code_id,
               'ratePercent', r.rate_percent,
               'effectiveFrom', r.effective_from,
               'effectiveTo', r.effective_to
             ) AS configuration
        FROM public.tax_rates r
       WHERE r.rate_percent < 0
    ) violations
   ORDER BY invariant, row_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('legacy data violates tax rate domain invariant: %s', violation.invariant),
      DETAIL = jsonb_build_object(
        'invariant', violation.invariant,
        'row_id', violation.row_id,
        'org_id', violation.org_id,
        'configuration', violation.configuration
      )::text,
      HINT = 'Review the identified rate and record an approved correction, then retry migration 0042. This migration never rewrites tax policy.';
  END IF;
END
$tax_rate_domain_preflight$;

DO $setup_natural_key_preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT 'tax_codes.org_code'::text AS invariant,
             c.org_id,
             c.code AS natural_key,
             (array_agg(c.id order by c.id))::text[] AS row_ids
        FROM public.tax_codes c
       WHERE c.code IS NOT NULL
       GROUP BY c.org_id, c.code
      HAVING count(*) > 1
      UNION ALL
      SELECT 'tax_groups.org_code',
             g.org_id,
             g.code,
             (array_agg(g.id order by g.id))::text[]
        FROM public.tax_groups g
       WHERE g.code IS NOT NULL
       GROUP BY g.org_id, g.code
      HAVING count(*) > 1
      UNION ALL
      SELECT 'classes.org_code',
             k.org_id,
             k.code,
             (array_agg(k.id order by k.id))::text[]
        FROM public.classes k
       WHERE k.code IS NOT NULL
       GROUP BY k.org_id, k.code
      HAVING count(*) > 1
      UNION ALL
      SELECT 'departments.org_code',
             d.org_id,
             d.code,
             (array_agg(d.id order by d.id))::text[]
        FROM public.departments d
       WHERE d.code IS NOT NULL
       GROUP BY d.org_id, d.code
      HAVING count(*) > 1
      UNION ALL
      SELECT 'locations.org_code',
             l.org_id,
             l.code,
             (array_agg(l.id order by l.id))::text[]
        FROM public.locations l
       WHERE l.code IS NOT NULL
       GROUP BY l.org_id, l.code
      HAVING count(*) > 1
      UNION ALL
      SELECT 'worker_comp_groups.org_code',
             w.org_id,
             w.code,
             (array_agg(w.id order by w.id))::text[]
        FROM public.worker_comp_groups w
       WHERE w.code IS NOT NULL
       GROUP BY w.org_id, w.code
      HAVING count(*) > 1
    ) violations
   ORDER BY invariant, org_id, natural_key
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format('legacy setup rows duplicate a natural key: %s', violation.invariant),
      DETAIL = jsonb_build_object(
        'invariant', violation.invariant,
        'org_id', violation.org_id,
        'code', violation.natural_key,
        'row_ids', violation.row_ids
      )::text,
      HINT = 'Review the identified rows, record which one is authoritative, and retry migration 0042. This migration never picks a winning duplicate.';
  END IF;
END
$setup_natural_key_preflight$;

ALTER TABLE public.tax_rates
  ADD CONSTRAINT tax_rates_rate_percent_domain
    CHECK (rate_percent >= 0) NOT VALID;

ALTER TABLE public.tax_rates
  VALIDATE CONSTRAINT tax_rates_rate_percent_domain;

ALTER TABLE public.tax_codes
  ADD CONSTRAINT tax_codes_org_code_unique UNIQUE (org_id, code);

ALTER TABLE public.tax_groups
  ADD CONSTRAINT tax_groups_org_code_unique UNIQUE (org_id, code);

ALTER TABLE public.classes
  ADD CONSTRAINT classes_org_code_unique UNIQUE (org_id, code);

ALTER TABLE public.departments
  ADD CONSTRAINT departments_org_code_unique UNIQUE (org_id, code);

ALTER TABLE public.locations
  ADD CONSTRAINT locations_org_code_unique UNIQUE (org_id, code);

ALTER TABLE public.worker_comp_groups
  ADD CONSTRAINT worker_comp_groups_org_code_unique UNIQUE (org_id, code);

COMMENT ON CONSTRAINT tax_rates_rate_percent_domain
  ON public.tax_rates IS
  'openbooks:tax_rate_domain_constraints:v1 - an effective-dated tax rate is a nonnegative exact numeric(19,4) percent, the same domain the calculation engine enforces';
COMMENT ON CONSTRAINT tax_codes_org_code_unique
  ON public.tax_codes IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative tax code per organization and code';
COMMENT ON CONSTRAINT tax_groups_org_code_unique
  ON public.tax_groups IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative tax group per organization and code';
COMMENT ON CONSTRAINT classes_org_code_unique
  ON public.classes IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative class per organization and code';
COMMENT ON CONSTRAINT departments_org_code_unique
  ON public.departments IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative department per organization and code';
COMMENT ON CONSTRAINT locations_org_code_unique
  ON public.locations IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative location per organization and code';
COMMENT ON CONSTRAINT worker_comp_groups_org_code_unique
  ON public.worker_comp_groups IS
  'openbooks:tax_rate_domain_constraints:v1 - one authoritative workers-comp policy per organization and code';
