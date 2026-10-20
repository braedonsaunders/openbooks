-- Route manual close task releases and calibration publication through tenant Flows.
-- Retain existing completed decisions and financial history without backfill.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.close_task_approval_dependencies(organization uuid,subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('run',jsonb_build_object('id',r.id,'fingerprint',r.data_fingerprint,'status',r.status),
   'evidence',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.close_task_evidence e
     WHERE e.org_id=t.org_id AND e.task_id=t.id),'[]'::jsonb))
 FROM public.close_run_tasks t JOIN public.close_runs r ON r.org_id=t.org_id AND r.id=t.run_id
 WHERE t.org_id=organization AND t.id=subject
$$;
CREATE FUNCTION public.close_task_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE fingerprint text; receipt public.flow_submissions;
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
  IF NEW.completion_mode='manual' AND NEW.status IN('submitted','complete','waived') THEN
   RAISE EXCEPTION 'Create the close task, then submit its current evidence through Flows.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.completion_mode='manual' AND OLD.status IN('complete','waived') AND NEW.status=OLD.status
  AND (to_jsonb(NEW)-ARRAY['updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','updated_by']) THEN
  RAISE EXCEPTION 'Completed close task evidence is immutable; revalidate the close run for changed work.' USING ERRCODE='23514';
 END IF;
 IF NEW.completion_mode='manual' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN('complete','waived','changes_requested') THEN
  fingerprint:=public.flow_command_record_fingerprint(to_jsonb(OLD),public.close_task_approval_dependencies(OLD.org_id,OLD.id));
  IF NEW.status='changes_requested' THEN
   IF NOT public.flow_subject_decision_authorized(NEW.org_id,'close_task',NEW.id,NEW.updated_by,fingerprint,'rejected') THEN
    RAISE EXCEPTION 'Return the close task through its assigned current Flow gate.' USING ERRCODE='23514';
   END IF;
  ELSE
   IF NEW.completed_at IS NULL OR NOT public.flow_command_authorized(NEW.org_id,'close_task',NEW.id,NEW.updated_by,fingerprint,
     jsonb_build_object('action',CASE WHEN NEW.status='waived' THEN 'waive' ELSE 'complete' END)) THEN
    RAISE EXCEPTION 'Submit the close task and complete every configured Flow gate before release.' USING ERRCODE='23514';
   END IF;
   SELECT * INTO receipt FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind='close_task' AND s.subject_id=NEW.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1;
   IF NEW.completed_by IS DISTINCT FROM receipt.actor_id
     OR receipt.policy->>'kind'='ungated' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL)
     OR receipt.policy->>'kind'='gated' AND (NEW.reviewed_by IS DISTINCT FROM NEW.updated_by OR NEW.reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'Retain the close task preparer and actual native Flow decision identity.' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER close_task_flow_guard BEFORE INSERT OR UPDATE ON public.close_run_tasks
 FOR EACH ROW EXECUTE FUNCTION public.close_task_flow_guard();
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON public.close_run_tasks
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('close_task','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON public.close_task_evidence
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('close_task','task_id');

CREATE FUNCTION public.calibration_session_approval_entities(organization uuid,subject uuid) RETURNS text[]
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT array(SELECT DISTINCT entity FROM (
  SELECT c.applies_to->>'employer_subsidiary_id' as entity FROM public.hrm_calibration_sessions s
   JOIN public.hrm_review_cycles c ON c.org_id=s.org_id AND c.id=s.cycle_id WHERE s.org_id=organization AND s.id=subject
  UNION ALL SELECT w.employer_subsidiary_id::text FROM public.hrm_calibration_entries e
   JOIN public.hrm_reviews r ON r.org_id=e.org_id AND r.id=e.review_id
   JOIN public.worker_employments w ON w.org_id=r.org_id AND w.id=r.employment_id WHERE e.org_id=organization AND e.session_id=subject
 ) owners WHERE entity IS NOT NULL ORDER BY entity)
$$;
CREATE FUNCTION public.calibration_session_approval_dependencies(organization uuid,subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('cycle',to_jsonb(c),'entries',coalesce((SELECT jsonb_agg(jsonb_build_object('entry',to_jsonb(e),'review',to_jsonb(r),
   'employment',jsonb_build_object('id',w.id,'employer',w.employer_subsidiary_id)) ORDER BY e.id)
  FROM public.hrm_calibration_entries e JOIN public.hrm_reviews r ON r.org_id=e.org_id AND r.id=e.review_id
  JOIN public.worker_employments w ON w.org_id=r.org_id AND w.id=r.employment_id
  WHERE e.org_id=s.org_id AND e.session_id=s.id),'[]'::jsonb))
 FROM public.hrm_calibration_sessions s JOIN public.hrm_review_cycles c ON c.org_id=s.org_id AND c.id=s.cycle_id
 WHERE s.org_id=organization AND s.id=subject
$$;
CREATE FUNCTION public.calibration_session_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create a draft calibration session before opening and publishing it.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='closed' AND (to_jsonb(NEW)-ARRAY['updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','updated_by']) THEN
  RAISE EXCEPTION 'Published calibration evidence is immutable; create a new session for revised ratings.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='closed' AND OLD.status<>'closed' AND (OLD.status<>'open' OR NEW.closed_at IS NULL
   OR NOT public.flow_command_authorized(NEW.org_id,'hrm_calibration_session',NEW.id,NEW.updated_by,
     public.flow_command_record_fingerprint(to_jsonb(OLD),public.calibration_session_approval_dependencies(OLD.org_id,OLD.id)),
     jsonb_build_object('action','close'))) THEN
  RAISE EXCEPTION 'Submit the current calibration session and complete every configured Flow gate before publishing ratings.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calibration_session_flow_guard BEFORE INSERT OR UPDATE ON public.hrm_calibration_sessions
 FOR EACH ROW EXECUTE FUNCTION public.calibration_session_flow_guard();
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON public.hrm_calibration_sessions
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('hrm_calibration_session','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_calibration_entries
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('hrm_calibration_session','session_id');

CREATE FUNCTION public.calibration_entry_published_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE candidate jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 FOR candidate IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END)) WHERE value<>'null'::jsonb LOOP
  IF EXISTS(SELECT 1 FROM public.hrm_calibration_sessions s WHERE s.org_id=(candidate->>'org_id')::uuid
     AND s.id=(candidate->>'session_id')::uuid AND s.status='closed') THEN
   RAISE EXCEPTION 'Published calibration entries are immutable; create a new session for revised ratings.' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calibration_entry_published_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_calibration_entries
 FOR EACH ROW EXECUTE FUNCTION public.calibration_entry_published_guard();
CREATE FUNCTION public.calibrated_review_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.status='calibrated' AND OLD.status<>'calibrated' AND NOT EXISTS(
   SELECT 1 FROM public.hrm_calibration_entries e JOIN public.hrm_calibration_sessions s ON s.org_id=e.org_id AND s.id=e.session_id
   WHERE e.org_id=NEW.org_id AND e.review_id=NEW.id AND s.status='closed' AND s.updated_by=NEW.updated_by
    AND e.calibrated_rating=NEW.calibrated_rating AND NEW.calibration_reason IS NOT DISTINCT FROM coalesce(e.justification,'decided in calibration')) THEN
  RAISE EXCEPTION 'Publish calibrated ratings through their session and its tenant Flow policy.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER calibrated_review_flow_guard BEFORE UPDATE ON public.hrm_reviews
 FOR EACH ROW EXECUTE FUNCTION public.calibrated_review_flow_guard();
