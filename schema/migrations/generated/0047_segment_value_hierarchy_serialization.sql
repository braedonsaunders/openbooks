-- OpenBooks forward migration 0047_segment_value_hierarchy_serialization.
--
-- segment_value_guard previously checked only the transaction's visible tree.
-- Two sessions could therefore reparent different values in one custom segment
-- from the same committed snapshot and both pass before either edge committed.
-- Serialize the check-to-commit window per organization and custom segment.
-- Waiters then take a fresh READ COMMITTED snapshot after the preceding tree
-- mutation commits and reject an edge that would close a cycle.
--
-- Direct scope changes take the old and new tree fences in stable text order.
-- This preserves concurrency between unrelated segment trees without allowing
-- a moved value (or its children) to escape validation in either scope.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Freeze hierarchy writes while rollout verifies that no cycle or cross-scope
-- parent left by the old snapshot-only guard is silently grandfathered in.
LOCK TABLE public.segment_values IN SHARE ROW EXCLUSIVE MODE;

DO $segment_value_hierarchy_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.segment_values value
      JOIN public.segment_values parent ON parent.id = value.parent_id
     WHERE parent.org_id IS DISTINCT FROM value.org_id
        OR parent.segment_id IS DISTINCT FROM value.segment_id
  ) THEN
    RAISE EXCEPTION
      'segment value hierarchy migration found a parent outside its organization or segment'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT value.id AS origin_id,
             value.parent_id AS ancestor_id,
             value.org_id,
             value.segment_id
        FROM public.segment_values value
       WHERE value.parent_id IS NOT NULL
      UNION
      SELECT ancestry.origin_id,
             parent.parent_id,
             ancestry.org_id,
             ancestry.segment_id
        FROM ancestry
        JOIN public.segment_values parent ON parent.id = ancestry.ancestor_id
       WHERE parent.org_id = ancestry.org_id
         AND parent.segment_id = ancestry.segment_id
         AND parent.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestry WHERE origin_id = ancestor_id
  ) THEN
    RAISE EXCEPTION 'segment value hierarchy migration found an existing cycle'
      USING ERRCODE = '23514';
  END IF;
END
$segment_value_hierarchy_preflight$;

CREATE OR REPLACE FUNCTION public.segment_value_guard() RETURNS trigger
    LANGUAGE plpgsql VOLATILE
    AS $$
DECLARE
  v_hierarchical boolean;
  old_scope text;
  new_scope text;
  first_scope text;
  second_scope text;
  tree_scope text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD.org_id, OLD.segment_id) IS DISTINCT FROM (NEW.org_id, NEW.segment_id) THEN
    old_scope := OLD.org_id::text || ':' || OLD.segment_id::text;
    new_scope := NEW.org_id::text || ':' || NEW.segment_id::text;
    first_scope := LEAST(old_scope, new_scope);
    second_scope := GREATEST(old_scope, new_scope);
    PERFORM pg_advisory_xact_lock(
      hashtextextended('segment-value-tree:' || first_scope, 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('segment-value-tree:' || second_scope, 0)
    );
  ELSE
    tree_scope := NEW.org_id::text || ':' || NEW.segment_id::text;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('segment-value-tree:' || tree_scope, 0)
    );
  END IF;

  SELECT is_hierarchical INTO v_hierarchical
    FROM public.segment_definitions
   WHERE id = NEW.segment_id
     AND org_id = NEW.org_id
     AND source_kind = 'custom'
   FOR KEY SHARE;
  IF v_hierarchical IS NULL THEN
    RAISE EXCEPTION 'segment value must belong to a custom segment in this organization'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.org_id, OLD.segment_id) IS DISTINCT FROM (NEW.org_id, NEW.segment_id)
     AND EXISTS (
       SELECT 1 FROM public.segment_values child
        WHERE child.parent_id = OLD.id
          AND child.org_id = OLD.org_id
          AND child.segment_id = OLD.segment_id
     ) THEN
    RAISE EXCEPTION 'a segment value with children cannot change organization or segment'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.subsidiary_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.subsidiaries subsidiary
     WHERE subsidiary.id = NEW.subsidiary_id AND subsidiary.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'segment value subsidiary belongs to another organization'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF NOT v_hierarchical THEN
      RAISE EXCEPTION 'this segment is not hierarchical' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.segment_values parent
       WHERE parent.id = NEW.parent_id
         AND parent.org_id = NEW.org_id
         AND parent.segment_id = NEW.segment_id
    ) THEN
      RAISE EXCEPTION 'segment value parent is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.parent_id = NEW.id OR EXISTS (
      WITH RECURSIVE descendants AS (
        SELECT id
          FROM public.segment_values
         WHERE org_id = NEW.org_id
           AND segment_id = NEW.segment_id
           AND parent_id = NEW.id
        UNION
        SELECT value.id
          FROM public.segment_values value
          JOIN descendants descendant ON value.parent_id = descendant.id
         WHERE value.org_id = NEW.org_id
           AND value.segment_id = NEW.segment_id
      )
      SELECT 1 FROM descendants WHERE id = NEW.parent_id
    ) THEN
      RAISE EXCEPTION 'segment value hierarchy contains a cycle' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.segment_value_guard() IS
  'openbooks:segment_value_guard:v2 - serializes each organization/segment tree mutation through a transaction-scoped advisory fence before scope and descendant checks, preventing concurrent cross-reparent cycles for API, import, and direct writers';
