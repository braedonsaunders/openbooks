-- OpenBooks forward migration 0170_forecast_snapshot_org_target.
--
-- F-t02-002: the forecasts page snapshots whatever scope the summary shows,
-- including the unfiltered organization scope. The baseline CHECK only
-- admitted exactly one of (owner, team), so an organization snapshot died on
-- the write with 23514 after the route had already computed the right
-- figures. Both target columns stay nullable; the target is now at most one
-- of owner/team, where neither means the whole organization. Existing rows
-- all carry exactly one target and satisfy the relaxed CHECK as-is, so no
-- backfill or validation scan runs here.
--
-- Forward-only: tightening back to exactly-one would orphan organization
-- snapshots that later writers may have filed.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.crm_forecast_snapshots DROP CONSTRAINT IF EXISTS crm_forecast_snapshot_target;
ALTER TABLE public.crm_forecast_snapshots ADD CONSTRAINT crm_forecast_snapshot_target
  CHECK (num_nonnulls(owner_user_id, sales_team_id) <= 1);

COMMENT ON CONSTRAINT crm_forecast_snapshot_target ON public.crm_forecast_snapshots IS
  'Snapshot target is at most one of owner/team (0170): neither means the whole organization';
