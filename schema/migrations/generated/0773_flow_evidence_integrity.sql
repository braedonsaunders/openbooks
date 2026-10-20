-- Retain immutable submitted Flow policies and require canonical receipts for new releases.
-- Existing financial and approval history is preserved without backfill.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.flow_run_policy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF ROW(NEW.id,NEW.org_id,NEW.flow_id,NEW.subject_kind,NEW.subject_id,NEW.trigger,
    NEW.created_by,NEW.created_at,NEW.started_at,NEW.occurrence_key)
   IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.flow_id,OLD.subject_kind,OLD.subject_id,OLD.trigger,
    OLD.created_by,OLD.created_at,OLD.started_at,OLD.occurrence_key)
   OR (NEW.context-ARRAY['approvalContinuation','submissionRouting','event_source'])
     IS DISTINCT FROM (OLD.context-ARRAY['approvalContinuation','submissionRouting','event_source']) THEN
  RAISE EXCEPTION 'The submitted Flow identity, policy and record facts are immutable. Withdraw and resubmit the record to change them.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER flow_run_policy_immutable BEFORE UPDATE ON public.flow_runs
 FOR EACH ROW EXECUTE FUNCTION public.flow_run_policy_immutable();

CREATE OR REPLACE FUNCTION public.flow_gate_escalation_lineage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.id,NEW.org_id,NEW.flow_id,NEW.run_id,NEW.node_id,NEW.subject_kind,NEW.subject_id,
      NEW.group_key,NEW.quorum,NEW.signature_required,NEW.created_by,NEW.created_at,NEW.escalated_from_gate_id)
     IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.flow_id,OLD.run_id,OLD.node_id,OLD.subject_kind,OLD.subject_id,
      OLD.group_key,OLD.quorum,OLD.signature_required,OLD.created_by,OLD.created_at,OLD.escalated_from_gate_id) THEN
   RAISE EXCEPTION 'A gate retains its submitted policy, subject and escalation lineage.' USING ERRCODE='23514';
  END IF;
  IF OLD.decided_at IS NOT NULL AND ROW(NEW.status,NEW.decided_by,NEW.decided_at,NEW.signature,NEW.comment,NEW.on_behalf_of_user_id)
     IS DISTINCT FROM ROW(OLD.status,OLD.decided_by,OLD.decided_at,OLD.signature,OLD.comment,OLD.on_behalf_of_user_id) THEN
   RAISE EXCEPTION 'A recorded gate decision is immutable.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.flow_runs r,
    LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.context #> '{submissionPolicy,graph,nodes}')='array'
      THEN r.context #> '{submissionPolicy,graph,nodes}' ELSE '[]'::jsonb END) node
   WHERE r.org_id=NEW.org_id AND r.id=NEW.run_id AND r.flow_id=NEW.flow_id
    AND r.subject_kind=NEW.subject_kind AND r.subject_id=NEW.subject_id
    AND r.context #>> '{submissionPolicy,flowId}'=r.flow_id::text
    AND node->>'id'=NEW.node_id AND node->'data'->>'kind'='gate'
    AND node #>> '{data,gate,mode}'=NEW.quorum
    AND coalesce((node #>> '{data,gate,signatureRequired}')::boolean,false)=NEW.signature_required
    AND NEW.group_key=NEW.run_id::text || ':' || NEW.node_id) THEN
  RAISE EXCEPTION 'The approval gate must match its frozen Flow policy and subject.' USING ERRCODE='23514';
 END IF;
 IF NEW.escalated_from_gate_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.flow_gates parent WHERE parent.org_id=NEW.org_id AND parent.id=NEW.escalated_from_gate_id
     AND parent.run_id=NEW.run_id AND parent.flow_id=NEW.flow_id AND parent.node_id=NEW.node_id
     AND parent.group_key=NEW.group_key AND parent.quorum=NEW.quorum AND parent.status='escalated') THEN
  RAISE EXCEPTION 'An escalation replacement must retain its native gate group and replaced decision.';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.flow_submission_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Flow submission evidence is immutable.';
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Flow submission evidence is immutable.'; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF (NEW.actor_id IS NULL AND NEW.context->>'event_source' IS DISTINCT FROM 'schedule')
   OR (NEW.actor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.users u
     WHERE u.id=NEW.actor_id AND u.is_active AND (u.org_id=NEW.org_id OR u.is_super_admin
       OR EXISTS(SELECT 1 FROM public.role_assignments a JOIN public.app_roles role
         ON role.org_id=a.org_id AND role.id=a.role_id WHERE a.org_id=NEW.org_id AND a.user_id=u.id))))
   OR NOT public.flow_submission_policy_valid(NEW.org_id,NEW.subject_kind,NEW.subject_id,NEW.actor_id,NEW.policy)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.policy->'runIds') claimed(id)
     WHERE NOT EXISTS(SELECT 1 FROM public.flow_runs r,
       LATERAL jsonb_array_elements(NEW.graphs) snapshot
       WHERE r.org_id=NEW.org_id AND r.id::text=claimed.id
        AND r.context #>> '{submissionPolicy,flowId}'=r.flow_id::text
        AND snapshot->>'id'=r.flow_id::text
        AND snapshot->'graph'=r.context #> '{submissionPolicy,graph}'))
   OR NEW.graphs IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'graph',f.graph) ORDER BY f.id),'[]'::jsonb)
     FROM public.flows f WHERE f.org_id=NEW.org_id AND f.subject_kind=NEW.subject_kind AND f.enabled) THEN
  RAISE EXCEPTION 'The Flow submission requires complete routing evidence and the current graph snapshots.';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.flow_submission_runs_valid(organization uuid,kind text,subject uuid,submission uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization
  AND s.subject_kind=kind AND s.subject_id=subject AND s.id=submission
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.policy->'runIds') claimed(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.flow_runs r,
      LATERAL jsonb_array_elements(s.graphs) snapshot
      WHERE r.org_id=s.org_id AND r.id::text=claimed.id AND r.subject_kind=s.subject_kind
       AND r.subject_id=s.subject_id AND r.trigger=s.policy->>'trigger'
       AND r.created_by IS NOT DISTINCT FROM s.actor_id
       AND s.policy->'flowIds' ? r.flow_id::text
       AND r.context #>> '{submissionPolicy,flowId}'=r.flow_id::text
       AND snapshot->>'id'=r.flow_id::text
       AND snapshot->'graph'=r.context #> '{submissionPolicy,graph}')))
$$;

CREATE OR REPLACE FUNCTION public.flow_ungated_submission_authorized(organization uuid,kind text,subject uuid,actor uuid,expected_context jsonb DEFAULT '{}'::jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind
   AND s.subject_id=subject AND s.actor_id IS NOT DISTINCT FROM actor AND s.policy->>'kind'='ungated' AND s.context @> expected_context
   AND public.flow_submission_runs_valid(s.org_id,s.subject_kind,s.subject_id,s.id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.policy->'runIds') run_id WHERE NOT EXISTS(
     SELECT 1 FROM public.flow_runs r WHERE r.org_id=s.org_id AND r.id::text=run_id
       AND r.subject_kind=s.subject_kind AND r.subject_id=s.subject_id AND r.status='completed' AND r.error IS NULL))
   AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text)
   AND NOT EXISTS(SELECT 1 FROM public.flow_submissions later WHERE later.org_id=s.org_id AND later.subject_kind=s.subject_kind
     AND later.subject_id=s.subject_id AND (later.created_at,later.id)>(s.created_at,s.id))
   AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind
     AND g.subject_id=s.subject_id AND g.status IN('pending','escalated')));
$$;

CREATE OR REPLACE FUNCTION public.flow_submission_approved(organization uuid,kind text,subject uuid,submission uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind
  AND s.subject_id=subject AND s.id=submission AND s.policy->>'kind'='gated'
  AND public.flow_submission_runs_valid(s.org_id,s.subject_kind,s.subject_id,s.id)
  AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
    AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.policy->'runIds') run_ref(value) WHERE NOT EXISTS(
    SELECT 1 FROM public.flow_runs r WHERE r.org_id=s.org_id AND r.id::text=run_ref.value AND r.subject_kind=s.subject_kind
      AND r.subject_id=s.subject_id AND r.status IN('waiting','completed') AND r.error IS NULL))
  AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text
    AND g.status IN('pending','escalated','rejected'))
  AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text
    GROUP BY g.run_id,g.group_key HAVING CASE
      WHEN bool_and(g.quorum='all') THEN NOT bool_and(g.status='approved'
        OR (g.status='cancelled' AND EXISTS(SELECT 1 FROM public.flow_gates replacement
          WHERE replacement.org_id=g.org_id AND replacement.escalated_from_gate_id=g.id
            AND replacement.run_id=g.run_id AND replacement.group_key=g.group_key AND replacement.status='approved')))
      WHEN bool_and(g.quorum='any') THEN NOT bool_or(g.status='approved') ELSE true END)
  AND EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text AND g.status='approved'))
$$;

CREATE OR REPLACE FUNCTION public.compensation_ungated_submission_authorized(
 organization uuid, subject_kind text, subject_id uuid, package_id uuid, submitted_revision integer, decision_actor uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT subject_kind IN ('compensation_package_version','compensation_package_assignment')
  AND public.flow_ungated_submission_authorized(organization,subject_kind,subject_id,decision_actor,
    jsonb_build_object('packageId',package_id::text,'revision',submitted_revision,'status','submitted','submittedBy',decision_actor::text));
$function$;

CREATE FUNCTION public.benefit_flow_decision_authorized(
 organization uuid,kind text,subject uuid,linked_run uuid,actor uuid,outcome text
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind
  AND s.subject_id=subject AND s.policy->>'kind'='gated' AND s.policy->'runIds' ? linked_run::text
  AND public.flow_submission_runs_valid(s.org_id,s.subject_kind,s.subject_id,s.id)
  AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id
    AND newer.subject_kind=s.subject_kind AND newer.subject_id=s.subject_id
    AND (newer.created_at,newer.id)>(s.created_at,s.id))
  AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id
    AND g.subject_kind=s.subject_kind AND g.subject_id=s.subject_id AND g.status IN('pending','escalated'))
  AND (outcome='rejected' OR outcome='approved' AND public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id))
  AND EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind AND g.subject_id=s.subject_id
      AND s.policy->'runIds' ? r.id::text AND r.status IN('waiting','completed') AND r.error IS NULL
      AND g.status=outcome AND g.decided_by=actor AND g.decided_at IS NOT NULL
      AND (actor<>s.actor_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.context #> '{submissionPolicy,graph,nodes}') node
        WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
          AND node #> '{data,gate,preventSelfApproval}'='false'::jsonb))))
$$;

CREATE OR REPLACE FUNCTION public.benefit_enrollment_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE run_row public.flow_runs%ROWTYPE; mode text; unused_withdrawal boolean := false;
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.benefit_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('elected','waived') OR NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot IS NOT NULL OR NEW.decision_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Create a benefit election, then submit it through tenant Flows; active coverage cannot be supplied on creation.' USING ERRCODE='23514';
  END IF;
  IF NEW.replaces_enrollment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.hrm_benefit_enrollments e WHERE e.org_id=NEW.org_id AND e.id=NEW.replaces_enrollment_id AND e.employment_id=NEW.employment_id AND e.plan_id=NEW.plan_id AND e.status='active' AND e.effective_from<NEW.effective_from) THEN RAISE EXCEPTION 'A successor must replace active coverage on the same employment and plan from a later date.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status IN ('active','ended') AND NEW.status='cancelled' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:benefit-recurring:' || NEW.org_id::text,0));
  unused_withdrawal := coalesce(current_setting('openbooks.hrm_benefit_withdrawal',true)=NEW.org_id::text || ':' || NEW.id::text || ':' || NEW.updated_by::text,false)
    AND nullif(btrim(NEW.ended_reason),'') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.enrollment_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM public.hrm_benefit_payroll_inputs i WHERE i.org_id=OLD.org_id AND i.enrollment_id=OLD.id)
    AND NOT EXISTS(SELECT 1 FROM public.hrm_benefit_enrollments e WHERE e.org_id=OLD.org_id AND e.replaces_enrollment_id=OLD.id AND e.status IN ('elected','pending_approval'));
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='elected' AND NEW.status IN ('pending_approval','active','cancelled') OR
  OLD.status='pending_approval' AND NEW.status IN ('active','cancelled') OR
  OLD.status='active' AND (NEW.status='ended' OR (NEW.status='cancelled'
    AND NOT EXISTS(SELECT 1 FROM public.pay_run_benefit_allocations a WHERE a.org_id=OLD.org_id AND a.enrollment_id=OLD.id AND a.status IN ('committed','voided'))
    AND NOT EXISTS(SELECT 1 FROM public.hrm_benefit_payroll_inputs i WHERE i.org_id=OLD.org_id AND i.enrollment_id=OLD.id)
    AND EXISTS(SELECT 1 FROM public.worker_employment_versions v WHERE v.org_id=OLD.org_id AND v.employment_id=OLD.employment_id AND v.recorded_until IS NULL AND v.status='terminated' AND v.effective_from<=OLD.effective_from)) OR (NEW.status='cancelled' AND unused_withdrawal)) OR (OLD.status='ended' AND NEW.status='cancelled' AND unused_withdrawal) OR OLD.status='waived' AND NEW.status='cancelled') THEN
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
   RAISE EXCEPTION 'Benefit submission must pin the exact contribution elections and tenant Flow policy; submit through its record action.' USING ERRCODE='23514';
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
  IF NOT FOUND OR run_row.created_by IS DISTINCT FROM NEW.submitted_by
   OR run_row.context->>'planId' IS DISTINCT FROM NEW.plan_id::text OR run_row.context->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR run_row.context->'contributions' IS DISTINCT FROM NEW.submission_snapshot->'contributions' THEN
   RAISE EXCEPTION 'Benefit workflow evidence must match the enrollment, organization, submitter and elections; submit through its record action.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='pending_approval' AND OLD.status<>'pending_approval' AND NEW.flow_run_id IS NULL THEN RAISE EXCEPTION 'Submit the enrollment to a configured native Flow before pending approval.' USING ERRCODE='23514'; END IF;
 IF NEW.status='active' AND OLD.status<>'active' THEN
  mode:=NEW.decision_snapshot->>'mode';
  IF mode='ungated' THEN
   IF NOT public.flow_ungated_submission_authorized(NEW.org_id,'hrm_benefit_enrollment',NEW.id,NEW.submitted_by,NEW.submission_snapshot) THEN
    RAISE EXCEPTION 'Coverage requires its complete ungated Flow submission receipt.' USING ERRCODE='23514';
   END IF;
  ELSIF mode='human' THEN
   IF NEW.flow_run_id IS NULL OR NEW.decision_snapshot->>'runId' IS DISTINCT FROM NEW.flow_run_id::text
    OR current_setting('openbooks.hrm_benefit_release',true) IS DISTINCT FROM NEW.org_id::text || ':' || NEW.id::text || ':' || NEW.updated_by::text
    OR NOT public.benefit_flow_decision_authorized(NEW.org_id,'hrm_benefit_enrollment',NEW.id,NEW.flow_run_id,NEW.updated_by,'approved') THEN
    RAISE EXCEPTION 'Complete every current enrollment Flow gate through its assigned decision before releasing coverage.' USING ERRCODE='23514';
   END IF;
  ELSE
   RAISE EXCEPTION 'Coverage release requires a canonical ungated receipt or completed native Flow gates.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $func$;

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
        AND subject_id=NEW.id AND status IN('failed','running','waiting'))) THEN
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
