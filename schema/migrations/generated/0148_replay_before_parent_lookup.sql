-- OpenBooks forward migration 0148_replay_before_parent_lookup.
--
-- Sandbox cloning (and authenticated historical replay) copies document lines
-- before their parent documents, but the line-immutability guard looked the
-- parent up — raising when absent — before reaching its paired
-- migration+amend replay bypass. Every full-tier clone or refresh of an
-- organization holding document lines therefore died on the lines copy, an
-- breakage no test caught because no clone test posted invoices. This moves
-- the unchanged replay authority ahead of the parent lookup; ordinary
-- writers, the draft freeze, and the payroll-commit allowance behave bit for
-- bit as in 0145. Additive, no history reinterpretation: previously rejected
-- ordinary writes are still rejected; only the trusted replay path, which
-- already returned unconditionally once reached, is reached earlier.

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

  -- Trusted replay runs before the parent lookup (moved here in 0148): the
  -- sandbox clone copies document lines before their documents, so a
  -- legitimately absent parent must not raise for a replay caller. The
  -- authority is unchanged — paired, transaction-local migration+amend — and
  -- ordinary writers still fall through to the lookup and freeze below. The
  -- parent row lock is not load-bearing for replay: frozen posted lines admit
  -- no concurrent ordinary writer on the same document.
  v_trusted_replay :=
    coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on';
  IF v_trusted_replay THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
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
  'openbooks:document_line_immutability:v3 - locks the tenant-owned parent document and permits ordinary line writes only while it is draft; payroll commit may replace its own approved pay_run lines under transaction-local openbooks.payroll_commit; sandbox wipe and paired migration/amend replay are explicit trusted paths, with replay evaluated before the parent lookup so out-of-order trusted copies never trip on legitimately absent parents';
