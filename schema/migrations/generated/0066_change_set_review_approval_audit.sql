-- OpenBooks forward migration 0066_change_set_review_approval_audit.
--
-- A sandbox promotion is a security-sensitive configuration write.  The old
-- change_sets row had only draft/applied/discarded states, so the creator could
-- apply a draft immediately and the production write carried no actor evidence.
-- The old builder also committed its header before its items, leaving an
-- applyable prefix when a later table read or item insert failed.
--
-- Capture completeness, explicit review and approval states, and lifecycle
-- actors make the state machine durable.  Existing applied/discarded rows are
-- retained as historical data; new engine writes must carry the full evidence
-- chain before they can be applied.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.change_sets
  ADD COLUMN IF NOT EXISTS capture_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS applied_by uuid;

-- Rows created by the pre-0066 implementation that reached a terminal state
-- necessarily completed their capture.  Draft rows stay incomplete and must
-- be rebuilt or explicitly reviewed by the new workflow; no actor is invented.
UPDATE public.change_sets cs
   SET capture_complete = true,
       item_count = (
         SELECT count(*)::integer
           FROM public.change_set_items item
          WHERE item.change_set_id = cs.id
            AND item.org_id = cs.org_id
       )
 WHERE cs.status IN ('applied', 'discarded')
   AND NOT cs.capture_complete;

DO $change_set_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_status_valid'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_status_valid
      CHECK (status IN ('draft', 'reviewed', 'approved', 'applied', 'discarded'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_item_count_nonnegative'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_item_count_nonnegative
      CHECK (item_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_capture_lifecycle'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_capture_lifecycle
      CHECK (status IN ('draft', 'discarded') OR capture_complete);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_review_evidence'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_review_evidence
      CHECK (
        status IN ('draft', 'discarded')
        OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
        -- Legacy applied rows predate review evidence; retain them as history
        -- but never let the engine apply them again.
        OR (status = 'applied' AND reviewed_at IS NULL AND reviewed_by IS NULL AND applied_by IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_approval_evidence'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_approval_evidence
      CHECK (
        status IN ('draft', 'reviewed', 'discarded')
        OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
        OR (status = 'applied' AND approved_at IS NULL AND approved_by IS NULL AND applied_by IS NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_apply_evidence'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_apply_evidence
      CHECK (status <> 'applied' OR applied_at IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'public.change_sets'::regclass
       AND conname = 'change_sets_actor_separation'
  ) THEN
    ALTER TABLE public.change_sets
      ADD CONSTRAINT change_sets_actor_separation
      CHECK (
        (created_by IS NULL OR reviewed_by IS NULL OR created_by <> reviewed_by)
        AND (created_by IS NULL OR approved_by IS NULL OR created_by <> approved_by)
        AND (created_by IS NULL OR applied_by IS NULL OR created_by <> applied_by)
        AND (reviewed_by IS NULL OR approved_by IS NULL OR reviewed_by <> approved_by)
        AND (reviewed_by IS NULL OR applied_by IS NULL OR reviewed_by <> applied_by)
        AND (approved_by IS NULL OR applied_by IS NULL OR approved_by <> applied_by)
      );
  END IF;
END
$change_set_constraints$;

COMMENT ON COLUMN public.change_sets.capture_complete IS
  'openbooks:promotion capture is complete only after every diff item commits atomically';
COMMENT ON COLUMN public.change_sets.item_count IS
  'openbooks:immutable expected change_set_items count; apply verifies the live count';
COMMENT ON COLUMN public.change_sets.reviewed_by IS
  'openbooks:independent actor who reviewed the captured sandbox diff';
COMMENT ON COLUMN public.change_sets.approved_by IS
  'openbooks:independent actor who approved the reviewed sandbox diff';
COMMENT ON COLUMN public.change_sets.applied_by IS
  'openbooks:authenticated actor who applied the approved promotion to production';

-- Once a reviewer has signed the snapshot, its items are evidence, not an
-- editable work queue.  The builder remains free to insert/update/delete while
-- the parent is draft; review then freezes the exact payload that approval saw.
CREATE OR REPLACE FUNCTION public.change_set_items_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $change_set_items_lifecycle_guard$
DECLARE
  parent_id uuid := COALESCE(NEW.change_set_id, OLD.change_set_id);
  parent_org uuid;
  parent_status text;
BEGIN
  SELECT org_id, status
    INTO parent_org, parent_status
    FROM public.change_sets
   WHERE id = parent_id
   FOR UPDATE;
  -- ON DELETE CASCADE removes child rows as part of deleting their parent;
  -- allow that internal delete while rejecting orphaned standalone writes.
  IF parent_status IS NULL AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'change set % does not exist', parent_id;
  END IF;
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'change set items are immutable after review (status=%)', parent_status;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.org_id <> parent_org THEN
    RAISE EXCEPTION 'change set item organization must match its change set';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$change_set_items_lifecycle_guard$;

DO $change_set_items_lifecycle_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.change_set_items'::regclass
       AND tgname = 'change_set_items_lifecycle_guard'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER change_set_items_lifecycle_guard
      BEFORE INSERT OR UPDATE OR DELETE ON public.change_set_items
      FOR EACH ROW EXECUTE FUNCTION public.change_set_items_lifecycle_guard();
  END IF;
END
$change_set_items_lifecycle_trigger$;
