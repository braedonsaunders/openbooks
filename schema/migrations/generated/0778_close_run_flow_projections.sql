-- Bind close-run decisions to their ledger, scope and retained manual evidence.
-- Approval tasks project the parent run's canonical Flow decision.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.close_run_approval_fingerprint(organization uuid,subject uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('id',r.id,'orgId',r.org_id,'periodId',r.period_id,
   'bookId',r.book_id,'blueprintId',r.blueprint_id,'scope',r.scope,'startedBy',r.started_by,'ledger',r.data_fingerprint,
   'tasks',coalesce((SELECT jsonb_agg(jsonb_build_object('task',to_jsonb(t)-ARRAY['updated_at','updated_by'],
      'evidence',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.close_task_evidence e
        WHERE e.org_id=t.org_id AND e.task_id=t.id),'[]'::jsonb)) ORDER BY t.id)
     FROM public.close_run_tasks t WHERE t.org_id=r.org_id AND t.run_id=r.id
       AND t.completion_mode='manual' AND t.task_type<>'approval'),'[]'::jsonb))::text,'UTF8')),'hex')
 FROM public.close_runs r WHERE r.org_id=organization AND r.id=subject AND r.data_fingerprint IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION public.close_task_flow_guard() RETURNS trigger
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
 IF OLD.task_type='approval' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN('complete','changes_requested') THEN
  SELECT * INTO receipt FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind='close_run'
    AND s.subject_id=NEW.run_id ORDER BY s.created_at DESC,s.id DESC LIMIT 1;
  IF NOT public.flow_subject_decision_authorized(NEW.org_id,'close_run',NEW.run_id,NEW.updated_by,
      public.close_run_approval_fingerprint(NEW.org_id,NEW.run_id),CASE WHEN NEW.status='complete' THEN 'approved' ELSE 'rejected' END)
    OR NOT EXISTS(SELECT 1 FROM public.close_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.run_id
      AND r.data_fingerprint=NEW.data_fingerprint AND r.status=CASE WHEN NEW.status='complete' THEN 'approved' ELSE 'in_progress' END)
    OR NEW.status='complete' AND (NEW.completed_at IS NULL OR NEW.completed_by IS DISTINCT FROM NEW.updated_by)
    OR receipt.policy->>'kind'='ungated' AND (NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL)
    OR receipt.policy->>'kind'='gated' AND (NEW.reviewed_by IS DISTINCT FROM NEW.updated_by OR NEW.reviewed_at IS NULL) THEN
   RAISE EXCEPTION 'Approval tasks retain the parent close run decision, current evidence and actual Flow reviewer.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
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
