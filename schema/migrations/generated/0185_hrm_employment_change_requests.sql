-- OpenBooks forward migration 0185_hrm_employment_change_requests.
--
-- Governed HRM employment change REQUEST storage — proposals, not mutations.
-- The canonical employment record stays in worker_employments and its
-- immutable employment_changes ledger (0184, schema worker); approval
-- execution stays in native Flows (flow_runs / flow_gates driven by a
-- FlowSubjectAdapter with subject_kind 'hrm_employment_change_request').
-- This table owns neither mutation nor approval: it binds one frozen
-- proposal to the exact aggregate revision it was written against and to
-- the native flow run that decides it, so a stale or edited proposal can
-- never ride an old approval into the canonical record.
--
-- WHY EACH MECHANISM EARNS ITS KEEP.
--
-- Storage-computed digest. payload_digest is computed by the guard trigger
-- on every insert and every draft payload edit, never trusted from the
-- caller: the canonical bytes are exactly
--   convert_to(payload::text, 'UTF8')
-- where payload::text is PostgreSQL's jsonb normalized text form (object
-- keys sorted, insignificant whitespace eliminated, numbers normalized).
-- sha256 over those bytes, hex-encoded. The application service MUST NOT
-- invent its own canonicalization: it submits the payload and reads the
-- stored digest back. Any caller-supplied digest that disagrees is refused,
-- and the digest column is frozen outside draft edits — so an approval
-- bound to digest D can never be re-pointed at edited payload with
-- digest D'. Format alone (hex-64 CHECK) would accept a well-formed lie.
--
-- Expected-revision binding. expected_employment_revision is the exact
-- worker_employments.revision the proposal was written against (floor 1:
-- 0184 stores reserved identities at revision 1 with no effective version
-- until a governed create applies, so a new-hire create binds 1, never a
-- fabricated active employment). The application service refuses to apply
-- when the live aggregate revision differs — storage cannot see that race,
-- so it binds the expectation immutably instead.
--
-- Decision snapshot, not decision duplication. On approve/reject the service
-- writes decision_snapshot atomically with the status flip: the bound
-- digests plus the native gate evidence (every decided gate of the bound
-- run with its actual decided_by and delegation principal). Storage pins
-- the snapshot's bound keys EQUAL to the row (payload_digest,
-- payload_schema_version, expected_employment_revision, flow_run_id) and
-- freezes the snapshot forever — but the gates themselves stay native.
-- There is no second workflow table and no boolean approved flag: status
-- is the only lifecycle signal, and the final application inspects native
-- gate evidence through the service, never trusts status=approved alone.
--
-- Flow-run scope binding. A plain FK to flow_runs(id) proves existence but
-- not scope, so the guard trigger additionally verifies the bound run is
-- in THIS org with subject_kind 'hrm_employment_change_request' and
-- subject_id = this request id. Submitted rows always carry their run
-- (retained through approved/applied/rejected/withdrawn); drafts never do.
--
-- Actor UUIDs are evidence, not scope. submitted_by / applied_by reference
-- users(id) ON DELETE SET NULL with NO same-org assertion: the identity
-- subsystem may resolve home-org users, and storage must not assert a
-- cross-org sandbox mechanism it has not checked. applied_by never
-- authenticates — application auth belongs to the service.
--
-- Every CHECK below is written null-safe: a comparison involving a nullable
-- column yields UNKNOWN (which passes), so each nullable participant gets
-- an explicit IS [NOT] NULL conjunct or a presence test. See the snapshot
-- binding CHECK, the densest case.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS public.hrm_employment_change_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employment_id uuid NOT NULL,
    -- Row version of THIS request. Draft edits bump by exactly one (guard
    -- trigger); frozen the moment the row leaves draft.
    request_revision integer NOT NULL DEFAULT 1,
    -- Exact worker_employments.revision this proposal was written against.
    -- Floor 1 per coordinator ruling: reserved identities sit at revision 1.
    expected_employment_revision integer NOT NULL,
    -- The frozen proposal. Editable in draft only (digest recomputed);
    -- immutable once submitted.
    payload jsonb NOT NULL,
    -- Storage-computed sha256 hex over canonical jsonb text. See header.
    payload_digest text NOT NULL,
    -- Payload contract version, interpreted by the service's JSON-schema
    -- validation (planned at service, not storage).
    payload_schema_version text NOT NULL,
    -- Submission reason. Null in draft; non-blank once submitted.
    reason text,
    status text NOT NULL DEFAULT 'draft',
    -- Submission actor/time. Both null before first submission, both set
    -- after; a draft withdrawn before submission never fabricates them.
    submitted_by uuid,
    submitted_at timestamp with time zone,
    -- Native approval run anchor. Null in draft; set at submit; retained
    -- through every terminal state; never re-pointed once set.
    flow_run_id uuid,
    -- Immutable decision evidence, written atomically with approve/reject.
    -- Binds digests + native gate evidence; frozen forever once set.
    decision_snapshot jsonb,
    -- Application evidence. All four set atomically with approved->applied,
    -- all null otherwise. applied_by is evidence only, never auth.
    applied_at timestamp with time zone,
    applied_by uuid,
    applied_employment_revision integer,
    applied_employment_change_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT hrm_employment_change_requests_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_status_valid'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_status_valid
      CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'withdrawn', 'applied'));
  END IF;
END
$$;

-- status is NOT NULL, so IN is two-valued here — no UNKNOWN loophole.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_revision_floor'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_revision_floor
      CHECK (request_revision >= 1 AND expected_employment_revision >= 1);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_payload_shape'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_payload_shape
      CHECK (
        jsonb_typeof(payload) = 'object'
        AND payload_digest ~ '^[0-9a-f]{64}$'
        AND length(btrim(payload_schema_version)) > 0
      );
  END IF;
END
$$;

-- payload, payload_digest, payload_schema_version are all NOT NULL, so
-- every conjunct above is two-valued. Computation (not just shape) is
-- enforced by the guard trigger.

-- Submission pairing: submitted_by and submitted_at are set together.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_submission_paired'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_submission_paired
      CHECK ((submitted_at IS NULL) = (submitted_by IS NULL));
  END IF;
END
$$;

-- A submitted row is never a draft; a draft withdrawn before submission
-- keeps both submission columns null (no fabricated submission).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_submitted_not_draft'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_submitted_not_draft
      CHECK (submitted_at IS NULL OR status <> 'draft');
  END IF;
END
$$;

-- The native run anchor exists exactly when the row has been submitted,
-- and is retained through every post-submission state.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_flow_run_iff_submitted'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_flow_run_iff_submitted
      CHECK ((submitted_at IS NULL) = (flow_run_id IS NULL));
  END IF;
END
$$;

-- A submission carries a real reason; drafts may not have one yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_reason_on_submit'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_reason_on_submit
      CHECK (submitted_at IS NULL OR (reason IS NOT NULL AND length(btrim(reason)) > 0));
  END IF;
END
$$;

-- Decision evidence exists exactly on decided rows (approved, rejected,
-- and applied which retains its approval evidence). Withdrawn rows carry
-- no decision even when they retain a submitted run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_snapshot_iff_decided'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_snapshot_iff_decided
      CHECK ((status IN ('approved', 'rejected', 'applied')) = (decision_snapshot IS NOT NULL));
  END IF;
END
$$;

-- Snapshot binding: the snapshot's bound keys MUST equal the row, with an
-- explicit presence conjunct per key — a missing key yields NULL, and a
-- bare `->> = column` comparison would pass on UNKNOWN. flow_run_id is the
-- nullable participant, so it gets its own IS NOT NULL conjunct.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_snapshot_binding'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_snapshot_binding
      CHECK (
        decision_snapshot IS NULL
        OR (
          jsonb_typeof(decision_snapshot) = 'object'
          AND (decision_snapshot ? 'gates')
          AND jsonb_typeof(decision_snapshot -> 'gates') = 'array'
          AND (decision_snapshot ? 'payload_digest')
          AND (decision_snapshot ->> 'payload_digest') = payload_digest
          AND (decision_snapshot ? 'payload_schema_version')
          AND (decision_snapshot ->> 'payload_schema_version') = payload_schema_version
          AND (decision_snapshot ? 'expected_employment_revision')
          AND (decision_snapshot ->> 'expected_employment_revision')::integer = expected_employment_revision
          AND (decision_snapshot ? 'flow_run_id')
          AND flow_run_id IS NOT NULL
          AND (decision_snapshot ->> 'flow_run_id') = flow_run_id::text
        )
      );
  END IF;
END
$$;

-- Application metadata is all-or-nothing with status = 'applied'.
-- Every side is a non-null boolean; no UNKNOWN loophole.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_applied_paired'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_applied_paired
      CHECK (
        ((status = 'applied') = (applied_at IS NOT NULL))
        AND ((status = 'applied') = (applied_by IS NOT NULL))
        AND ((status = 'applied') = (applied_employment_revision IS NOT NULL))
        AND ((status = 'applied') = (applied_employment_change_id IS NOT NULL))
      );
  END IF;
END
$$;

-- Composite employment scope ONLY, per coordinator ruling: no single-column
-- FK with a trigger org check. Requires 0184's UNIQUE(org_id, id).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_org_id_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_employment_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_employment_fkey
      FOREIGN KEY (org_id, employment_id)
      REFERENCES public.worker_employments(org_id, id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
END
$$;

-- Existence/history pin for the native run. Scope (same org, governed
-- subject kind/id) is verified by the guard trigger — a simple FK cannot
-- express it. RESTRICT so approval history can never be silently detached.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_flow_run_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_flow_run_fkey
      FOREIGN KEY (flow_run_id) REFERENCES public.flow_runs(id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
END
$$;

-- Application-evidence link to the immutable canonical change. RESTRICT so
-- an applied request can never lose its canonical counterpart. Org match
-- is verified by the guard trigger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_applied_change_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_applied_change_fkey
      FOREIGN KEY (applied_employment_change_id)
      REFERENCES public.employment_changes(id)
      ON DELETE RESTRICT DEFERRABLE;
  END IF;
END
$$;

-- Actor UUIDs are evidence with no same-org assertion (home-org users).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_submitted_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_submitted_by_fkey
      FOREIGN KEY (submitted_by) REFERENCES public.users(id)
      ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_applied_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_applied_by_fkey
      FOREIGN KEY (applied_by) REFERENCES public.users(id)
      ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_created_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id)
      ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'hrm_employment_change_requests_updated_by_fkey'
  ) THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      ADD CONSTRAINT hrm_employment_change_requests_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id)
      ON DELETE SET NULL DEFERRABLE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS hrm_employment_change_requests_employment
  ON public.hrm_employment_change_requests USING btree (org_id, employment_id, status);

CREATE INDEX IF NOT EXISTS hrm_employment_change_requests_flow_run
  ON public.hrm_employment_change_requests USING btree (org_id, flow_run_id);

-- Guard trigger: lifecycle transitions, freezes, canonical digest, and
-- native run/change scope binding. Every refusal names the remedy.
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
BEGIN
  -- Canonical digest over the exact bytes of the jsonb normalized text
  -- form. Storage computes; callers never supply a trusted digest.
  computed_digest :=
    encode(digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex');

  IF TG_OP = 'INSERT' THEN
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
  -- about another employment is a new request, not an edit.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION
      'HRM change request identity (org, employment, creator) is immutable — file a new request instead.';
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
  -- old approval can never be re-pointed at it).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status NOT IN ('pending_approval', 'withdrawn') THEN
      RAISE EXCEPTION
        'HRM change request draft must submit (pending_approval) or withdraw — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'pending_approval'
            AND NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION
        'HRM change request awaiting approval resolves to approved, rejected, or withdrawn — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'approved' AND NEW.status <> 'applied' THEN
      RAISE EXCEPTION
        'HRM change request approved resolves only to applied — transition to % is refused. Withdraw or reject before approval instead.';
    ELSIF OLD.status IN ('rejected', 'withdrawn', 'applied') THEN
      RAISE EXCEPTION
        'HRM change request % is terminal — file a new request for a revised proposal instead.', OLD.status;
    END IF;
  END IF;

  -- Submission stamps are set once, on submit, and never re-pointed.
  IF OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'pending_approval' THEN
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
  -- frozen forever (the binding CHECK pins its keys to the row).
  IF NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot THEN
    IF OLD.decision_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request decision snapshot is immutable once written — it records the decision that was made, not the one wanted.';
    END IF;
    IF NOT (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')) THEN
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
    SELECT org_id INTO change_org
      FROM public.employment_changes WHERE id = NEW.applied_employment_change_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HRM change request applied change % does not exist — apply against the canonical change the approval produced instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION
        'HRM change request applied change % belongs to another organization — apply against a change in this organization instead.', NEW.applied_employment_change_id;
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

DROP TRIGGER IF EXISTS hrm_employment_change_request_guard_trigger
  ON public.hrm_employment_change_requests;

CREATE TRIGGER hrm_employment_change_request_guard_trigger
  BEFORE INSERT OR UPDATE ON public.hrm_employment_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.hrm_employment_change_request_guard();

-- Submitted history is never deleted. Pure drafts (never submitted) may be
-- discarded; everything else is retained and terminal states speak.
CREATE OR REPLACE FUNCTION public.hrm_employment_change_request_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'HRM change request % was submitted and is retained as history — withdraw it instead of deleting it.', OLD.id;
  END IF;
  RETURN OLD;
END;
$func$;

DROP TRIGGER IF EXISTS hrm_employment_change_request_no_delete_trigger
  ON public.hrm_employment_change_requests;

CREATE TRIGGER hrm_employment_change_request_no_delete_trigger
  BEFORE DELETE ON public.hrm_employment_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.hrm_employment_change_request_no_delete();

ALTER TABLE ONLY public.hrm_employment_change_requests FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'hrm_employment_change_requests'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.hrm_employment_change_requests
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.hrm_employment_change_requests IS 'openbooks:org_isolation:v1';

ALTER TABLE public.hrm_employment_change_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.hrm_employment_change_requests IS
  'Governed HRM employment change proposals. One row binds a frozen payload (storage-computed sha256 digest over canonical jsonb text) to the exact worker_employments revision it was written against and to the native Flows run that decides it. Lifecycle draft -> pending_approval -> approved/rejected/withdrawn, approved -> applied; rejected/withdrawn/applied are terminal and revised proposals are new rows, so no approval is ever re-pointed at edited payload. Canonical mutation stays in employment_changes (0184); approval execution stays in flow_runs/flow_gates; application auth stays in the service — applied_by here is evidence only.';

COMMENT ON COLUMN public.hrm_employment_change_requests.payload_digest IS
  'sha256 hex over convert_to(payload::text, UTF8): PostgreSQL jsonb normalized text is the canonical form. Computed by the guard trigger on insert and draft payload edits; callers must not trust a self-computed digest — submit the payload and read this back.';

COMMENT ON COLUMN public.hrm_employment_change_requests.expected_employment_revision IS
  'Exact worker_employments.revision the proposal was written against (>= 1; reserved identities sit at 1 with no effective version until a governed create applies). The application service refuses to apply when the live revision differs — storage binds the expectation, the service wins the race.';

COMMENT ON COLUMN public.hrm_employment_change_requests.decision_snapshot IS
  'Immutable decision evidence written atomically with approve/reject: bound digests plus every decided native gate (actual decided_by with delegation principal). Bound keys are CHECK-pinned to the row; the gates themselves stay native — this snapshot duplicates no workflow state.';
