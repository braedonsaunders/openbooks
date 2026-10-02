-- Align benefit enrollment release with native Flow continuation and
-- preserve controlled cancellation of future coverage after termination.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.benefit_enrollment_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE run_row public.flow_runs%ROWTYPE; mode text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status NOT IN ('elected','waived') OR NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot IS NOT NULL OR NEW.decision_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Create a benefit election, then submit it through the plan approval setting; active coverage cannot be supplied on creation.' USING ERRCODE='23514';
  END IF;
  IF NEW.replaces_enrollment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hrm_benefit_enrollments e WHERE e.org_id=NEW.org_id AND e.id=NEW.replaces_enrollment_id AND e.employment_id=NEW.employment_id AND e.plan_id=NEW.plan_id AND e.status='active' AND e.effective_from<NEW.effective_from) THEN RAISE EXCEPTION 'A successor must replace active coverage on the same employment and plan from a later date.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='elected' AND NEW.status IN ('pending_approval','active','cancelled') OR
  OLD.status='pending_approval' AND NEW.status IN ('active','cancelled') OR
  OLD.status='active' AND (NEW.status='ended' OR (NEW.status='cancelled'
    AND NOT EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.enrollment_id=OLD.id AND a.status IN ('committed','voided'))
    AND EXISTS(SELECT 1 FROM public.worker_employment_versions v WHERE v.org_id=OLD.org_id AND v.employment_id=OLD.employment_id AND v.recorded_until IS NULL AND v.status='terminated' AND v.effective_from<=OLD.effective_from))) OR OLD.status='waived' AND NEW.status='cancelled') THEN
  RAISE EXCEPTION 'This benefit lifecycle transition is not permitted; use the enrollment record actions or create a successor election.' USING ERRCODE='23514';
 END IF;
 IF (OLD.submission_snapshot IS NOT NULL OR OLD.status IN ('active','ended')) AND
  ROW(NEW.org_id,NEW.employment_id,NEW.plan_id,NEW.currency,NEW.effective_from) IS DISTINCT FROM
  ROW(OLD.org_id,OLD.employment_id,OLD.plan_id,OLD.currency,OLD.effective_from) THEN
  RAISE EXCEPTION 'Submitted coverage identity and start date are immutable; create a successor enrollment.' USING ERRCODE='23514';
 END IF;
 IF OLD.status='ended' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
  RAISE EXCEPTION 'Ended coverage dates are immutable; use a correcting successor election.' USING ERRCODE='23514';
 END IF;
 IF OLD.submission_snapshot IS NULL AND NEW.submission_snapshot IS NOT NULL THEN
  IF OLD.status<>'elected' OR NEW.submission_snapshot IS DISTINCT FROM public.benefit_enrollment_submission_source(OLD.org_id,OLD.id)
   OR NEW.submitted_by IS NULL OR NEW.submitted_by IS DISTINCT FROM NEW.updated_by OR NEW.submitted_at IS NULL THEN
   RAISE EXCEPTION 'Benefit submission must pin the current plan approval setting and exact contribution elections; submit through its record action.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF OLD.submission_snapshot IS NOT NULL AND (NEW.submission_snapshot IS DISTINCT FROM OLD.submission_snapshot OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
  OR NEW.class_key IS DISTINCT FROM OLD.class_key OR NEW.match_eligible IS DISTINCT FROM OLD.match_eligible OR NEW.replaces_enrollment_id IS DISTINCT FROM OLD.replaces_enrollment_id) THEN
  RAISE EXCEPTION 'Submitted benefit evidence is immutable; change the enrollment through its record action.' USING ERRCODE='23514';
 END IF;
 IF OLD.status IN ('active','ended') AND (NEW.class_key IS DISTINCT FROM OLD.class_key OR NEW.match_eligible IS DISTINCT FROM OLD.match_eligible) THEN
  RAISE EXCEPTION 'Active contribution classification is immutable; change the enrollment through its record action.' USING ERRCODE='23514';
 END IF;
 IF OLD.decision_snapshot IS NOT NULL AND NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot THEN RAISE EXCEPTION 'Benefit approval decisions are immutable; create a successor enrollment.' USING ERRCODE='23514'; END IF;
 IF OLD.flow_run_id IS NOT NULL AND NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id THEN RAISE EXCEPTION 'Benefit workflow linkage is immutable; create a successor enrollment.' USING ERRCODE='23514'; END IF;
 IF NEW.status='active' AND OLD.status<>'active' THEN
  IF NEW.submission_snapshot IS NULL OR NEW.decision_snapshot IS NULL OR NEW.decision_snapshot->>'outcome' IS DISTINCT FROM 'approved'
   OR NEW.submitted_by IS NULL OR NEW.submitted_at IS NULL OR NOT EXISTS (SELECT 1 FROM public.hrm_benefit_enrollment_terms t WHERE t.org_id=NEW.org_id AND t.enrollment_id=NEW.id) THEN
   RAISE EXCEPTION 'Coverage requires explicit contribution elections and submission evidence; submit the enrollment through its record action.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.flow_run_id IS NOT NULL THEN
  SELECT * INTO run_row FROM public.flow_runs WHERE org_id=NEW.org_id AND id=NEW.flow_run_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND trigger='on_submit';
  IF NOT FOUND OR run_row.created_by IS DISTINCT FROM NEW.submitted_by OR NEW.submission_snapshot->>'approvalMode' IS DISTINCT FROM 'flows'
   OR run_row.context->>'planId' IS DISTINCT FROM NEW.plan_id::text OR run_row.context->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR run_row.context->'contributions' IS DISTINCT FROM NEW.submission_snapshot->'contributions' THEN
   RAISE EXCEPTION 'Benefit workflow evidence must match the enrollment, organization, submitter and elections; submit through its record action.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='pending_approval' AND OLD.status<>'pending_approval' AND NEW.flow_run_id IS NULL THEN RAISE EXCEPTION 'Submit the enrollment to a configured native Flow before pending approval.' USING ERRCODE='23514'; END IF;
 IF NEW.status='active' AND OLD.status<>'active' THEN
  mode:=NEW.decision_snapshot->>'mode';
  IF mode='not_required' THEN
   IF NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot->>'approvalMode' IS DISTINCT FROM 'none'
    OR NEW.decision_snapshot->>'approvalMode' IS DISTINCT FROM 'none' OR NEW.decision_snapshot->>'planId' IS DISTINCT FROM NEW.plan_id::text THEN
    RAISE EXCEPTION 'No-approval coverage requires the pinned plan setting; submit through its record action.' USING ERRCODE='23514';
   END IF;
  ELSE
   IF NEW.flow_run_id IS NULL OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
    OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND status IN ('pending','escalated','rejected'))
    OR EXISTS (SELECT 1 FROM public.flow_runs WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND (status='failed' OR
      status IN ('running','waiting') AND (mode<>'human' OR current_setting('openbooks.hrm_benefit_release',true) IS DISTINCT FROM NEW.org_id::text || ':' || NEW.id::text || ':' || NEW.updated_by::text))) THEN
    RAISE EXCEPTION 'Benefit approval stages remain incomplete; complete the assigned decisions in Approvals.' USING ERRCODE='23514';
   END IF;
   IF mode='automatic' THEN
    IF run_row.status<>'completed' OR run_row.context->'submissionPolicy'->>'ungatedOutcome' IS DISTINCT FROM 'apply'
     OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id) THEN RAISE EXCEPTION 'Direct coverage needs explicit completed ungated Flow evidence.' USING ERRCODE='23514'; END IF;
   ELSIF mode='human' THEN
    IF current_setting('openbooks.hrm_benefit_release',true) IS DISTINCT FROM NEW.org_id::text || ':' || NEW.id::text || ':' || NEW.updated_by::text THEN
     RAISE EXCEPTION 'Human benefit approval must release through its assigned native Flow decision; use Approvals.' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_benefit_enrollment' AND subject_id=NEW.id AND status='approved' AND decided_by=NEW.updated_by AND decided_at IS NOT NULL) THEN RAISE EXCEPTION 'No native approval decision authorizes this enrollment; decide its assigned gate in Approvals.' USING ERRCODE='23514'; END IF;
   ELSE RAISE EXCEPTION 'Benefit decisions require explicit no-approval, direct Flow processing or native human approval.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $func$;
SELECT public.openbooks_refresh_query_catalog();
