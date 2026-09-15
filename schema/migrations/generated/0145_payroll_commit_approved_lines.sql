-- OpenBooks forward migration 0145_payroll_commit_approved_lines.
--
-- A pay run behind an approval policy commits AFTER its release, and the
-- release moves the document draft → approved. commitPayRun explicitly allows
-- both ("both are committable") — but migration 0034's storage freeze permits
-- line writes only in draft, so the commit's delete+insert of the run's own GL
-- projection dies on the approved document and no gated tenant can finish a
-- payroll. The demand (SoD: approval before commit) and the freeze (no
-- post-approval tampering) are both correct; only their meeting point was
-- never cut.
--
-- Additive, no history reinterpretation: this replaces the guard function with
-- one narrow, transaction-local allowance. When `openbooks.payroll_commit`
-- names a document id, that pay_run document's own lines may be deleted and
-- re-inserted while it is approved — the exact writes commitPayRun performs,
-- set by that engine path alone inside its commit transaction (set_config ...
-- local: the setting dies with the transaction and can never leak into
-- another). UPDATEs stay frozen — a commit never edits a line in place — and
-- every other kind and status keeps the 0034 behavior bit for bit. The lines
-- written are the approved GL preview's legs, recomputed from the stubs the
-- evidence package already showed the approver; the freeze's purpose (the
-- approved source document cannot drift under its approver) holds because the
-- allowance covers one document, one transaction, one engine path.
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
  v_old_kind text;
  v_new_kind text;
  v_parent record;
  v_sandbox_wipe boolean;
  v_trusted_replay boolean;
  v_payroll_commit text;
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
    SELECT d.id, d.org_id, d.status, d.kind
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
      v_old_kind := v_parent.kind;
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
      v_new_kind := v_parent.kind;
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

  -- Payroll commit on an approved pay run (migration 0145). The engine sets
  -- `openbooks.payroll_commit` to the committing run's document id inside its
  -- commit transaction only, after the approval release, the commit-time
  -- fences, and both freshness re-checks have passed. Honored solely for that
  -- document's own lines, solely while its parent is an approved pay_run, and
  -- solely for the delete+insert pair a commit performs — UPDATE stays frozen.
  v_payroll_commit := coalesce(current_setting('openbooks.payroll_commit', true), '');
  IF (TG_OP = 'DELETE' OR TG_OP = 'INSERT') AND v_payroll_commit <> '' THEN
    IF TG_OP = 'DELETE'
       AND v_old_document_id::text = v_payroll_commit
       AND v_old_kind = 'pay_run' AND v_old_status = 'approved' THEN
      RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT'
       AND v_new_document_id::text = v_payroll_commit
       AND v_new_kind = 'pay_run' AND v_new_status = 'approved' THEN
      RETURN NEW;
    END IF;
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
  'openbooks:document_line_immutability:v2 - locks the tenant-owned parent document and permits ordinary line writes only while it is draft; payroll commit may replace its own approved pay_run lines under transaction-local openbooks.payroll_commit; sandbox wipe and paired migration/amend replay are explicit trusted paths';
