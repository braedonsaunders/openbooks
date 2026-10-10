-- Approval is an optional tenant Flow. A compensation proposal submitted while the organization has no enabled Flow for its subject kind, and with no on_submit run recorded for the submitted revision, is released directly by its submitter; a configured Flow still governs through its completed ungated outcome.
CREATE OR REPLACE FUNCTION public.compensation_ungated_submission_authorized(
 organization uuid, subject_kind text, subject_id uuid, package_id uuid, submitted_revision integer, decision_actor uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT subject_kind IN ('compensation_package_version','compensation_package_assignment')
  AND ((
   NOT EXISTS (
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
   )
  ) OR (
   NOT EXISTS (
    SELECT 1 FROM public.flows f
    WHERE f.org_id=organization AND f.subject_kind=compensation_ungated_submission_authorized.subject_kind AND f.enabled
   ) AND NOT EXISTS (
    SELECT 1 FROM public.flow_runs r
    WHERE r.org_id=organization AND r.subject_kind=compensation_ungated_submission_authorized.subject_kind
     AND r.subject_id=compensation_ungated_submission_authorized.subject_id AND r.trigger='on_submit'
     AND r.context->>'revision'=submitted_revision::text
   )
  ));
$function$;
