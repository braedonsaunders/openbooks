-- Admit canonical ungated employment submissions and atomic final reward decisions.
-- Remove retired close reviewer settings from editable configuration with audit evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_workflow_guard() RETURNS trigger
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
)
      OR NEW.program_snapshot->>'id' IS DISTINCT FROM NEW.program_id::text THEN
      RAISE EXCEPTION 'The reward must snapshot its program and tenant Flow policy; create it through the Benefits record action.';
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
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'Workflow submission requires the pinned tenant Flow policy and a submitted reward; submit through its record action.';
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
    NEW.flow_run_id IS NULL THEN
    RAISE EXCEPTION 'A pending reward must retain its native Flow gate run; submit it through its record action.';
  END IF;
  IF OLD.status='draft' AND NEW.status='approved' THEN
    IF NEW.decision_snapshot->>'mode' IS DISTINCT FROM 'ungated' OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NULL OR NEW.submitted_by IS DISTINCT FROM NEW.updated_by
      OR NOT public.flow_ungated_submission_authorized(NEW.org_id,'hrm_benefit_award',NEW.id,NEW.submitted_by,
        jsonb_build_object('programId',NEW.program_id::text,'employmentId',NEW.employment_id::text,
          'value',NEW.value::text,'currency',NEW.currency)) THEN
      RAISE EXCEPTION 'Reward release requires its complete ungated Flow submission receipt.';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
      IF NEW.flow_run_id IS NULL OR NEW.decision_snapshot IS NULL
        OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
        OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM NEW.status THEN
        RAISE EXCEPTION 'Benefits approval requires immutable matching workflow decision evidence; complete the assigned decisions in Approvals.';
      END IF;
      IF EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status IN ('pending','escalated'))
        OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id AND status = 'failed') THEN
        RAISE EXCEPTION 'Benefits approval stages are incomplete or failed; resolve the workflow before adding this reward to payroll.';
      END IF;
      IF NEW.decision_snapshot->>'mode' = 'ungated' THEN
        IF NEW.status<>'approved' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NULL
          OR NEW.submitted_by IS DISTINCT FROM NEW.updated_by
          OR NOT public.flow_ungated_submission_authorized(NEW.org_id,'hrm_benefit_award',NEW.id,NEW.submitted_by,
            jsonb_build_object('programId',NEW.program_id::text,'employmentId',NEW.employment_id::text,
              'value',NEW.value::text,'currency',NEW.currency)) THEN
          RAISE EXCEPTION 'Reward release requires its complete ungated Flow receipt.' USING ERRCODE='23514';
        END IF;
      ELSIF NEW.decision_snapshot->>'mode' = 'human' THEN
        IF NOT public.benefit_flow_decision_authorized(NEW.org_id,'hrm_benefit_award',NEW.id,NEW.flow_run_id,NEW.updated_by,NEW.status) THEN
          RAISE EXCEPTION 'Complete every current reward Flow gate through its assigned decision.' USING ERRCODE='23514';
        END IF;
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
        RAISE EXCEPTION 'Reward release requires a canonical ungated receipt or completed native Flow gates.';
      END IF;
  END IF;
  IF NEW.status IN('approved','queued','delivered') AND OLD.status<>'draft' THEN
    IF NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'Rewards need their retained Flow release before payroll processing.';
    END IF;
    IF NEW.decision_snapshot->>'mode'='ungated' AND NOT public.flow_ungated_submission_authorized(
      NEW.org_id,'hrm_benefit_award',NEW.id,NEW.submitted_by,jsonb_build_object(
        'programId',NEW.program_id::text,'employmentId',NEW.employment_id::text,'value',NEW.value::text,'currency',NEW.currency)) THEN
      RAISE EXCEPTION 'The reward has no matching ungated Flow receipt.';
    END IF;
    IF NEW.flow_run_id IS NOT NULL AND (
      NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
      OR EXISTS(SELECT 1 FROM flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_award'
        AND subject_id=NEW.id AND status IN('pending','escalated','rejected'))
      OR EXISTS(SELECT 1 FROM flow_runs WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_award'
        AND subject_id=NEW.id AND (status IN('failed','running')
          OR status='waiting' AND NOT(OLD.status='pending' AND NEW.status='approved')))) THEN
      RAISE EXCEPTION 'Complete the reward approval Flow before payroll processing.';
    END IF;
  END IF;
  IF NEW.flow_run_id IS NOT NULL AND NEW.status IN ('approved','queued','delivered') AND
    (NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved') THEN
    RAISE EXCEPTION 'This Benefits reward has no completed approval evidence; complete its workflow before payroll processing.';
  END IF;
  RETURN NEW;
END;
$function$;

-- Frozen historical decisions remain unchanged. Current writes must use the
-- canonical submission shape; the workflow trigger verifies the actual receipt.
ALTER TABLE public.hrm_employment_change_requests
 DROP CONSTRAINT hrm_employment_change_requests_flow_run_iff_submitted;
ALTER TABLE public.hrm_employment_change_requests
 ADD CONSTRAINT hrm_employment_change_requests_flow_run_iff_submitted CHECK (
  (submitted_at IS NULL) = (flow_run_id IS NULL)
  OR (submitted_at IS NOT NULL AND flow_run_id IS NULL
   AND decision_snapshot->>'mode'='automatic'
   AND decision_snapshot #>> '{policy,kind}'='ungated') IS TRUE
 ) NOT VALID;
ALTER TABLE public.hrm_employment_change_requests
 DROP CONSTRAINT hrm_employment_change_requests_run_presence;
ALTER TABLE public.hrm_employment_change_requests
 ADD CONSTRAINT hrm_employment_change_requests_run_presence CHECK (
  status NOT IN('pending_approval','approved','rejected','applied') OR flow_run_id IS NOT NULL
  OR (decision_snapshot->>'mode'='automatic'
   AND decision_snapshot #>> '{policy,kind}'='ungated') IS TRUE
 ) NOT VALID;

WITH previous AS MATERIALIZED (
 SELECT * FROM public.close_automation_rules
 WHERE config ?| ARRAY['reviewerUserId','reviewerRoleKey'] FOR UPDATE
), changed AS (
 UPDATE public.close_automation_rules r SET config=r.config-ARRAY['reviewerUserId','reviewerRoleKey'],updated_at=now(),updated_by=NULL
 FROM previous p WHERE r.org_id=p.org_id AND r.id=p.id RETURNING r.*
)
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 SELECT c.org_id,'close_automation_rules',c.id,'update',jsonb_build_object(
  'before',to_jsonb(p),'after',to_jsonb(c),'reason','Close task approvers are configured exclusively in Flows.'),NULL
 FROM changed c JOIN previous p ON p.org_id=c.org_id AND p.id=c.id;

WITH previous AS MATERIALIZED (
 SELECT * FROM public.close_policies WHERE policy_type IN('review','segregation') AND is_active FOR UPDATE
), changed AS (
 UPDATE public.close_policies r SET is_active=false,updated_at=now(),updated_by=NULL
 FROM previous p WHERE r.org_id=p.org_id AND r.id=p.id RETURNING r.*
)
INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 SELECT c.org_id,'close_policies',c.id,'update',jsonb_build_object(
  'before',to_jsonb(p),'after',to_jsonb(c),'reason','Approval and separation policies are configured exclusively in Flows.'),NULL
 FROM changed c JOIN previous p ON p.org_id=c.org_id AND p.id=c.id;
