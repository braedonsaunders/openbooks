-- OpenBooks forward migration 0067_insights_home_uniqueness.
--
-- insight_dashboards.is_home and home_for_role are pointers, not descriptive
-- labels: an org can have at most one system default and one default for each
-- role. The baseline only indexed these columns, so duplicate pointers were
-- accepted and resolveHomeDashboard had no stable answer.
--
-- Existing installations may already contain duplicate pointers. Preserve the
-- most recently updated pointer (with the id as a deterministic tie-breaker)
-- and clear the stale pointers before installing the storage invariant. The
-- dashboards themselves remain intact, including drafts and unpublished
-- history; only the ambiguous pointer flags are repaired.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX IF EXISTS public.insight_dashboards_org_home;
DROP INDEX IF EXISTS public.insight_dashboards_org_role_home;

-- Keep one system default per org. UUIDv7 ids are creation-ordered in normal
-- operation, but ordering by updated_at first preserves the pointer edited most
-- recently and the id makes equal timestamps reproducible.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS pointer_rank
    FROM public.insight_dashboards
   WHERE is_home
)
UPDATE public.insight_dashboards AS dashboard
   SET is_home = false,
       updated_at = now()
  FROM ranked
 WHERE dashboard.id = ranked.id
   AND ranked.pointer_rank > 1;

-- Keep one role default per (org, role). Null is the explicit absence of a
-- role pointer and is therefore excluded from both repair and uniqueness.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id, home_for_role
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS pointer_rank
    FROM public.insight_dashboards
   WHERE home_for_role IS NOT NULL
)
UPDATE public.insight_dashboards AS dashboard
   SET home_for_role = NULL,
       updated_at = now()
  FROM ranked
 WHERE dashboard.id = ranked.id
   AND ranked.pointer_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_home
    ON public.insight_dashboards USING btree (org_id)
   WHERE is_home;

CREATE UNIQUE INDEX IF NOT EXISTS insight_dashboards_org_role_home
    ON public.insight_dashboards USING btree (org_id, home_for_role)
   WHERE home_for_role IS NOT NULL;

COMMENT ON INDEX public.insight_dashboards_org_home IS
  'openbooks:one system default home dashboard per org; only is_home=true rows participate';

COMMENT ON INDEX public.insight_dashboards_org_role_home IS
  'openbooks:one role default home dashboard per org and non-null role key';
