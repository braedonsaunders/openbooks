-- OpenBooks forward migration 0189_pay_components_country_identity.
--
-- WHY THE INDEX GAINS `country`. A pay component's identity is
-- (org, country, system_key, kind): Canada's TAX deduction and Japan's GENSEN
-- deduction are legitimately different countries' components that happen to
-- share the `income_tax` system key (Italy collides on the same key; Canada
-- and Australia collide on `wcb`). The old three-column unique index
-- (org_id, system_key, kind) could not tell them apart, so installing a
-- second country pack died with a unique violation on
-- pay_components_org_system — and the seeder's `on conflict (org_id, code)`
-- was idempotent on CODE while the constraint that fired was the SYSTEM KEY
-- one, so the conflict was never absorbed (see ensureComponents).
--
-- WHY NULLS NOT DISTINCT. `pay_components.country` is nullable and every
-- org-defined (shared) component carries NULL. A plain four-column unique
-- index treats NULL as distinct from NULL, so it would permit unlimited
-- (org, NULL, system_key, kind) duplicates that the old index refused — the
-- fix would silently REMOVE a guarantee and nothing would fail. PG 16 is the
-- deployed version, so the clause is available.
--
-- WHY PARTIAL (`WHERE system_key IS NOT NULL`). User-defined components
-- (union fringes from upsertUnionFringe, custom setup components) carry a
-- NULL system_key, and many such rows legitimately share one (org, kind):
-- the old index left NULL keys unconstrained, exactly like
-- entitlement_plans_org_system does for tenant plans. A whole-row
-- NULLS NOT DISTINCT would unify those NULL keys and the CREATE INDEX below
-- would fail on any tenant holding two custom deductions. The seeder only
-- ever writes pack-declared rows, whose system keys are non-null by type
-- (StatutoryComponent.systemKey: string, and every BASELINE_COMPONENTS entry
-- carries one), so every seeded row lands inside the partial index and the
-- seeder's conflict arbiter covers exactly the rows the seeder can write.
--
-- NO EXISTING ROW CAN VIOLATE THE NEW INDEX. Any two rows equal under the
-- new (org, country, key, kind) with a non-null key were already equal under
-- the old (org, key, kind) — adding a column only splits equivalence
-- classes — and NULL-key rows are excluded from the new index entirely. No
-- backfill, no repair block, no payroll number moves.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX IF EXISTS public.pay_components_org_system;
CREATE UNIQUE INDEX pay_components_org_system ON public.pay_components USING btree (org_id, country, system_key, kind) NULLS NOT DISTINCT WHERE system_key IS NOT NULL;

COMMENT ON INDEX public.pay_components_org_system IS
  'Component identity (0189): one row per (org, country, system_key, kind). NULLS NOT DISTINCT keeps the org-level (NULL country) guarantee the three-column index gave; the partial predicate keeps NULL system_key user rows unconstrained, as before. Two packs may each own e.g. income_tax; the seeder absorbs reinstalls on this identity.';
