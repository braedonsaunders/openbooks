-- Bind compensation submission to its native routing outcome without requiring a human gate.
-- Existing submitted and approved history keeps its original decision controls.
SET search_path = public, pg_catalog;

ALTER TABLE public.payroll_compensation_versions ADD COLUMN submission_policy jsonb;
ALTER TABLE public.payroll_compensation_versions ADD CONSTRAINT payroll_compensation_versions_submission_policy_shape CHECK (
 submission_policy IS NULL OR (
  jsonb_typeof(submission_policy)='object'
  AND submission_policy - ARRAY['version','kind','submittedRevision']='{}'::jsonb
  AND submission_policy->'version'='1'::jsonb
  AND submission_policy->>'kind' IN ('flow','ungated')
  AND jsonb_typeof(submission_policy->'submittedRevision')='number'
  AND submission_policy->>'submittedRevision' ~ '^[1-9][0-9]{0,9}$'
  AND (submission_policy->>'submittedRevision')::bigint<=revision
  AND status NOT IN ('draft','cancelled')
  AND (submission_policy->>'kind'<>'ungated' OR status IN ('approved','active','ended'))
 ) IS TRUE
);

ALTER TABLE public.payroll_compensation_assignments ADD COLUMN submission_policy jsonb;
ALTER TABLE public.payroll_compensation_assignments ADD CONSTRAINT payroll_compensation_assignments_submission_policy_shape CHECK (
 submission_policy IS NULL OR (
  jsonb_typeof(submission_policy)='object'
  AND submission_policy - ARRAY['version','kind','submittedRevision']='{}'::jsonb
  AND submission_policy->'version'='1'::jsonb
  AND submission_policy->>'kind' IN ('flow','ungated')
  AND jsonb_typeof(submission_policy->'submittedRevision')='number'
  AND submission_policy->>'submittedRevision' ~ '^[1-9][0-9]{0,9}$'
  AND (submission_policy->>'submittedRevision')::bigint<=revision
  AND status NOT IN ('draft','cancelled')
  AND (submission_policy->>'kind'<>'ungated' OR status IN ('approved','active','ended'))
 ) IS TRUE
);

CREATE FUNCTION public.compensation_ungated_submission_authorized(
 organization uuid, subject_kind text, subject_id uuid, package_id uuid, submitted_revision integer, decision_actor uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT subject_kind IN ('compensation_package_version','compensation_package_assignment')
  AND NOT EXISTS (
   SELECT 1 FROM public.flow_runs r
   WHERE r.org_id=organization AND r.subject_kind=compensation_ungated_submission_authorized.subject_kind
    AND r.subject_id=compensation_ungated_submission_authorized.subject_id AND r.trigger='on_submit'
    AND r.context->>'packageId'=package_id::text AND r.context->>'revision'=submitted_revision::text
    AND r.context->>'status'='submitted'
    AND (r.status<>'completed' OR EXISTS (SELECT 1 FROM public.flow_gates g WHERE g.org_id=r.org_id AND g.run_id=r.id))
  ) AND EXISTS (
   SELECT 1 FROM public.flow_runs r
   WHERE r.org_id=organization AND r.subject_kind=compensation_ungated_submission_authorized.subject_kind
    AND r.subject_id=compensation_ungated_submission_authorized.subject_id AND r.trigger='on_submit'
    AND r.context->>'packageId'=package_id::text AND r.context->>'revision'=submitted_revision::text
    AND r.context->>'status'='submitted' AND r.status='completed' AND r.finished_at IS NOT NULL
    AND r.created_by=decision_actor AND r.context->>'submittedBy'=decision_actor::text
    AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
    AND r.context->'submissionPolicy'->>'ungatedOutcome'='apply'
    AND r.context #>> '{submissionPolicy,graph,ungatedOutcome}'='apply'
  );
$function$;

CREATE OR REPLACE FUNCTION public.payroll_compensation_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE approver_party uuid; submitter_party uuid; author_party uuid; subject_party uuid; v_org uuid; self_decision_authorized boolean; approval_subject_kind text; ungated_submission boolean := false;
BEGIN
 IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
  RETURN OLD;
 END IF;
 v_org := CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(v_org) THEN
  UPDATE public.payroll_compensation_configuration SET revision=revision+1 WHERE org_id=v_org;
  RETURN OLD;
 END IF;
 UPDATE public.payroll_compensation_configuration SET revision=revision+1 WHERE org_id=v_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Compensation configuration is missing; complete the database upgrade before saving.'; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 -- Only tenant-reference rebasing is admitted after the controlled bulk copy.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='payroll_compensation_versions' AND public.openbooks_clone_authority()
  AND (to_jsonb(NEW)-ARRAY['definition','definition_hash','authorship'])=(to_jsonb(OLD)-ARRAY['definition','definition_hash','authorship']) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='payroll_compensation_assignments' AND public.openbooks_clone_authority()
  AND (to_jsonb(NEW)-'authorship')=(to_jsonb(OLD)-'authorship') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Compensation configuration preserves approval history; retire the package or cancel an unused draft instead.'; END IF;
 IF TG_OP='INSERT' AND TG_TABLE_NAME<>'payroll_compensation_packages' AND NEW.status<>'draft' THEN
  RAISE EXCEPTION 'Create a compensation draft before submitting it through the tenant approval Flow.';
 END IF;
 IF TG_TABLE_NAME<>'payroll_compensation_packages' THEN
  IF TG_OP='INSERT' AND NEW.submission_policy IS NOT NULL THEN
   RAISE EXCEPTION 'Submission policy is recorded by the native compensation submission command.';
  END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.status='draft' AND NEW.status='submitted' THEN
    IF NEW.submission_policy IS DISTINCT FROM jsonb_build_object('version',1,'kind','flow','submittedRevision',NEW.revision) THEN
     RAISE EXCEPTION 'Compensation submission must bind its routing policy to the submitted revision.';
    END IF;
   ELSIF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
    ungated_submission := OLD.status='submitted'
     AND NEW.status=CASE WHEN TG_TABLE_NAME='payroll_compensation_versions' THEN 'approved' ELSE 'active' END
     AND OLD.submission_policy=jsonb_build_object('version',1,'kind','flow','submittedRevision',OLD.revision)
     AND NEW.submission_policy=jsonb_build_object('version',1,'kind','ungated','submittedRevision',OLD.revision)
     AND NEW.decided_by=OLD.submitted_by AND NEW.updated_by=OLD.submitted_by
     AND public.compensation_ungated_submission_authorized(NEW.org_id,
      CASE WHEN TG_TABLE_NAME='payroll_compensation_versions' THEN 'compensation_package_version' ELSE 'compensation_package_assignment' END,
      NEW.id,NEW.package_id,OLD.revision,NEW.decided_by);
    IF ungated_submission IS NOT TRUE THEN
     RAISE EXCEPTION 'The submitted compensation policy is frozen; complete its native Flow or create a new draft.';
    END IF;
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.org_id,NEW.id,NEW.created_at,NEW.created_by) IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.created_at,OLD.created_by) THEN
   RAISE EXCEPTION 'Compensation record ownership and creation evidence are immutable.';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Compensation revision changed; reload the record before saving.'; END IF;
  IF TG_TABLE_NAME='payroll_compensation_packages' THEN
   IF ROW(NEW.subsidiary_id,NEW.code,NEW.country,NEW.currency) IS DISTINCT FROM ROW(OLD.subsidiary_id,OLD.code,OLD.country,OLD.currency) THEN
    RAISE EXCEPTION 'Package employer, code, country and currency are immutable; create a separate package.';
   END IF;
   IF OLD.status='retired' THEN RAISE EXCEPTION 'A retired compensation package is immutable; create a new package.'; END IF;
  ELSE
   IF NEW.package_id IS DISTINCT FROM OLD.package_id OR (TG_TABLE_NAME='payroll_compensation_versions' AND (to_jsonb(NEW)->'version') IS DISTINCT FROM (to_jsonb(OLD)->'version')) THEN
    RAISE EXCEPTION 'Compensation package ownership and version numbers are immutable; create a new draft.';
   END IF;
   IF OLD.status NOT IN ('draft','submitted') THEN
    IF TG_TABLE_NAME<>'payroll_compensation_assignments' OR OLD.status<>'active' OR NEW.status<>'ended' THEN
     RAISE EXCEPTION 'Approved compensation history is immutable; create an effective-dated successor.';
    END IF;
    IF (to_jsonb(NEW)-ARRAY['status','effective_to','revision','reason','updated_at','updated_by']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','effective_to','revision','reason','updated_at','updated_by'])
       OR NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to>OLD.effective_to) THEN
     RAISE EXCEPTION 'Ending an assignment may only shorten its window; create an approved successor for changed terms.';
    END IF;
    IF EXISTS(SELECT 1 FROM public.payroll_compensation_calculations c JOIN public.pay_runs r ON r.org_id=c.org_id AND r.document_id=c.pay_run_document_id
      WHERE c.org_id=OLD.org_id AND c.assignment_id=OLD.id AND r.run_status IN ('committed','voided') AND r.period_end>NEW.effective_to) THEN
     RAISE EXCEPTION 'The assignment has payroll history after that end date; preserve the paid window and use a controlled payroll correction.';
    END IF;
   ELSIF OLD.status='submitted' THEN
    IF NEW.status NOT IN ('approved','active','rejected') OR
       (TG_TABLE_NAME='payroll_compensation_versions' AND NEW.status='active') OR
       (TG_TABLE_NAME='payroll_compensation_assignments' AND NEW.status='approved') OR
       (to_jsonb(NEW)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']-
        CASE WHEN ungated_submission THEN 'submission_policy' ELSE '__no_policy_change__' END) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']-
        CASE WHEN ungated_submission THEN 'submission_policy' ELSE '__no_policy_change__' END) THEN
     RAISE EXCEPTION 'Submitted compensation terms are frozen; decide this proposal or create a new draft.';
    END IF;
   ELSIF NEW.status NOT IN ('draft','submitted','cancelled') OR (TG_TABLE_NAME='payroll_compensation_versions' AND NEW.status='cancelled') THEN
    RAISE EXCEPTION 'Submit the compensation draft before requesting its tenant Flow approval.';
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='submitted' THEN
  IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'The compensation decision must identify the actor making it.'; END IF;
  SELECT party_id INTO approver_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.decided_by AND is_active;
  SELECT party_id INTO submitter_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.submitted_by;
  SELECT party_id INTO author_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by;
  approval_subject_kind := CASE WHEN TG_TABLE_NAME='payroll_compensation_versions' THEN 'compensation_package_version' ELSE 'compensation_package_assignment' END;
  self_decision_authorized := ungated_submission OR public.compensation_self_decision_authorized(NEW.org_id,approval_subject_kind,NEW.id,NEW.package_id,OLD.revision,
    CASE WHEN NEW.status='rejected' THEN 'rejected' ELSE 'approved' END,NEW.decided_by);
  IF approver_party IS NULL OR submitter_party IS NULL OR author_party IS NULL
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.authorship) a LEFT JOIN public.users u ON u.org_id=NEW.org_id AND u.id=(a->>'actorId')::uuid
    WHERE u.id IS NULL OR u.party_id IS NULL) THEN
   RAISE EXCEPTION 'Compensation decisions require resolved native person identities for the approver, submitter and authors.';
  END IF;
  IF NOT self_decision_authorized AND (NEW.decided_by IN (NEW.submitted_by,NEW.created_by) OR approver_party IS NOT DISTINCT FROM submitter_party OR approver_party IS NOT DISTINCT FROM author_party
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.authorship) a JOIN public.users u ON u.org_id=NEW.org_id AND u.id=(a->>'actorId')::uuid
    WHERE u.id=NEW.decided_by OR u.party_id=approver_party OR (a->>'partyId')::uuid=approver_party)
   OR EXISTS(SELECT 1 FROM public.audit_log a JOIN public.users u ON u.org_id=a.org_id AND u.id=a.actor_id
    WHERE a.org_id=NEW.org_id AND a.table_name=TG_TABLE_NAME AND a.row_id=NEW.id AND
     (u.id=NEW.decided_by OR u.party_id=approver_party OR (a.changes->>'actorPartyId')::uuid=approver_party))) THEN
   RAISE EXCEPTION 'The submitted native compensation Flow must explicitly authorize a self decision; otherwise use an independent approver.';
  END IF;
  IF TG_TABLE_NAME='payroll_compensation_assignments' THEN
   subject_party := NEW.employee_party_id;
   IF approver_party=subject_party AND NOT self_decision_authorized THEN RAISE EXCEPTION 'The submitted native compensation Flow must authorize the affected employee to decide this assignment.'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME<>'payroll_compensation_packages' THEN
  IF TG_OP='INSERT' THEN
   NEW.authorship := jsonb_build_array(jsonb_build_object('actorId',NEW.created_by,'partyId',(SELECT party_id FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by)));
  ELSIF OLD.status='draft' THEN
   NEW.authorship := OLD.authorship;
   -- Submission records the submitting person's identity as well as draft authors.
   IF NEW.status IN ('draft','submitted') THEN
    SELECT jsonb_agg(value ORDER BY value->>'actorId',value->>'partyId') INTO NEW.authorship FROM
     (SELECT DISTINCT value FROM jsonb_array_elements(NEW.authorship || jsonb_build_array(jsonb_build_object('actorId',NEW.updated_by,'partyId',(SELECT party_id FROM public.users WHERE org_id=NEW.org_id AND id=NEW.updated_by))))) authors;
   END IF;
  END IF;
  IF jsonb_array_length(NEW.authorship)>128 THEN RAISE EXCEPTION 'A compensation draft has too many distinct authorship identities; create a new version for the next proposal.'; END IF;
 END IF;
 RETURN NEW;
END $function$;
