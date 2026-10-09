-- Accounting-event decisions follow the retained native gate policy.
-- Independent review remains the default; explicit self-approval supports
-- sole operators without weakening actor authority or immutable evidence.
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.financial_change_self_decision_authorized(
  organization uuid, change_id uuid, decision_actor uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT decision_actor IS NOT NULL
  AND EXISTS (
   SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r
    ON r.org_id=g.org_id AND r.id=g.run_id AND r.flow_id=g.flow_id
   WHERE g.org_id=organization AND g.subject_kind='financial_change' AND g.subject_id=change_id
     AND r.subject_kind=g.subject_kind AND r.subject_id=g.subject_id
     AND g.decided_by=decision_actor AND g.status IN('approved','rejected') AND g.decided_at IS NOT NULL
     AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
       WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
         AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)
  )
  AND NOT EXISTS (
   SELECT 1 FROM public.flow_gates g LEFT JOIN public.flow_runs r
    ON r.org_id=g.org_id AND r.id=g.run_id AND r.flow_id=g.flow_id
   WHERE g.org_id=organization AND g.subject_kind='financial_change' AND g.subject_id=change_id
     AND g.decided_by=decision_actor AND g.status IN('approved','rejected')
     AND (r.id IS NULL OR r.subject_kind IS DISTINCT FROM g.subject_kind
       OR r.subject_id IS DISTINCT FROM g.subject_id OR g.decided_at IS NULL
       OR r.context->'submissionPolicy'->>'flowId' IS DISTINCT FROM r.flow_id::text
       OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
         WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
           AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb))
  );
$function$;

-- Cross-table decision evidence belongs in a trigger, not a CHECK, so
-- normal backup restoration does not depend on table load ordering.
ALTER TABLE public.financial_changes DROP CONSTRAINT financial_changes_check;
CREATE OR REPLACE FUNCTION public.financial_change_self_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.approved_by=NEW.submitted_by AND NOT public.financial_change_self_decision_authorized(NEW.org_id,NEW.id,NEW.approved_by) THEN
  RAISE EXCEPTION 'The retained accounting-event approval policy must explicitly permit a native self decision.';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER financial_change_self_decision_guard BEFORE INSERT OR UPDATE ON public.financial_changes
 FOR EACH ROW EXECUTE FUNCTION public.financial_change_self_decision_guard();

CREATE OR REPLACE FUNCTION public.payroll_holiday_obligation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
DECLARE proposal public.financial_changes%ROWTYPE; obligation public.payroll_holiday_obligations%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' AND public.holiday_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN
  IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Approved holiday entitlement evidence is immutable; preserve it and use a governed correction.';
 END IF;
 IF TG_TABLE_NAME='payroll_holiday_occurrences' THEN
  SELECT * INTO STRICT obligation FROM public.payroll_holiday_obligations WHERE org_id=NEW.org_id AND id=NEW.obligation_id FOR SHARE;
  IF NOT coalesce(obligation.evidence->'instruction'->'holidayDates' ? NEW.holiday_date::text,false) THEN
   RAISE EXCEPTION 'A holiday occurrence must be named in its approved entitlement.';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id FOR SHARE;
 IF proposal.domain<>'payroll' OR proposal.operation<>'adjudicated_holiday_hours'
   OR proposal.status<>'approved' OR proposal.approved_by IS NULL
   OR (proposal.approved_by=proposal.submitted_by AND NOT public.financial_change_self_decision_authorized(proposal.org_id,proposal.id,proposal.approved_by))
   OR proposal.subject_id IS DISTINCT FROM NEW.employee_party_id
   OR proposal.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
   OR proposal.effective_on IS DISTINCT FROM NEW.payment_date
   OR proposal.payload->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
   OR proposal.payload->'evidence' IS DISTINCT FROM NEW.evidence
   OR proposal.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text) THEN
  RAISE EXCEPTION 'Unpaid holiday pay requires a policy-authorized proposal for this employee, employment, employer, payment date and exact source evidence.';
 END IF;
 IF NEW.evidence->'instruction'->>'employeePartyId' IS DISTINCT FROM NEW.employee_party_id::text
   OR NEW.evidence->'instruction'->>'paymentDate' IS DISTINCT FROM NEW.payment_date::text
   OR NEW.evidence->'source'->>'fileId' IS DISTINCT FROM NEW.source_file_id::text
   OR NEW.evidence->'source'->>'versionId' IS DISTINCT FROM NEW.source_version_id::text
   OR jsonb_typeof(NEW.evidence->'instruction'->'holidayDates') IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
       AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id)
   OR NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
       WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id
         AND lower(v.content_hash)=NEW.evidence->'source'->>'contentHash'
         AND lower(v.content_hash)=NEW.evidence->'instruction'->>'sourceDigest'
         AND v.version_number::text=NEW.evidence->'source'->>'versionNumber') THEN
  RAISE EXCEPTION 'The holiday entitlement must retain its exact tenant-owned employee and File Cabinet source version.';
 END IF;
 RETURN NEW;
END $function$;


CREATE FUNCTION public.financial_change_clone_context(value jsonb, seed uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $function$
DECLARE result jsonb:=value; identity_key text;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 FOREACH identity_key IN ARRAY ARRAY['id','subsidiaryId'] LOOP
  IF jsonb_typeof(result->identity_key)='string' THEN
   result:=jsonb_set(result,ARRAY[identity_key],to_jsonb(public.ob_rebase((result->>identity_key)::uuid,seed)::text));
  END IF;
 END LOOP;
 IF jsonb_typeof(result #> '{submissionPolicy,flowId}')='string' THEN
  result:=jsonb_set(result,'{submissionPolicy,flowId}',to_jsonb(public.ob_rebase((result #>> '{submissionPolicy,flowId}')::uuid,seed)::text));
 END IF;
 RETURN result;
END $function$;
