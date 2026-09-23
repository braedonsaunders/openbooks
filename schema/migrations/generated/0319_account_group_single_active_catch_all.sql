-- OpenBooks forward migration 0319_account_group_single_active_catch_all.
--
-- Migration 0306 backfills the default account groups by (org, dimension,
-- key), including the cost_pool catch-all `other`. It does not detect a
-- tenant's pre-existing custom catch-all under a DIFFERENT key, so an org
-- that already resolved unmatched accounts to its own catch-all gains a
-- second active catch-all — and because resolveAccountGroups takes the
-- FIRST catch-all by sort_order, every formerly unmatched account silently
-- moves into the new Other bucket at sort_order 90. That breaks 0306's own
-- preserve-operator-policy promise.
--
-- Repair first, then guard. A dimension holding the pristine default `other`
-- (untouched name, color, sort order and empty rule — the exact 0306
-- literals) alongside a custom-key catch-all is unambiguous: the backfill
-- inserted the duplicate. The default is DEACTIVATED, never deleted, so the
-- row and its history survive and a 0306 re-run collides on
-- (org, dimension, key) and changes nothing. The tenant's catch-all stays
-- authoritative and keeps its bucket. Anything else holding two active
-- catch-alls (a customized `other` beside a custom catch-all, two customs,
-- three or more) is operator policy this migration must not guess at: the
-- precheck below aborts naming the (org, dimension) scopes, mirroring 0081,
-- so an operator deactivates all but the authoritative group first.
--
-- The partial unique index then refuses a second active catch-all per
-- (org, dimension) for every writer including direct SQL, and the trigger
-- names the remedy (deactivate the current catch-all first, or edit it
-- instead) rather than surfacing a bare unique violation. The concurrent
-- double-insert race is arbitrated by the index: both writers pass the
-- BEFORE trigger under READ COMMITTED and exactly one commits.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Unambiguous 0306 duplicates: the pristine default `other` beside a
-- tenant-authored catch-all. Deactivate the default; the tenant's group and
-- every account it claims are untouched.
DO $account_group_catch_all_repair$
DECLARE
  duplicate record;
BEGIN
  FOR duplicate IN
    SELECT g.org_id, g.dimension, g.id AS other_id
      FROM public.account_groups g
     WHERE g.is_catch_all
       AND g.is_active
       AND g.key = 'other'
       AND g.name = 'Other'
       AND g.color = '#94a3b8'
       AND g.sort_order = 90
       AND g.match = '{}'::jsonb
       AND EXISTS (
             SELECT 1
               FROM public.account_groups sibling
              WHERE sibling.org_id = g.org_id
                AND sibling.dimension = g.dimension
                AND sibling.is_catch_all
                AND sibling.is_active
                AND sibling.id IS DISTINCT FROM g.id
           )
  LOOP
    UPDATE public.account_groups
       SET is_active = false, updated_at = now()
     WHERE id = duplicate.other_id;
    RAISE NOTICE 'account group backfill left a second % catch-all for org %; deactivating the default "other" group so the tenant''s catch-all stays authoritative (0319)',
      duplicate.dimension, duplicate.org_id;
  END LOOP;
END;
$account_group_catch_all_repair$;

-- Anything still holding two active catch-alls is ambiguous operator
-- policy, not backfill damage. Abort naming every scope so the operator —
-- never this migration — decides which group stays authoritative.
DO $account_group_catch_all_precheck$
DECLARE
  conflict_detail text;
BEGIN
  SELECT string_agg(scope, ', ' ORDER BY scope)
    INTO conflict_detail
    FROM (
      SELECT g.org_id::text || '/' || g.dimension
               || ' (' || string_agg(DISTINCT g.key, ', ' ORDER BY g.key) || ')' AS scope
        FROM public.account_groups g
       WHERE g.is_catch_all
         AND g.is_active
       GROUP BY g.org_id, g.dimension
      HAVING count(*) > 1
    ) conflicts;
  IF conflict_detail IS NOT NULL THEN
    RAISE EXCEPTION 'account_groups holds more than one active catch-all in %; deactivate all but the authoritative group per (org, dimension) before migration 0319 (keys to choose between are in parentheses)',
      conflict_detail
      USING ERRCODE = '23514';
  END IF;
END;
$account_group_catch_all_precheck$;

-- One active catch-all per (org, dimension), for every writer. Inactive
-- rows stay out of the index so deactivated groups — including the 0306
-- duplicates repaired above — keep their history without blocking.
CREATE UNIQUE INDEX IF NOT EXISTS account_groups_one_active_catch_all
  ON public.account_groups USING btree (org_id, dimension)
  WHERE (is_catch_all AND is_active);

-- Name the remedy at the write: a bare unique violation does not tell the
-- operator to deactivate the current catch-all or edit it instead.
--
-- A BEFORE INSERT trigger fires before ON CONFLICT detects the key
-- collision, so without the same-key exemption below this guard would turn
-- every re-runnable insert-missing seed (0306, ensureAccountGroupDefaults,
-- the seed CLI) into a failure on orgs that already carry the key. When
-- the key already exists the write is either a no-op (ON CONFLICT DO
-- NOTHING, which also never reactivates) or a plain duplicate-key error —
-- either way there is nothing for this guard to arbitrate. The exemption
-- is key-scoped only: reactivating a deactivated catch-all beside a live
-- one still trips the sibling check through the UPDATE path.
CREATE OR REPLACE FUNCTION public.account_group_catch_all_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  existing_key text;
BEGIN
  IF NEW.is_catch_all AND NEW.is_active THEN
    IF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1
        FROM public.account_groups existing
       WHERE existing.org_id = NEW.org_id
         AND existing.dimension = NEW.dimension
         AND existing.key = NEW.key
    ) THEN
      RETURN NEW;
    END IF;
    SELECT g.key
      INTO existing_key
      FROM public.account_groups g
     WHERE g.org_id = NEW.org_id
       AND g.dimension = NEW.dimension
       AND g.is_catch_all
       AND g.is_active
       AND g.id IS DISTINCT FROM NEW.id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'only one active catch-all account group is allowed per organization and dimension (org % dimension % already resolves unmatched accounts to "%"); deactivate that group first, or edit it instead of adding a second catch-all',
        NEW.org_id, NEW.dimension, existing_key
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.account_group_catch_all_guard() IS
  'openbooks:account_group_catch_all_guard:v1 - refuses a second active catch-all per (org, dimension) with the remedy, for API and direct-SQL writers alike';

DROP TRIGGER IF EXISTS account_group_catch_all_guard ON public.account_groups;
CREATE TRIGGER account_group_catch_all_guard
  BEFORE INSERT OR UPDATE OF is_catch_all, is_active ON public.account_groups
  FOR EACH ROW
  WHEN (NEW.is_catch_all AND NEW.is_active)
  EXECUTE FUNCTION public.account_group_catch_all_guard();

COMMENT ON TRIGGER account_group_catch_all_guard ON public.account_groups IS
  'openbooks:account_group_catch_all_guard:v1 - keeps one authoritative catch-all per (org, dimension); the partial unique index arbitrates the concurrent double-insert race';
