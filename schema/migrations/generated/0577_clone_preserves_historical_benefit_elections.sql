-- Preserve approved benefit elections and their immutable source terms when
-- copying a registered sandbox. New elections still require native approval.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Only the declared identity fields change inside pinned approval evidence.
-- Rates, classifications, dates, names and decision outcomes stay unchanged.
CREATE FUNCTION public.benefit_clone_submission_evidence(evidence jsonb, seed uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $function$
DECLARE result jsonb:=evidence; identity_key text; contributions jsonb;
BEGIN
 IF evidence IS NULL THEN RETURN NULL; END IF;
 FOREACH identity_key IN ARRAY ARRAY['id','planId','employmentId','legalEntityId','departmentId','replacesEnrollmentId','createdBy'] LOOP
  IF jsonb_typeof(result->identity_key)='string' THEN
   result:=jsonb_set(result,ARRAY[identity_key],to_jsonb(public.ob_rebase((result->>identity_key)::uuid,seed)::text));
  END IF;
 END LOOP;
 IF jsonb_typeof(result #> '{submissionPolicy,flowId}')='string' THEN
  result:=jsonb_set(result,'{submissionPolicy,flowId}',to_jsonb(public.ob_rebase((result #>> '{submissionPolicy,flowId}')::uuid,seed)::text));
 END IF;
 IF jsonb_typeof(result->'contributions')='array' THEN
  SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(value->'ruleId')='string'
   THEN jsonb_set(value,'{ruleId}',to_jsonb(public.ob_rebase((value->>'ruleId')::uuid,seed)::text))
   ELSE value END ORDER BY ordinal),'[]'::jsonb) INTO contributions
   FROM jsonb_array_elements(result->'contributions') WITH ORDINALITY AS entries(value,ordinal);
  result:=jsonb_set(result,'{contributions}',contributions);
 END IF;
 RETURN result;
END $function$;

CREATE FUNCTION public.benefit_clone_decision_evidence(evidence jsonb, seed uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $function$
DECLARE result jsonb:=evidence; identity_key text; entries_data jsonb;
BEGIN
 IF evidence IS NULL THEN RETURN NULL; END IF;
 FOREACH identity_key IN ARRAY ARRAY['planId','runId'] LOOP
  IF jsonb_typeof(result->identity_key)='string' THEN
   result:=jsonb_set(result,ARRAY[identity_key],to_jsonb(public.ob_rebase((result->>identity_key)::uuid,seed)::text));
  END IF;
 END LOOP;
 IF jsonb_typeof(result->'runs')='array' THEN
  SELECT COALESCE(jsonb_agg(value
   || CASE WHEN jsonb_typeof(value->'id')='string' THEN jsonb_build_object('id',public.ob_rebase((value->>'id')::uuid,seed)) ELSE '{}'::jsonb END
   || CASE WHEN value ? 'context' THEN jsonb_build_object('context',public.benefit_clone_submission_evidence(value->'context',seed)) ELSE '{}'::jsonb END
   ORDER BY ordinal),'[]'::jsonb) INTO entries_data
   FROM jsonb_array_elements(result->'runs') WITH ORDINALITY AS entries(value,ordinal);
  result:=jsonb_set(result,'{runs}',entries_data);
 END IF;
 IF jsonb_typeof(result->'gates')='array' THEN
  SELECT COALESCE(jsonb_agg(value
   || CASE WHEN jsonb_typeof(value->'id')='string' THEN jsonb_build_object('id',public.ob_rebase((value->>'id')::uuid,seed)) ELSE '{}'::jsonb END
   || CASE WHEN jsonb_typeof(value->'decided_by')='string' THEN jsonb_build_object('decided_by',public.ob_rebase((value->>'decided_by')::uuid,seed)) ELSE '{}'::jsonb END
   ORDER BY ordinal),'[]'::jsonb) INTO entries_data
   FROM jsonb_array_elements(result->'gates') WITH ORDINALITY AS entries(value,ordinal);
  result:=jsonb_set(result,'{gates}',entries_data);
 END IF;
 RETURN result;
END $function$;

-- This predicate grants no authority itself. It runs with the caller's role,
-- accepts only three historical Benefits tables and compares every stored
-- column with an actual source row. A forged flag, identity or financial value
-- cannot manufacture historical coverage or an obsolete payroll input.
CREATE FUNCTION public.benefit_historical_clone_matches(relation regclass, candidate jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $function$
DECLARE target record; original jsonb; expected jsonb; column_row record; removed jsonb;
BEGIN
 IF NOT public.openbooks_clone_authority() OR relation NOT IN (
  'public.hrm_benefit_enrollments'::regclass,'public.hrm_benefit_enrollment_terms'::regclass,
  'public.hrm_benefit_payroll_inputs'::regclass) THEN RETURN false; END IF;
 SELECT o.id,o.sandbox_of,o.sandbox_seed,s.masked INTO target FROM public.orgs o
 JOIN public.sandboxes s ON s.org_id=o.id AND s.production_org_id=o.sandbox_of
 JOIN public.orgs source ON source.id=o.sandbox_of
 WHERE o.id=(candidate->>'org_id')::uuid AND o.env_kind='sandbox' AND o.sandbox_seed IS NOT NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 EXECUTE format('SELECT to_jsonb(original) FROM %s original WHERE original.org_id=$1 AND public.ob_rebase(original.id,$2)=$3',relation)
 INTO original USING target.sandbox_of,target.sandbox_seed,(candidate->>'id')::uuid;
 IF original IS NULL THEN RETURN false; END IF;
 expected:=original;
 FOR column_row IN SELECT attname,atttypid,attnotnull FROM pg_catalog.pg_attribute
  WHERE attrelid=relation AND attnum>0 AND NOT attisdropped LOOP
  IF column_row.attname='org_id' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(target.id));
  ELSIF column_row.atttypid='uuid'::regtype AND jsonb_typeof(original->column_row.attname)='string' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],to_jsonb(public.ob_rebase((original->>column_row.attname)::uuid,target.sandbox_seed)));
  ELSIF relation='public.hrm_benefit_enrollments'::regclass AND column_row.attname='submission_snapshot' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],COALESCE(public.benefit_clone_submission_evidence(original->column_row.attname,target.sandbox_seed),'null'::jsonb));
  ELSIF relation='public.hrm_benefit_enrollments'::regclass AND column_row.attname='decision_snapshot' THEN
   expected:=jsonb_set(expected,ARRAY[column_row.attname],COALESCE(public.benefit_clone_decision_evidence(original->column_row.attname,target.sandbox_seed),'null'::jsonb));
  END IF;
  -- Only existing value-removing policies may remove evidence from a masked
  -- copy. Masking never permits changed rates, dates, state or identities.
  IF target.masked AND column_row.attname IN ('submission_snapshot','decision_snapshot','provenance','source_decimal','override_reason')
   AND EXISTS(SELECT 1 FROM public.masking_policies p WHERE p.org_id=target.sandbox_of
    AND p.table_name=CASE relation WHEN 'public.hrm_benefit_enrollments'::regclass THEN 'hrm_benefit_enrollments'
     WHEN 'public.hrm_benefit_enrollment_terms'::regclass THEN 'hrm_benefit_enrollment_terms' ELSE 'hrm_benefit_payroll_inputs' END
    AND p.column_name=column_row.attname AND p.is_active AND p.transform='null_out') THEN
   removed:=CASE WHEN column_row.attname='override_reason' AND original->column_row.attname<>'null'::jsonb THEN to_jsonb('REDACTED'::text)
    WHEN column_row.attnotnull AND column_row.atttypid='jsonb'::regtype THEN '{}'::jsonb ELSE 'null'::jsonb END;
   expected:=jsonb_set(expected,ARRAY[column_row.attname],removed);
  END IF;
 END LOOP;
 RETURN candidate=expected;
END $function$;

CREATE OR REPLACE FUNCTION public.benefit_enrollment_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE run_row public.flow_runs%ROWTYPE; mode text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.benefit_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.benefit_recurring_subject_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE e record; r record;
BEGIN
 IF TG_OP='INSERT' AND public.benefit_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:benefit-recurring:' || NEW.org_id::text,0));
 SELECT * INTO e FROM public.hrm_benefit_enrollments WHERE org_id = NEW.org_id AND id = NEW.enrollment_id;
 SELECT * INTO r FROM public.hrm_benefit_contribution_rules WHERE org_id = NEW.org_id AND id = NEW.rule_id;
 IF e.status <> 'elected' OR e.submission_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Submitted contribution elections are immutable; change the enrollment through its record action.'; END IF;
 IF e.plan_id IS DISTINCT FROM r.plan_id THEN
  RAISE EXCEPTION 'Contribution terms must belong to a rule on the enrollment plan; select a rule from that plan.';
 END IF;
 IF NEW.effective_from < e.effective_from OR (e.effective_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > e.effective_to)) THEN
  RAISE EXCEPTION 'Contribution terms must fit inside enrollment coverage; choose dates within that enrollment.';
 END IF;
 RETURN NEW;
END $func$;

CREATE OR REPLACE FUNCTION public.benefit_monthly_queue_retired() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
BEGIN
 IF public.benefit_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Monthly benefit input generation has been replaced by native pay-run calculation; record enrollment contribution terms and calculate the pay run.';
END $func$;

SELECT public.openbooks_refresh_query_catalog();
