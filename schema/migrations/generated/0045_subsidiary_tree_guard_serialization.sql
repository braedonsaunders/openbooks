-- OpenBooks forward migration 0045_subsidiary_tree_guard_serialization.
--
-- The prerelease subsidiary_tree_guard rejected cycles from its transaction's
-- visible tree, but two transactions could reparent different rows from the
-- same committed snapshot and each pass before either edge committed. Serialize
-- the entire check-to-commit window per organization. Once a waiter acquires
-- the fence, this VOLATILE trigger's parent and descendant queries take a fresh
-- READ COMMITTED snapshot that includes the preceding tree mutation.
--
-- Organization changes (although not a normal product operation) take both
-- tree fences in UUID-text order so direct writes cannot deadlock or leave
-- either organization's hierarchy checked against an unlocked tree.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.subsidiary_tree_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  first_org uuid;
  second_org uuid;
  tree_org uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    first_org := LEAST(OLD.org_id::text, NEW.org_id::text)::uuid;
    second_org := GREATEST(OLD.org_id::text, NEW.org_id::text)::uuid;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('subsidiary-tree:' || first_org::text, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('subsidiary-tree:' || second_org::text, 0)
    );
  ELSE
    tree_org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('subsidiary-tree:' || tree_org::text, 0)
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.parent_id IS NULL
       AND EXISTS (SELECT 1 FROM public.orgs WHERE id = OLD.org_id)
       AND NOT public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RAISE EXCEPTION 'the root subsidiary cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.parent_id IS NULL AND NEW.parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'the root subsidiary cannot be moved' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_id IS NULL AND NOT NEW.is_active THEN
    RAISE EXCEPTION 'the root subsidiary cannot be inactive' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.subsidiaries parent
       WHERE parent.id = NEW.parent_id
         AND parent.org_id = NEW.org_id
    ) THEN
      RAISE EXCEPTION 'subsidiary parent belongs to another organization' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_id = NEW.id OR EXISTS (
      WITH RECURSIVE descendants AS (
        SELECT id
          FROM public.subsidiaries
         WHERE org_id = NEW.org_id AND parent_id = NEW.id
        UNION ALL
        SELECT subsidiary.id
          FROM public.subsidiaries subsidiary
          JOIN descendants descendant ON subsidiary.parent_id = descendant.id
         WHERE subsidiary.org_id = NEW.org_id
      )
      SELECT 1 FROM descendants WHERE id = NEW.parent_id
    ) THEN
      RAISE EXCEPTION 'subsidiary hierarchy contains a cycle' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.subsidiary_tree_guard() IS
  'openbooks:subsidiary_tree_guard:v2 - serializes each organization tree mutation through a transaction-scoped advisory fence before parent and descendant checks, preventing concurrent cross-reparent cycles while preserving root invariants';
