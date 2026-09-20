-- OpenBooks forward migration 0219_list_views_one_live_personal_default.
--
-- The canonical baseline unique extras on list_views are only
-- list_views_org_scope_type_name (org, scope, record_type, name) and
-- list_views_org_type (org, record_type, scope). Those do not prevent two
-- live personal defaults for the same owner and record type. Concurrent
-- sessions or a skipped write-path lock can persist two rows with
-- scope='user', is_default, and is_active, after which resolveListView
-- throws AmbiguousListViewDefaultError forever.
--
-- This forward-only repair installs a unique partial index on
-- (org_id, owner_id, record_type) for live personal defaults. Existing
-- rows are never rewritten or discarded. The preflight reports the first
-- dirty duplicate group and aborts before any index change. Clean
-- installations and upgrades then receive the same storage invariant,
-- and replay converges with IF NOT EXISTS.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $list_views_one_live_personal_default_preflight$
DECLARE
  violation record;
BEGIN
  SELECT live.org_id::text AS org_id,
         live.owner_id::text AS owner_id,
         live.record_type AS record_type,
         live.live_defaults,
         live.first_ctid
    INTO violation
    FROM (
      SELECT lv.org_id,
             lv.owner_id,
             lv.record_type,
             count(*)::integer AS live_defaults,
             min(lv.ctid::text) AS first_ctid
        FROM public.list_views lv
       WHERE lv.scope = 'user'
         AND lv.is_default
         AND lv.is_active
       GROUP BY lv.org_id, lv.owner_id, lv.record_type
      HAVING count(*) > 1
       ORDER BY lv.org_id, lv.owner_id, lv.record_type
       LIMIT 1
    ) live;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates unique live personal default: public.list_views',
      DETAIL = jsonb_build_object(
        'table', 'list_views',
        'row', violation.first_ctid,
        'org_id', violation.org_id,
        'owner_id', violation.owner_id,
        'record_type', violation.record_type,
        'live_defaults', violation.live_defaults
      )::text,
      HINT = 'Reconcile so only one live personal isDefault remains for the same organization, owner, and record type, then retry migration 0219; this migration will not rewrite list_views rows.';
  END IF;
END
$list_views_one_live_personal_default_preflight$;

-- IF NOT EXISTS keeps a replay from failing after a clean install already
-- provisioned the index.
CREATE UNIQUE INDEX IF NOT EXISTS list_views_one_live_personal_default
  ON public.list_views USING btree (org_id, owner_id, record_type)
  WHERE ((scope = 'user') AND is_default AND is_active);

COMMENT ON INDEX public.list_views_one_live_personal_default IS
  'openbooks:list_views.one_live_personal_default:v1 - at most one live personal isDefault per organization, owner, and record type';
