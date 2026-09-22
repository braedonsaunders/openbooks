-- OpenBooks forward migration 0248_pay_component_code_country_identity.
--
-- 0189 made a pay component's identity (org, country, system_key, kind) so two
-- country packs may each own the same SYSTEM key — Canada's TAX and Japan's
-- GENSEN both mean income_tax. It left the older (org, code) unique index
-- `pay_components_org_code` in place, and the seeder's conflict arbiter does
-- not cover it. Canada and Australia each declare a component whose CODE is
-- literally `WCB` (different system keys are not the issue; the code is), so
-- installing the AU pack into an organization that already has CA dies on the
-- surviving index:
--
--   duplicate key value violates unique constraint "pay_components_org_code"
--
-- Reproduced at 0247: seedPayrollComponents(org, "CA") then (org, "AU") raises
-- that error and no AU row is written. A component's user-facing code is
-- scoped to its country exactly as its system key already is, so the code
-- identity becomes (org, country, code).
--
-- NULLS NOT DISTINCT keeps the pre-existing guarantee for org-defined rows:
-- `country` is NULL for shared/user-authored components, and a plain index
-- treats NULL as distinct from NULL, which would permit unlimited duplicate
-- codes among them and silently REMOVE a guarantee (the same trap 0189's
-- header describes for system keys). PG 16 is deployed, so the clause exists.
--
-- NO EXISTING ROW CAN VIOLATE THE NEW INDEX. The old index made (org, code)
-- unique, so no two rows in any database share a code at all; adding `country`
-- only splits equivalence classes. No backfill, no repair block, no payroll
-- number moves. The code-only slot-account lookups in engine/src/payroll/
-- packs.ts are made country-scoped in the same change, or a slot write could
-- repoint the other country's row.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX IF EXISTS public.pay_components_org_code;
CREATE UNIQUE INDEX pay_components_org_country_code
  ON public.pay_components USING btree (org_id, country, code) NULLS NOT DISTINCT;

COMMENT ON INDEX public.pay_components_org_country_code IS
  'Component code identity (0248): one row per (org, country, code). NULLS NOT DISTINCT keeps the org-level (NULL country) guarantee the old (org, code) index gave, so shared/user codes stay unique; two packs may each own e.g. WCB because their countries differ.';