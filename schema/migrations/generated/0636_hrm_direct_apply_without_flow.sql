-- OpenBooks forward migration 0636_hrm_direct_apply_without_flow.
--
-- Approval is an optional tenant Flow for employment change requests. A
-- submission no enabled Flow claims (zero enabled flows for the HRM change
-- request subject kind and no on_submit run for the request) applies
-- directly: draft -> approved with automatic evidence (no gates, policy
-- recording that no flow is configured), then approved -> applied through
-- the same canonical writer. A configured Flow still governs through its
-- gates or its explicit apply-without-approval outcome.
--
-- Admission mirrors the compensation ungated-submission precedent: the
-- guard admits the transition only with the actor, the stamps, and the
-- reason recorded atomically, the snapshot shape strict, the kind
-- preconditions re-proven in storage (a hire lands only on a version-less
-- identity; every other kind needs existing versions), and no enabled
-- flow plus no run to contradict the direct decision. Existing submitted
-- and approved history keeps its original controls; nothing else may skip
-- pending_approval.
--
-- No schema, data, or backfill: one trigger function replacement and three
-- CHECK rewrites, otherwise a no-op. Reapply-safe by construction.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- A direct application carries no flow run: admit the null run exactly on
-- the automatic no-flow evidence, never as a missing stamp.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_flow_run_iff_submitted') THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      DROP CONSTRAINT hrm_employment_change_requests_flow_run_iff_submitted;
  END IF;
  ALTER TABLE ONLY public.hrm_employment_change_requests
    ADD CONSTRAINT hrm_employment_change_requests_flow_run_iff_submitted
    CHECK (
      (submitted_at IS NULL) = (flow_run_id IS NULL)
      OR (
        COALESCE(payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change')
        AND COALESCE(decision_snapshot->>'mode', '') = 'automatic'
        AND COALESCE(decision_snapshot->'policy'->>'flowConfigured', '') = 'false'
      )
    );
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_run_presence') THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      DROP CONSTRAINT hrm_employment_change_requests_run_presence;
  END IF;
  ALTER TABLE ONLY public.hrm_employment_change_requests
    ADD CONSTRAINT hrm_employment_change_requests_run_presence
    CHECK (
      status NOT IN ('pending_approval', 'approved', 'rejected', 'applied')
      OR flow_run_id IS NOT NULL
      OR (
        COALESCE(payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change')
        AND COALESCE(decision_snapshot->>'mode', '') = 'automatic'
        AND COALESCE(decision_snapshot->'policy'->>'flowConfigured', '') = 'false'
      )
    );
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_snapshot_binding') THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      DROP CONSTRAINT hrm_employment_change_requests_snapshot_binding;
  END IF;
  ALTER TABLE ONLY public.hrm_employment_change_requests
    ADD CONSTRAINT hrm_employment_change_requests_snapshot_binding
    CHECK (
      decision_snapshot IS NULL
      OR (
        jsonb_typeof(decision_snapshot) = 'object'
        AND (decision_snapshot ? 'gates')
        AND jsonb_typeof(decision_snapshot -> 'gates') = 'array'
        AND (decision_snapshot ? 'payload_digest')
        AND jsonb_typeof(decision_snapshot -> 'payload_digest') = 'string'
        AND (decision_snapshot ->> 'payload_digest') = payload_digest
        AND (decision_snapshot ? 'payload_schema_version')
        AND jsonb_typeof(decision_snapshot -> 'payload_schema_version') = 'string'
        AND (decision_snapshot ->> 'payload_schema_version') = payload_schema_version
        AND (decision_snapshot ? 'expected_employment_revision')
        AND jsonb_typeof(decision_snapshot -> 'expected_employment_revision') = 'number'
        AND (decision_snapshot ->> 'expected_employment_revision')::numeric = expected_employment_revision
        AND (
          (
            (decision_snapshot ? 'flow_run_id')
            AND jsonb_typeof(decision_snapshot -> 'flow_run_id') = 'string'
            AND flow_run_id IS NOT NULL
            AND (decision_snapshot ->> 'flow_run_id') = flow_run_id::text
          )
          OR (
            COALESCE(payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change')
            AND COALESCE(decision_snapshot->>'mode', '') = 'automatic'
            AND COALESCE(decision_snapshot->'policy'->>'flowConfigured', '') = 'false'
          )
        )
      )
    );
END
$$;

CREATE OR REPLACE FUNCTION public.hrm_employment_change_request_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  computed_digest text;
  run_org uuid;
  run_kind text;
  run_subject uuid;
  change_org uuid;
  change_employment uuid;
  change_revision integer;
  direct_admission boolean := false;
BEGIN
  -- Canonical digest over the exact bytes of the jsonb normalized text
  -- form. Storage computes; callers never supply a trusted digest.
  computed_digest :=
    encode(digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex');

  IF TG_OP = 'INSERT' THEN
    -- Clone replay: the sandbox/sample-company clone replays immutable
    -- terminal history verbatim while the clone authority holds, which is
    -- only inside the clone's own maintenance transaction. Admit that
    -- replayed INSERT — the digest is still recomputed in storage below —
    -- while every ordinary session keeps the born-draft refusals that
    -- follow. UPDATE and DELETE of this history stay blocked: this
    -- admission returns only on the INSERT path.
    IF public.openbooks_clone_authority() THEN
      NEW.payload_digest := computed_digest;
      RETURN NEW;
    END IF;
    -- Rows are born drafts. A forged submission (pending_approval with a
    -- run, a snapshot, or submission stamps on insert) is refused: submit
    -- through the draft -> pending_approval transition instead.
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'HRM change request must be inserted as draft, then submitted — insert with status % is refused.', NEW.status;
    END IF;
    IF NEW.submitted_at IS NOT NULL OR NEW.submitted_by IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted unsubmitted — submit through the draft -> pending_approval transition instead.';
    END IF;
    IF NEW.flow_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted without a flow run — the run is stamped at submit instead.';
    END IF;
    IF NEW.decision_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted without a decision snapshot — it is written atomically with approve/reject instead.';
    END IF;
    IF NEW.applied_at IS NOT NULL OR NEW.applied_by IS NOT NULL
       OR NEW.applied_employment_revision IS NOT NULL
       OR NEW.applied_employment_change_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted unapplied — application evidence is stamped on approved -> applied instead.';
    END IF;
    NEW.payload_digest := computed_digest;
    RETURN NEW;
  END IF;

  -- Identity and creator are frozen from insert, even in draft: a proposal
  -- about another employment is a new request, not an edit. The row id and
  -- creation timestamp are frozen with them — history must not be re-keyed
  -- or re-dated.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION
      'HRM change request identity (id, org, employment, created_at, creator) is immutable — file a new request instead.';
  END IF;

  -- No-flow direct admission: approval is an optional tenant Flow. A draft
  -- flipping straight to approved is admitted only as the submitter's own
  -- direct application — stamps, reason, and an automatic no-flow snapshot
  -- atomically, the kind preconditions re-proven in storage (a hire lands
  -- only on a version-less identity; every other kind needs existing
  -- versions), and no enabled Flow plus no run to contradict the direct
  -- decision. Every operand is two-valued (COALESCE/IS NULL/EXISTS), so the
  -- flag is false unless the whole admission holds — never unknown.
  IF OLD.status = 'draft' AND NEW.status = 'approved'
     AND NEW.submitted_at IS NOT NULL AND NEW.submitted_by IS NOT NULL
     AND NEW.reason IS NOT NULL AND length(btrim(NEW.reason)) > 0
     AND NEW.flow_run_id IS NULL
     AND NEW.decision_snapshot IS NOT NULL
     AND COALESCE(NEW.payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change')
     AND COALESCE(NEW.decision_snapshot->>'mode', '') = 'automatic'
     AND COALESCE(NEW.decision_snapshot->'policy'->>'flowConfigured', '') = 'false'
     AND NOT EXISTS (
       SELECT 1 FROM public.flows f
        WHERE f.org_id = NEW.org_id
          AND f.subject_kind = 'hrm_employment_change_request'
          AND f.enabled
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.flow_runs r
        WHERE r.org_id = NEW.org_id
          AND r.subject_kind = 'hrm_employment_change_request'
          AND r.subject_id = NEW.id
     )
     AND (
       (
         COALESCE(NEW.payload->>'kind', '') = 'hire'
         AND NOT EXISTS (
           SELECT 1 FROM public.worker_employment_versions v
            WHERE v.org_id = NEW.org_id AND v.employment_id = NEW.employment_id
         )
       ) OR (
         COALESCE(NEW.payload->>'kind', '') <> 'hire'
         AND EXISTS (
           SELECT 1 FROM public.worker_employment_versions v
            WHERE v.org_id = NEW.org_id AND v.employment_id = NEW.employment_id
         )
       )
     )
  THEN
    direct_admission := true;
  END IF;

  -- Payload/digest/schema-version/expected-revision live only in draft.
  -- Draft payload edits recompute the digest in storage; anything else
  -- attempting a silent re-point is refused.
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version
     OR NEW.expected_employment_revision IS DISTINCT FROM OLD.expected_employment_revision THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'HRM change request payload, schema version, and expected revision freeze on submit — file a new request for a revised proposal instead.';
    END IF;
    NEW.payload_digest := computed_digest;
  ELSIF NEW.payload_digest IS DISTINCT FROM OLD.payload_digest THEN
    RAISE EXCEPTION
      'HRM change request digest is storage-computed and immutable outside draft payload edits — it cannot be re-pointed.';
  END IF;

  -- Draft edits advance the request revision by exactly one; submitted rows
  -- never move it (resubmission is a new request, not a revision bump).
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.payload IS NOT DISTINCT FROM OLD.payload
       AND NEW.payload_schema_version IS NOT DISTINCT FROM OLD.payload_schema_version
       AND NEW.expected_employment_revision IS NOT DISTINCT FROM OLD.expected_employment_revision
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
      -- Touch-only update (e.g. updated_at): revision stays put.
      IF NEW.request_revision IS DISTINCT FROM OLD.request_revision THEN
        RAISE EXCEPTION
          'HRM change request revision moves only with a draft edit, by exactly one — leave request_revision alone on a touch update.';
      END IF;
    ELSIF NEW.request_revision <> OLD.request_revision + 1 THEN
      RAISE EXCEPTION
        'HRM change request draft edits advance request_revision by exactly one (was %, got %) — do not skip or reuse revisions.', OLD.request_revision, NEW.request_revision;
    END IF;
  ELSIF NEW.request_revision IS DISTINCT FROM OLD.request_revision THEN
    RAISE EXCEPTION
      'HRM change request revision freezes on submit — file a new request for a revised proposal instead.';
  END IF;

  -- Lifecycle transitions. Terminal states never leave; rejected and
  -- withdrawn never resurrect (a revised proposal is a new request, so an
  -- old approval can never be re-pointed at it). The no-flow direct
  -- admission is the only draft -> approved path besides submission.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status NOT IN ('pending_approval', 'withdrawn') AND NOT direct_admission THEN
      RAISE EXCEPTION
        'HRM change request draft must submit (pending_approval) or withdraw — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'pending_approval'
            AND NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION
        'HRM change request awaiting approval resolves to approved, rejected, or withdrawn — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'approved' AND NEW.status <> 'applied' THEN
      RAISE EXCEPTION
        'HRM change request approved resolves only to applied — transition to % is refused. Withdraw or reject before approval instead.', NEW.status;
    ELSIF OLD.status IN ('rejected', 'withdrawn', 'applied') THEN
      RAISE EXCEPTION
        'HRM change request % is terminal — file a new request for a revised proposal instead.', OLD.status;
    END IF;
  END IF;

  -- Submission stamps are set once, on submit, and never re-pointed. A
  -- bare flip to pending_approval without them is refused here with a
  -- named remedy (the presence CHECKs backstop the same rule). The direct
  -- admission stamps actor/time/reason atomically on its draft -> approved
  -- flip; the run stays null by design there, admitted by the rewritten
  -- presence CHECKs above.
  IF (OLD.status = 'draft' AND NEW.status = 'pending_approval') OR direct_admission THEN
    IF NEW.submitted_at IS NULL OR NEW.submitted_by IS NULL
       OR (NEW.flow_run_id IS NULL AND NOT direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request submit stamps submission actor/time and the native flow run atomically — set submitted_by, submitted_at, and flow_run_id in the same update instead.';
    END IF;
    IF NEW.reason IS NULL OR length(btrim(NEW.reason)) = 0 THEN
      RAISE EXCEPTION
        'HRM change request submit carries a non-blank reason — record why the change is proposed instead.';
    END IF;
  END IF;
  IF OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'pending_approval') OR direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request submission stamps are set only on draft -> pending_approval — submit through that transition instead.';
    END IF;
  ELSIF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
        OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION
      'HRM change request submission actor and time are immutable once set — they record what was submitted, not what is convenient.';
  END IF;

  -- Submission reason is submission evidence: frozen once submitted.
  IF OLD.submitted_at IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION
      'HRM change request reason freezes on submit — record later rationale in the audit trail, not on the request.';
  END IF;

  -- The native run anchor is stamped at submit, verified against the live
  -- native run (same org, governed subject kind/id), and never re-pointed.
  -- Direct applications carry no run, so this block skips them.
  IF NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id THEN
    IF OLD.flow_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request flow run is retained once stamped — it cannot be re-pointed to another run.';
    END IF;
    IF NEW.flow_run_id IS NULL THEN
      RAISE EXCEPTION
        'HRM change request flow run cannot be cleared once stamped — it is retained as approval evidence.';
    END IF;
  END IF;
  IF NEW.flow_run_id IS NOT NULL THEN
    SELECT org_id, subject_kind, subject_id
      INTO run_org, run_kind, run_subject
      FROM public.flow_runs WHERE id = NEW.flow_run_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HRM change request flow run % does not exist — submit against a live native run instead.', NEW.flow_run_id;
    END IF;
    IF run_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION
        'HRM change request flow run % belongs to another organization — submit against a run in this organization instead.', NEW.flow_run_id;
    END IF;
    IF run_kind <> 'hrm_employment_change_request' OR run_subject IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION
        'HRM change request flow run % is not opened for this request (kind %, subject %) — open the governed HRM approval run for this request instead.', NEW.flow_run_id, run_kind, run_subject;
    END IF;
  END IF;

  -- Decision snapshot is written once, atomically with approve/reject, and
  -- frozen forever (the binding CHECK pins its keys to the row). The
  -- direct admission writes it atomically on draft -> approved.
  IF NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot THEN
    IF OLD.decision_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request decision snapshot is immutable once written — it records the decision that was made, not the one wanted.';
    END IF;
    IF NOT ((OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')) OR direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request decision snapshot is written only on pending_approval -> approved/rejected — decide through that transition instead.';
    END IF;
  END IF;

  -- Application evidence lands atomically with approved -> applied, linked
  -- to a live canonical change in this org. applied_by stays evidence:
  -- this trigger authenticates nothing about the application user.
  IF NEW.applied_employment_change_id IS DISTINCT FROM OLD.applied_employment_change_id THEN
    IF NOT (OLD.status = 'approved' AND NEW.status = 'applied') THEN
      RAISE EXCEPTION
        'HRM change request application evidence is stamped only on approved -> applied — apply through that transition instead.';
    END IF;
  END IF;
  IF NEW.status = 'applied' AND OLD.status = 'approved' THEN
    SELECT org_id, employment_id, revision
      INTO change_org, change_employment, change_revision
      FROM public.employment_changes WHERE id = NEW.applied_employment_change_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HRM change request applied change % does not exist — apply against the canonical change the approval produced instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION
        'HRM change request applied change % belongs to another organization — apply against a change in this organization instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_employment IS DISTINCT FROM NEW.employment_id THEN
      RAISE EXCEPTION
        'HRM change request applied change % is recorded against another employment — apply against the canonical change for this employment instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_revision IS DISTINCT FROM NEW.applied_employment_revision THEN
      RAISE EXCEPTION
        'HRM change request applied change % carries revision %, not the applied revision % — stamp the exact canonical revision the approval produced instead.', NEW.applied_employment_change_id, change_revision, NEW.applied_employment_revision;
    END IF;
  END IF;
  IF (OLD.status = 'applied')
     AND (NEW.applied_at IS DISTINCT FROM OLD.applied_at
          OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
          OR NEW.applied_employment_revision IS DISTINCT FROM OLD.applied_employment_revision
          OR NEW.applied_employment_change_id IS DISTINCT FROM OLD.applied_employment_change_id) THEN
    RAISE EXCEPTION
      'HRM change request application evidence is immutable once applied — a second application is a duplicate, not an update.';
  END IF;

  RETURN NEW;
END;
$func$;
