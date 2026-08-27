-- OpenBooks forward migration 0034_document_line_immutability.
--
-- Document lines are the source facts from which the posting kernel builds the
-- journal. The baseline only guarded a line's dimensions and tax evidence;
-- direct writers could still replace an approved or posted line after the
-- kernel had read it, leaving the source document different from its posted
-- journal. This migration makes the lifecycle boundary a storage invariant:
-- only a draft document may accept ordinary line INSERT, UPDATE, or DELETE.
--
-- Every mutation locks its owning document before reading status. Posting and
-- a direct/import writer therefore serialize on the same parent row: a line
-- write either commits while the document is still a draft (before posting
-- reads it), or waits for the status flip and is rejected. UPDATEs that move a
-- line also lock and validate both the old and new tenant-owned parents.
--
-- Two existing, explicit trusted maintenance paths remain available:
--   * `openbooks_sandbox_wipe_allowed(org_id)` for deleting a real sandbox;
--   * the paired transaction-local `openbooks.migration = on` and
--     `openbooks.amend = on` settings used by sandbox cloning and authenticated
--     historical source replay. `openbooks.amend` alone is never an edit
--     escape hatch. Ordinary corrections continue through reversal, void, or
--     adjusting-document services.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.document_line_immutability_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_old_document_id uuid;
  v_new_document_id uuid;
  v_old_org_id uuid;
  v_new_org_id uuid;
  v_old_found boolean := false;
  v_new_found boolean := false;
  v_old_status text;
  v_new_status text;
  v_parent record;
  v_sandbox_wipe boolean;
  v_trusted_replay boolean;
BEGIN
  v_old_document_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.document_id ELSE NULL END;
  v_new_document_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.document_id ELSE NULL END;
  v_old_org_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.org_id ELSE NULL END;
  v_new_org_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.org_id ELSE NULL END;

  -- Sandbox teardown is an explicit, tenant-scoped delete path. It runs before
  -- parent lookup because the teardown deliberately deletes children first and
  -- may encounter a parent that was already removed by an earlier pass.
  v_sandbox_wipe :=
    TG_OP = 'DELETE'
    AND (v_old_org_id IS NULL OR public.openbooks_sandbox_wipe_allowed(v_old_org_id));
  IF v_sandbox_wipe THEN
    RETURN OLD;
  END IF;

  -- Lock every referenced parent in deterministic id order. The lookup uses
  -- the physical parent id first, then checks org_id explicitly so a line can
  -- never borrow a document from another tenant even while composite foreign
  -- keys are being upgraded on an older installation.
  FOR v_parent IN
    SELECT d.id, d.org_id, d.status
      FROM public.documents d
     WHERE d.id IN (v_old_document_id, v_new_document_id)
     ORDER BY d.id
     FOR UPDATE
  LOOP
    IF v_parent.id = v_old_document_id THEN
      v_old_found := true;
      IF v_parent.org_id IS DISTINCT FROM v_old_org_id THEN
        RAISE EXCEPTION
          'document % does not exist in organization %',
          v_old_document_id, v_old_org_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      v_old_status := v_parent.status;
    END IF;
    IF v_parent.id = v_new_document_id THEN
      v_new_found := true;
      IF v_parent.org_id IS DISTINCT FROM v_new_org_id THEN
        RAISE EXCEPTION
          'document % does not exist in organization %',
          v_new_document_id, v_new_org_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      v_new_status := v_parent.status;
    END IF;
  END LOOP;

  IF v_old_document_id IS NOT NULL AND NOT v_old_found THEN
    RAISE EXCEPTION
      'document % does not exist in organization %',
      v_old_document_id, v_old_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_new_document_id IS NOT NULL AND NOT v_new_found THEN
    RAISE EXCEPTION
      'document % does not exist in organization %',
      v_new_document_id, v_new_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- This is the same paired, transaction-local authority used by the existing
  -- clone and historical replay services. Migration-only or amend-only callers
  -- remain blocked; no ordinary writer can turn either setting into an edit
  -- bypass by itself.
  v_trusted_replay :=
    coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on';
  IF v_trusted_replay THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_old_document_id IS NOT NULL AND v_old_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'document % is % — its lines are immutable outside draft status',
      v_old_document_id, v_old_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_new_document_id IS NOT NULL AND v_new_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'document % is % — its lines are immutable outside draft status',
      v_new_document_id, v_new_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

COMMENT ON FUNCTION public.document_line_immutability_guard() IS
  'openbooks:document_line_immutability:v1 - locks the tenant-owned parent document and permits ordinary line writes only while it is draft; sandbox wipe and paired migration/amend replay are explicit trusted paths';

DROP TRIGGER IF EXISTS document_line_immutability ON public.document_lines;
CREATE TRIGGER document_line_immutability
  BEFORE INSERT OR DELETE OR UPDATE ON public.document_lines
  FOR EACH ROW EXECUTE FUNCTION public.document_line_immutability_guard();
