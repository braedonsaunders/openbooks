-- OpenBooks forward migration 0081_account_group_member_dimension_uniqueness.
--
-- account_group_members previously enforced only (group_id, account_id).
-- Because sibling groups in one dimension could therefore both pin the same
-- account, two concurrent move requests could leave an account classified by
-- whichever row resolveAccountGroups happened to read last.  Persisting the
-- parent dimension on the membership row gives PostgreSQL a real uniqueness
-- key for the invariant; the trigger below keeps that denormalized value and
-- both tenant parents coherent for every writer, including direct SQL.
--
-- Existing conflicting rows are intentionally not guessed at.  The migration
-- aborts before installing the unique index and names the scope that needs an
-- operator decision, preserving financial history rather than silently
-- deleting one of two competing report classifications.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.account_group_members
  ADD COLUMN IF NOT EXISTS dimension text;

-- Backfill the copied scope from the authoritative parent before making it
-- mandatory.  A missing parent is surfaced below instead of being converted
-- into an arbitrary dimension.
UPDATE public.account_group_members member
   SET dimension = group_row.dimension
  FROM public.account_groups group_row
 WHERE group_row.id = member.group_id
   AND member.dimension IS DISTINCT FROM group_row.dimension;

DO $account_group_member_dimension_validation$
DECLARE
  missing_dimension integer;
  incoherent integer;
BEGIN
  SELECT count(*)
    INTO missing_dimension
    FROM public.account_group_members
   WHERE dimension IS NULL;
  IF missing_dimension > 0 THEN
    RAISE EXCEPTION
      'account_group_members dimension backfill found % row(s) without a parent account group; reconcile before migration 0081',
      missing_dimension;
  END IF;

  SELECT count(*)
    INTO incoherent
    FROM public.account_group_members member
    LEFT JOIN public.account_groups group_row ON group_row.id = member.group_id
    LEFT JOIN public.accounts account_row ON account_row.id = member.account_id
   WHERE group_row.id IS NULL
      OR account_row.id IS NULL
      OR group_row.org_id IS DISTINCT FROM member.org_id
      OR account_row.org_id IS DISTINCT FROM member.org_id
      OR group_row.dimension IS DISTINCT FROM member.dimension;
  IF incoherent > 0 THEN
    RAISE EXCEPTION
      'account_group_members tenant or dimension coherence check found % row(s); reconcile before migration 0081',
      incoherent;
  END IF;
END;
$account_group_member_dimension_validation$;

ALTER TABLE public.account_group_members
  ALTER COLUMN dimension SET NOT NULL;

-- The new key subsumes the old per-group key.  Retiring the old index keeps a
-- single source of truth and avoids maintaining two redundant unique indexes.
DROP INDEX IF EXISTS public.account_group_members_group_account;
CREATE UNIQUE INDEX IF NOT EXISTS account_group_members_org_dimension_account
  ON public.account_group_members USING btree (org_id, dimension, account_id);

CREATE OR REPLACE FUNCTION public.account_group_member_scope_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  group_org uuid;
  group_dimension text;
  account_org uuid;
  old_lock_key text;
  new_lock_key text;
  first_lock_key text;
  second_lock_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        'account-group-pin:' || OLD.org_id::text || ':' || OLD.dimension || ':' || OLD.account_id::text,
        0
      )
    );
    RETURN OLD;
  END IF;

  SELECT group_row.org_id, group_row.dimension
    INTO group_org, group_dimension
    FROM public.account_groups group_row
   WHERE group_row.id = NEW.group_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account group % does not exist', NEW.group_id
      USING ERRCODE = '23503';
  END IF;
  IF group_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'account group % belongs to another organization', NEW.group_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.dimension IS DISTINCT FROM group_dimension THEN
    RAISE EXCEPTION 'account group member dimension must match its group'
      USING ERRCODE = '23514';
  END IF;

  SELECT account_row.org_id
    INTO account_org
    FROM public.accounts account_row
   WHERE account_row.id = NEW.account_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account % does not exist', NEW.account_id
      USING ERRCODE = '23503';
  END IF;
  IF account_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'account % belongs to another organization', NEW.account_id
      USING ERRCODE = '23514';
  END IF;

  new_lock_key := 'account-group-pin:' || NEW.org_id::text || ':' || NEW.dimension || ':' || NEW.account_id::text;
  IF TG_OP = 'UPDATE' THEN
    old_lock_key := 'account-group-pin:' || OLD.org_id::text || ':' || OLD.dimension || ':' || OLD.account_id::text;
    first_lock_key := LEAST(old_lock_key, new_lock_key);
    second_lock_key := GREATEST(old_lock_key, new_lock_key);
    PERFORM pg_advisory_xact_lock(hashtextextended(first_lock_key, 0));
    IF second_lock_key IS DISTINCT FROM first_lock_key THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(second_lock_key, 0));
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(new_lock_key, 0));
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.account_group_member_scope_guard() IS
  'openbooks:account_group_member_scope_guard:v1 - validates tenant and dimension coherence and serializes every account-group pin mutation on one transaction advisory fence';

DROP TRIGGER IF EXISTS account_group_member_scope_guard ON public.account_group_members;
CREATE TRIGGER account_group_member_scope_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.account_group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.account_group_member_scope_guard();

COMMENT ON TRIGGER account_group_member_scope_guard ON public.account_group_members IS
  'openbooks:account_group_member_scope_guard:v1 - keeps direct and API pin writers coherent and serialized';

-- A parent dimension/org change would invalidate the copied membership scope;
-- the account-group API does not expose either field, so reject only direct
-- mutations while preserving ordinary display/rule edits.
CREATE OR REPLACE FUNCTION public.account_group_member_parent_scope_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
BEGIN
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.dimension IS DISTINCT FROM OLD.dimension)
     AND EXISTS (
       SELECT 1
         FROM public.account_group_members member
        WHERE member.group_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'account group organization or dimension cannot change while pins exist'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.account_group_member_parent_scope_guard() IS
  'openbooks:account_group_member_parent_scope_guard:v1 - prevents parent scope edits from invalidating denormalized account-group member dimensions';

DROP TRIGGER IF EXISTS account_group_member_parent_scope_guard ON public.account_groups;
CREATE TRIGGER account_group_member_parent_scope_guard
  BEFORE UPDATE OF org_id, dimension ON public.account_groups
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.dimension IS DISTINCT FROM NEW.dimension)
  EXECUTE FUNCTION public.account_group_member_parent_scope_guard();

COMMENT ON TRIGGER account_group_member_parent_scope_guard ON public.account_groups IS
  'openbooks:account_group_member_parent_scope_guard:v1 - prevents account-group scope changes from stranding pins';

-- account_group_members is exposed through the governed SELECT-only catalog;
-- refresh its explicit view projection after adding dimension.
SELECT public.openbooks_refresh_query_catalog();
