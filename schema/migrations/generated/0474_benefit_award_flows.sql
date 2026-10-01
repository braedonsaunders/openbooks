-- Native Benefits approval policies and immutable decision evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.hrm_benefit_programs
  ADD COLUMN approval_mode text NOT NULL DEFAULT 'none',
  ADD CONSTRAINT hrm_benefit_programs_approval_mode CHECK (approval_mode IN ('none','flows'));

INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'hrm_benefit_programs', id, 'update',
  jsonb_build_object('event','approval_setting_initialized', 'actor',jsonb_build_object('kind','system'),
    'before',jsonb_build_object('approvalMode',NULL), 'after',jsonb_build_object('approvalMode','none'),
    'reason','No approvals required unless the employer explicitly selects native Flows approval.'), NULL
FROM public.hrm_benefit_programs;

ALTER TABLE public.hrm_benefit_awards
  ADD COLUMN flow_run_id uuid,
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decision_snapshot jsonb;

ALTER TABLE public.hrm_benefit_award_events DROP CONSTRAINT hrm_benefit_award_events_kind;
ALTER TABLE public.hrm_benefit_award_events ADD CONSTRAINT hrm_benefit_award_events_kind
  CHECK (kind IN ('created','submitted','approved','automatically_approved','rejected','queued','delivered','external_delivered','voided','workflow_resubmission_required'));

-- Pending rewards have no payable or approval effect. Preserve each record and
-- its original submission events, and return it to draft for a new submission
-- under an explicitly configured native policy. Financial history is untouched.
LOCK TABLE public.hrm_benefit_awards IN SHARE ROW EXCLUSIVE MODE;
DO $normalize$
BEGIN
  IF EXISTS (SELECT 1 FROM public.hrm_benefit_awards WHERE status = 'pending'
    AND (approved_by IS NOT NULL OR approved_at IS NOT NULL OR pay_run_document_id IS NOT NULL
      OR pay_run_adjustment_id IS NOT NULL OR external_ref IS NOT NULL)) THEN
    RAISE EXCEPTION 'A pending Benefits reward contains approval or payroll evidence. Preserve its payroll and approval history and reconcile its recorded state through an audited native maintenance amendment before applying this migration.';
  END IF;
END;
$normalize$;
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'hrm_benefit_awards', id, 'update',
  jsonb_build_object('event','workflow_resubmission_required', 'actor',jsonb_build_object('kind','system'),
    'before',jsonb_build_object('status',status,'programSnapshot',program_snapshot,'updatedAt',updated_at,'updatedBy',updated_by),
    'after',jsonb_build_object('status','draft','programSnapshot',program_snapshot || jsonb_build_object('approvalMode','none'),'updatedAt',now(),'updatedBy',NULL),
    'reason','The program approval setting is initialized to no approvals required; submit the reward again through its record action.'), NULL
FROM public.hrm_benefit_awards WHERE status IN ('draft','pending');
INSERT INTO public.hrm_benefit_award_events (org_id, award_id, kind, reason, actor, created_by)
SELECT org_id, id, 'workflow_resubmission_required',
  'Returned to draft without financial changes. No approvals are required by the program setting; submit the reward again through its record action.', NULL, NULL
FROM public.hrm_benefit_awards WHERE status = 'pending';
ALTER TABLE public.hrm_benefit_awards DISABLE TRIGGER hrm_benefit_award_snapshot_immutable_trigger;
UPDATE public.hrm_benefit_awards SET status = 'draft', updated_at = now(), updated_by = NULL WHERE status = 'pending';
UPDATE public.hrm_benefit_awards SET program_snapshot = program_snapshot || jsonb_build_object('approvalMode','none'), updated_at = now(), updated_by = NULL WHERE status = 'draft';
ALTER TABLE public.hrm_benefit_awards ENABLE TRIGGER hrm_benefit_award_snapshot_immutable_trigger;
ALTER TABLE public.hrm_benefit_awards DROP CONSTRAINT hrm_benefit_awards_status;
ALTER TABLE public.hrm_benefit_awards
  ADD CONSTRAINT hrm_benefit_awards_status CHECK (status IN ('draft','pending','approved','rejected','queued','delivered','voided')),
  ADD CONSTRAINT hrm_benefit_awards_flow_run_fk FOREIGN KEY (flow_run_id) REFERENCES public.flow_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT hrm_benefit_awards_decision_object CHECK (decision_snapshot IS NULL OR jsonb_typeof(decision_snapshot) = 'object');
CREATE INDEX hrm_benefit_awards_flow_run ON public.hrm_benefit_awards (org_id,flow_run_id) WHERE flow_run_id IS NOT NULL;

-- Preserve the existing snapshot, payroll-linkage and terminal-history guards.
-- Native workflow evidence below governs every direct and gated approval.
CREATE OR REPLACE FUNCTION public.hrm_benefit_award_snapshot_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.program_snapshot IS DISTINCT FROM OLD.program_snapshot
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.period_from IS DISTINCT FROM OLD.period_from
     OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.value IS DISTINCT FROM OLD.value
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source_key IS DISTINCT FROM OLD.source_key
     OR NEW.adjusts_award_id IS DISTINCT FROM OLD.adjusts_award_id THEN
    IF OLD.status = 'rejected' THEN
      RAISE EXCEPTION 'Benefit award % is rejected history — create a new reward instead of rewriting it.', OLD.id;
    END IF;
    IF OLD.status = 'delivered' THEN
      RAISE EXCEPTION
        'HRM benefit award % is delivered history — issue an adjusting award instead of rewriting it.', OLD.id;
    END IF;
    RAISE EXCEPTION
      'HRM benefit award % carries immutable program and source snapshots — void it and issue a new award instead of rewriting it.', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'queued', 'delivered', 'voided')
     AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION
      'HRM benefit award % evidence froze at approval — void it and issue a new award instead of rewriting the proof.', OLD.id;
  END IF;
  IF OLD.status = 'rejected' AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION 'Benefit award % is rejected history — preserve its evidence and create a new reward.', OLD.id;
  END IF;
  IF OLD.status = 'rejected' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Benefit award % is rejected history — preserve the decision and create a new reward.', OLD.id;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Benefit award % is delivered history — record an adjusting award instead of changing its status.', OLD.id;
  END IF;
  IF OLD.status = 'voided' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Benefit award % is voided history — issue a new award with a new source reference instead of changing its status.', OLD.id;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Benefit award % creation evidence is immutable — preserve its recorded author and time.', OLD.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending', 'approved', 'voided')) OR
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'voided')) OR
    (OLD.status = 'approved' AND NEW.status IN ('queued', 'voided')) OR
    (OLD.status = 'queued' AND NEW.status IN ('delivered', 'voided'))
  ) THEN
    RAISE EXCEPTION 'Benefit award % has an invalid lifecycle move — use submission, configured approval, payroll queue and delivery in order.', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'rejected', 'queued', 'delivered', 'voided')
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Benefit award % approval evidence is immutable — preserve its recorded approver and time.', OLD.id;
  END IF;
  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref
     AND NOT (OLD.status = 'queued' AND NEW.status = 'delivered') THEN
    RAISE EXCEPTION 'Benefit award % external reference writes only at delivery — record provider fulfillment through the award service.', OLD.id;
  END IF;
  IF NEW.pay_run_document_id IS DISTINCT FROM OLD.pay_run_document_id
     OR NEW.pay_run_adjustment_id IS DISTINCT FROM OLD.pay_run_adjustment_id THEN
    IF NOT (
      (OLD.status = 'approved' AND NEW.status = 'queued'
       AND OLD.pay_run_document_id IS NULL AND OLD.pay_run_adjustment_id IS NULL
       AND NEW.pay_run_document_id IS NOT NULL AND NEW.pay_run_adjustment_id IS NOT NULL) OR
      (OLD.status = 'queued' AND NEW.status = 'voided'
       AND NEW.pay_run_document_id IS NULL AND NEW.pay_run_adjustment_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Benefit award % payroll linkage is immutable after queueing — use the recorded adjustment or void it through its editable pay run.', OLD.id;
    END IF;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'queued'
     AND (SELECT delivery_method = 'payroll' FROM public.hrm_benefit_programs WHERE org_id = NEW.org_id AND id = NEW.program_id) THEN
    IF NEW.pay_run_document_id IS NULL OR NEW.pay_run_adjustment_id IS NULL THEN
      RAISE EXCEPTION 'Benefit award % requires a native payroll adjustment — select an editable pay run before queueing.', OLD.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_run_adjustments a
      JOIN public.pay_runs r ON r.org_id = a.org_id AND r.document_id = a.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      JOIN public.worker_employments e ON e.org_id = NEW.org_id AND e.id = NEW.employment_id
      JOIN public.hrm_benefit_programs p ON p.org_id = NEW.org_id AND p.id = NEW.program_id
      WHERE a.org_id = NEW.org_id AND a.id = NEW.pay_run_adjustment_id
        AND a.pay_run_document_id = NEW.pay_run_document_id
        AND a.employee_party_id = e.worker_party_id AND a.component_id = p.pay_component_id
        AND a.adjustment_type = 'line' AND NOT a.replace_component AND a.amount = NEW.value
        AND a.note = 'Benefit award ' || NEW.id::text || ' (' || p.code || ' ' || NEW.period_from::text || '..' || coalesce(NEW.period_to::text, 'open') || ')'
        AND d.status = 'draft' AND r.run_status <> 'committed'
        AND d.subsidiary_id = p.legal_entity_id AND d.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION 'Benefit award % does not match an editable native payroll adjustment — queue it through its pay-run action.', OLD.id;
    END IF;
  END IF;
  IF OLD.status = 'queued' AND NEW.status = 'voided' AND OLD.pay_run_document_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_runs r JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
       WHERE r.org_id = OLD.org_id AND r.document_id = OLD.pay_run_document_id
         AND r.run_status <> 'committed' AND d.status = 'draft'
    ) THEN
      RAISE EXCEPTION 'Benefit award % belongs to a finalized pay run — preserve delivered history and record a payroll correction.', OLD.id;
    END IF;
    IF NEW.pay_run_document_id IS NOT NULL OR NEW.pay_run_adjustment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Benefit award % still has a payable adjustment — void it through the award service to remove the adjustment atomically.', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$func$;

CREATE FUNCTION public.hrm_benefit_award_workflow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE
  run_row public.flow_runs%ROWTYPE;
BEGIN
  -- Controlled tenant teardown retains the existing privileged amendment seam.
  IF public.app_bypass_rls_active() AND current_setting('openbooks.amend',true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.flow_run_id IS NOT NULL OR NEW.decision_snapshot IS NOT NULL
      OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.submitted_by IS NOT NULL OR NEW.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Create a draft Benefits reward, then submit it through its configured workflow; approval evidence cannot be supplied on creation.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.hrm_benefit_programs p WHERE p.org_id = NEW.org_id AND p.id = NEW.program_id
      AND p.approval_mode = NEW.program_snapshot->>'approvalMode')
      OR NEW.program_snapshot->>'id' IS DISTINCT FROM NEW.program_id::text THEN
      RAISE EXCEPTION 'The reward must snapshot its program approval setting; create it through the Benefits record action.';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.flow_run_id IS NOT NULL OR OLD.decision_snapshot IS NOT NULL) AND
    (NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at) THEN
    RAISE EXCEPTION 'Benefits workflow submission evidence is immutable; create a new reward for a new decision.';
  END IF;
  IF OLD.decision_snapshot IS NOT NULL AND (NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Benefits approval decisions are immutable; create a correcting reward rather than changing decision evidence.';
  END IF;
  IF OLD.status <> 'draft' AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION 'Submitted Benefits reward evidence is immutable; create a new reward for different evidence.';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending','approved','voided')) OR
    (OLD.status = 'pending' AND NEW.status IN ('approved','rejected','voided')) OR
    (OLD.status = 'approved' AND NEW.status IN ('queued','voided')) OR
    (OLD.status = 'queued' AND NEW.status IN ('delivered','voided'))
  ) THEN
    RAISE EXCEPTION 'Invalid Benefits reward transition from % to %; use the available record actions.', OLD.status, NEW.status;
  END IF;
  IF NEW.flow_run_id IS NOT NULL THEN
    IF NEW.status = 'draft' OR NEW.program_snapshot->>'approvalMode' IS DISTINCT FROM 'flows' THEN
      RAISE EXCEPTION 'Workflow submission requires the pinned Flows approval setting and a submitted reward; submit through its record action.';
    END IF;
    SELECT * INTO run_row FROM public.flow_runs
      WHERE id = NEW.flow_run_id AND org_id = NEW.org_id
        AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND trigger = 'on_submit';
    IF NOT FOUND OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL
      OR run_row.created_by IS DISTINCT FROM NEW.submitted_by
      OR run_row.context->>'programId' IS DISTINCT FROM NEW.program_id::text
      OR run_row.context->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
      OR run_row.context->>'currency' IS DISTINCT FROM NEW.currency
      OR (run_row.context->>'value')::numeric IS DISTINCT FROM NEW.value
      OR jsonb_typeof(run_row.context->'submissionPolicy') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Benefits submission requires a matching organization, reward, submitter and pinned workflow policy; submit through the Benefits record action.';
    END IF;
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'pending' AND
    (NEW.flow_run_id IS NULL OR NEW.program_snapshot->>'approvalMode' IS DISTINCT FROM 'flows') THEN
    RAISE EXCEPTION 'Configure a Benefits approval policy in Flows before submitting this reward; submit it through its configured workflow.';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    IF NEW.flow_run_id IS NOT NULL OR NEW.program_snapshot->>'approvalMode' IS DISTINCT FROM 'none'
      OR NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'mode' IS DISTINCT FROM 'not_required'
      OR NEW.decision_snapshot->>'approvalMode' IS DISTINCT FROM 'none'
      OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved'
      OR NEW.decision_snapshot->>'programId' IS DISTINCT FROM NEW.program_id::text
      OR NEW.decision_snapshot->>'revision' IS DISTINCT FROM NEW.program_snapshot->>'revision'
      OR NEW.program_snapshot->>'revision' IS NULL
      OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NULL OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL
      OR NEW.submitted_by IS DISTINCT FROM NEW.updated_by
      OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id) THEN
      RAISE EXCEPTION 'No-approval submission requires the pinned program setting and immutable decision evidence; submit through the Benefits record action.';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
      IF NEW.flow_run_id IS NULL OR NEW.decision_snapshot IS NULL
        OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
        OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM NEW.status
        OR NEW.program_snapshot->>'approvalMode' IS DISTINCT FROM 'flows' THEN
        RAISE EXCEPTION 'Benefits approval requires immutable matching workflow decision evidence; complete the assigned decisions in Approvals.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status IN ('pending','escalated'))
        OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status = 'failed') THEN
        RAISE EXCEPTION 'Benefits approval stages are incomplete or failed; resolve the workflow before adding this reward to payroll.';
      END IF;
      IF NEW.decision_snapshot->>'mode' = 'automatic' THEN
        IF NEW.status <> 'approved' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NULL OR run_row.status <> 'completed'
          OR run_row.context->'submissionPolicy'->>'ungatedOutcome' IS DISTINCT FROM 'apply'
          OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id) THEN
          RAISE EXCEPTION 'Direct Benefits processing requires an explicit completed ungated policy and records no human approver.';
        END IF;
      ELSIF NEW.decision_snapshot->>'mode' = 'human' THEN
        IF (NEW.status = 'approved' AND (NEW.approved_by IS DISTINCT FROM NEW.updated_by OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL))
          OR (NEW.status = 'rejected' AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL))
          OR NOT EXISTS (
            SELECT 1 FROM public.flow_gates g WHERE g.org_id = NEW.org_id AND g.subject_kind = 'hrm_benefit_award'
              AND g.subject_id = NEW.id AND g.status = NEW.status AND g.decided_by = NEW.updated_by AND g.decided_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.decision_snapshot->'gates') = 'array'
                THEN NEW.decision_snapshot->'gates' ELSE '[]'::jsonb END) evidence
                WHERE evidence->>'id' = g.id::text AND evidence->>'status' = g.status
                  AND evidence->>'decided_by' = g.decided_by::text AND (evidence->>'decided_at')::timestamptz = g.decided_at)
          )
          OR (NEW.status = 'approved' AND EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status = 'rejected')) THEN
          RAISE EXCEPTION 'No matching native approval actor and timestamp authorize this Benefits reward; decide its assigned gate in Approvals.';
        END IF;
      ELSE
        RAISE EXCEPTION 'Benefits decision mode must be explicit direct processing or a native human gate decision.';
      END IF;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'queued' THEN
    IF NEW.program_snapshot->>'approvalMode' IS NULL
      OR NEW.program_snapshot->>'approvalMode' NOT IN ('none','flows')
      OR NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved'
      OR (NEW.program_snapshot->>'approvalMode' = 'flows' AND
        (NEW.flow_run_id IS NULL OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
          OR NEW.decision_snapshot->>'mode' IS NULL OR NEW.decision_snapshot->>'mode' NOT IN ('human','automatic')
          OR NEW.approved_at IS NULL OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL
          OR (NEW.decision_snapshot->>'mode' = 'automatic' AND NEW.approved_by IS NOT NULL)
          OR (NEW.decision_snapshot->>'mode' = 'human' AND (NEW.approved_by IS NULL OR NOT EXISTS
            (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id
              AND status = 'approved' AND decided_by = NEW.approved_by AND decided_at IS NOT NULL)))
          OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status IN ('pending','escalated','rejected'))
          OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status IN ('running','waiting','failed')))) THEN
      RAISE EXCEPTION 'This reward has no complete pinned approval decision; void the unissued reward and create a new reward before adding it to payroll.';
    END IF;
  END IF;
  IF NEW.status IN ('approved','queued','delivered') AND NEW.program_snapshot->>'approvalMode' = 'none' THEN
    IF NEW.flow_run_id IS NOT NULL OR NEW.decision_snapshot IS NULL
      OR NEW.decision_snapshot->>'mode' IS DISTINCT FROM 'not_required'
      OR NEW.decision_snapshot->>'approvalMode' IS DISTINCT FROM 'none'
      OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved'
      OR NEW.decision_snapshot->>'programId' IS DISTINCT FROM NEW.program_id::text
      OR NEW.decision_snapshot->>'revision' IS DISTINCT FROM NEW.program_snapshot->>'revision'
      OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NULL OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL THEN
      RAISE EXCEPTION 'This Benefits reward has no valid pinned no-approval decision; submit it through its record action before payroll processing.';
    END IF;
  END IF;
  IF NEW.flow_run_id IS NOT NULL AND NEW.status IN ('approved','queued','delivered') AND
    (NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved') THEN
    RAISE EXCEPTION 'This Benefits reward has no completed approval evidence; complete its workflow before payroll processing.';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER hrm_benefit_award_approval_workflow_trigger BEFORE INSERT OR UPDATE ON public.hrm_benefit_awards
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_workflow_guard();

CREATE OR REPLACE FUNCTION public.hrm_benefit_program_active_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('active', 'closed') AND (
    NEW.code IS DISTINCT FROM OLD.code
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.family IS DISTINCT FROM OLD.family
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
    OR NEW.pay_component_id IS DISTINCT FROM OLD.pay_component_id
    OR NEW.approval_mode IS DISTINCT FROM OLD.approval_mode
    OR NEW.delivery_method IS DISTINCT FROM OLD.delivery_method
    OR NEW.valuation IS DISTINCT FROM OLD.valuation
    OR NEW.metric IS DISTINCT FROM OLD.metric
    OR NEW.metric_scope IS DISTINCT FROM OLD.metric_scope
    OR NEW.allocation IS DISTINCT FROM OLD.allocation
    OR NEW.percent_rate IS DISTINCT FROM OLD.percent_rate
    OR NEW.fixed_amount IS DISTINCT FROM OLD.fixed_amount
    OR NEW.cap_amount IS DISTINCT FROM OLD.cap_amount
    OR NEW.budget_amount IS DISTINCT FROM OLD.budget_amount
    OR NEW.threshold_amount IS DISTINCT FROM OLD.threshold_amount
    OR NEW.frequency IS DISTINCT FROM OLD.frequency
    OR NEW.period_basis IS DISTINCT FROM OLD.period_basis
    OR NEW.payment_delay_days IS DISTINCT FROM OLD.payment_delay_days
    OR (NEW.status NOT IN ('active', 'closed'))
  ) THEN
    RAISE EXCEPTION
      'HRM benefit program % is % policy — close it and create a replacement program with a new code instead of editing rules in place.', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$func$;
