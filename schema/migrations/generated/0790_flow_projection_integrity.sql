-- Compare writable approval terms independently of generated projections.
-- Retain requester withdrawals after cancellation of their pending Flow gates.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.native_command_approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE dependencies jsonb; command jsonb; fingerprint text; approval_statuses text[]:=string_to_array(TG_ARGV[1],'|'); subject_kind text:=TG_ARGV[0]; released_fields text[]:=ARRAY['status','updated_at','updated_by','approved_at','approved_by'];
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF (to_jsonb(NEW)->>'status')=ANY(approval_statuses) THEN RAISE EXCEPTION 'Create a native draft before submitting its approval command through Flows.'; END IF;
  RETURN NEW;
 END IF;
 IF NOT coalesce((to_jsonb(NEW)->>'status')=ANY(approval_statuses),false) OR coalesce((to_jsonb(OLD)->>'status')=ANY(approval_statuses),false) THEN RETURN NEW; END IF;
 -- Restoring a settled claim retains its original approval and immutable stamp.
 IF TG_ARGV[0]='rebate_claim' AND to_jsonb(OLD)->>'status'='settled'
  AND to_jsonb(OLD)->>'approved_at' IS NOT NULL AND jsonb_build_array(to_jsonb(NEW)->'approved_at',to_jsonb(NEW)->'approved_by') IS NOT DISTINCT FROM jsonb_build_array(to_jsonb(OLD)->'approved_at',to_jsonb(OLD)->'approved_by') THEN RETURN NEW; END IF;
 IF TG_ARGV[0] IN('customer_change_order','subcontract_change_order') THEN released_fields:=released_fields||ARRAY['approved_on']; END IF;
 IF TG_ARGV[0]='bank_reconciliation_sign_off' THEN released_fields:=released_fields||ARRAY['signed_off_at','signed_off_by']; END IF;
 IF TG_ARGV[0]='headcount_plan_line' THEN released_fields:=released_fields||ARRAY['revision','requisition_id','reason']; END IF;
 IF TG_ARGV[0]='headcount_plan' THEN released_fields:=released_fields||ARRAY['revision']; END IF;
 IF TG_ARGV[0]='compensation_cycle_line' THEN released_fields:=released_fields||ARRAY['revision','approver_party_id','decided_at','reason']; END IF;
 -- Stored generated projections are computed after BEFORE triggers. Their
 -- base columns remain sealed; derived values cannot be supplied by a write.
 SELECT released_fields||coalesce(array_agg(a.attname::text),ARRAY[]::text[])
   INTO released_fields FROM pg_catalog.pg_attribute a
  WHERE a.attrelid=TG_RELID AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated<>'';
 -- Releasing a generated bill or invoice restores the existing approved
 -- economic terms; it neither makes a new decision nor changes its evidence.
 IF subject_kind IN('customer_pay_application','vendor_pay_application')
  AND to_jsonb(NEW)->>'status'='approved'
  AND to_jsonb(OLD)->>'status'=ANY(CASE WHEN subject_kind='customer_pay_application' THEN ARRAY['invoiced','posted'] ELSE ARRAY['billed'] END) THEN
  DECLARE document_column text:=CASE WHEN subject_kind='customer_pay_application' THEN 'invoice_document_id' ELSE 'vendor_bill_document_id' END;
          source_document uuid; original_decider uuid;
  BEGIN
   source_document:=(to_jsonb(OLD)->>document_column)::uuid;
   original_decider:=(to_jsonb(OLD)->>'approved_by')::uuid;
   IF source_document IS NULL OR original_decider IS NULL OR to_jsonb(OLD)->>'approved_at' IS NULL
    OR to_jsonb(NEW)->>document_column IS NOT NULL OR to_jsonb(NEW)->>'updated_by' IS NULL
    OR (to_jsonb(NEW)-ARRAY['status','updated_at','updated_by',document_column])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updated_at','updated_by',document_column]) THEN
    RAISE EXCEPTION 'Releasing billing cannot change approved payment application terms. Review the current application and submit changed terms through Flows.' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.documents d WHERE d.org_id=OLD.org_id AND d.id=source_document
     AND d.kind=CASE WHEN subject_kind='customer_pay_application' THEN 'customer_invoice' ELSE 'vendor_bill' END
     AND ((d.status='draft' AND d.posted_entry_id IS NULL)
       OR (d.status='posted' AND d.void_requested_at IS NOT NULL AND d.void_reason IS NOT NULL
         AND d.void_requested_by::text=to_jsonb(NEW)->>'updated_by'
         AND EXISTS(SELECT 1 FROM public.journal_entries original WHERE original.org_id=d.org_id
           AND original.id=d.posted_entry_id AND original.status='reversed'
           AND EXISTS(SELECT 1 FROM public.journal_entries reversal WHERE reversal.org_id=original.org_id
             AND reversal.reverses_entry_id=original.id AND reversal.status='posted'))))) THEN
    RAISE EXCEPTION 'Discard the draft or complete the native invoice or bill reversal before releasing its payment application.' USING ERRCODE='23514';
   END IF;
   IF subject_kind='customer_pay_application' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM public.pay_application_lines l WHERE l.org_id=OLD.org_id AND l.pay_application_id=OLD.id;
   ELSE
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM public.vendor_pay_application_lines l WHERE l.org_id=OLD.org_id AND l.pay_application_id=OLD.id;
   END IF;
   fingerprint:=public.flow_command_record_fingerprint(to_jsonb(NEW),dependencies);
   IF NOT public.flow_subject_decision_authorized(NEW.org_id,subject_kind,NEW.id,original_decider,fingerprint,'approved') THEN
    RAISE EXCEPTION 'The payment application has no retained approval for these exact terms. Review and resubmit it through Flows.' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
  END;
 END IF;
 IF (to_jsonb(NEW)-released_fields) IS DISTINCT FROM (to_jsonb(OLD)-released_fields) THEN
  RAISE EXCEPTION 'A Flow decision cannot replace the submitted record terms.';
 END IF;
 CASE TG_ARGV[0]
  WHEN 'bank_reconciliation_sign_off' THEN dependencies:=public.reconciliation_approval_dependencies(OLD.org_id,OLD.id);
  WHEN 'customer_change_order' THEN
    SELECT jsonb_build_object('contractValue',(SELECT p.contract_value::text FROM projects p WHERE p.org_id=OLD.org_id AND p.id=OLD.project_id),
      'schedule',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM sov_lines l WHERE l.org_id=OLD.org_id AND l.project_id=OLD.project_id)) INTO dependencies;
    command:=jsonb_build_object('approvedOn',NEW.approved_on::text);
  WHEN 'headcount_plan_line' THEN dependencies:=NULL;
  WHEN 'headcount_plan' THEN SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM hrm_headcount_plan_lines l WHERE l.org_id=OLD.org_id AND l.plan_id=OLD.id;
  WHEN 'compensation_cycle_line' THEN dependencies:=NULL;
  WHEN 'per_diem_entry' THEN dependencies:=NULL;
  WHEN 'travel_pay_entry' THEN dependencies:=NULL;
  WHEN 'sandbox_change_set' THEN SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) INTO dependencies FROM change_set_items i WHERE i.org_id=OLD.org_id AND i.change_set_id=OLD.id;
  WHEN 'rebate_agreement' THEN dependencies:=NULL;
  WHEN 'rebate_claim' THEN SELECT to_jsonb(a) INTO dependencies FROM rebate_agreements a WHERE a.org_id=OLD.org_id AND a.id=OLD.agreement_id;
  WHEN 'subcontract' THEN SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM subcontract_sov_lines l WHERE l.org_id=OLD.org_id AND l.subcontract_id=OLD.id;
  WHEN 'subcontract_change_order' THEN dependencies:=public.subcontract_change_approval_dependencies(OLD.org_id,OLD.subcontract_id);command:=jsonb_build_object('approvedOn',NEW.approved_on::text);
  WHEN 'vendor_pay_application' THEN SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM vendor_pay_application_lines l WHERE l.org_id=OLD.org_id AND l.pay_application_id=OLD.id;
  WHEN 'customer_pay_application' THEN SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) INTO dependencies FROM pay_application_lines l WHERE l.org_id=OLD.org_id AND l.pay_application_id=OLD.id;
  ELSE RAISE EXCEPTION 'This native command has no registered approval evidence contract.';
 END CASE;
 IF subject_kind='rebate_agreement' THEN subject_kind:=OLD.side||'_rebate_agreement';
 ELSIF subject_kind='rebate_claim' THEN subject_kind:=(dependencies->>'side')||'_rebate_claim'; END IF;
 fingerprint:=public.flow_command_record_fingerprint(to_jsonb(OLD),dependencies);
 IF NOT public.flow_command_authorized(NEW.org_id,subject_kind,NEW.id,coalesce(to_jsonb(NEW)->>'approved_by',to_jsonb(NEW)->>'updated_by')::uuid,fingerprint,command) THEN
  RAISE EXCEPTION 'Complete native tenant Flow routing for this exact record and command before release.';
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE equity_action_requests DROP CONSTRAINT equity_action_requests_decision;
ALTER TABLE equity_action_requests ADD CONSTRAINT equity_action_requests_decision CHECK (
 (status='pending_approval' AND decided_by IS NULL AND decided_at IS NULL AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval)
 OR (status='applied' AND applied_at IS NOT NULL AND result IS NOT NULL
   AND ((released_without_approval AND decided_by IS NULL AND decided_at IS NULL)
     OR (NOT released_without_approval AND decided_by IS NOT NULL AND decided_at IS NOT NULL)))
 OR (status='rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
   AND length(btrim(decision_comment)) BETWEEN 1 AND 2000 AND applied_at IS NULL AND NOT released_without_approval)
 OR (status='withdrawn' AND decided_by IS NOT NULL AND decided_by=requested_by AND decided_at IS NOT NULL
   AND decision_comment IS NOT NULL
   AND length(btrim(decision_comment)) BETWEEN 5 AND 2000 AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval));

CREATE OR REPLACE FUNCTION public.equity_action_flow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.status='withdrawn' AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF OLD.status<>'pending_approval' OR NEW.decided_by IS DISTINCT FROM OLD.requested_by
   OR NEW.decided_at IS NULL OR NEW.decision_comment IS NULL OR length(btrim(NEW.decision_comment)) NOT BETWEEN 5 AND 2000
   OR NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=OLD.org_id
      AND s.subject_kind='equity_action' AND s.subject_id=OLD.id AND s.actor_id=OLD.requested_by
      AND s.policy->>'kind'='gated')
   OR NOT EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=OLD.org_id AND r.subject_kind='equity_action'
      AND r.subject_id=OLD.id AND r.status='cancelled' AND r.updated_by=NEW.decided_by
      AND r.context #>> '{submissionPolicy,flowId}'=r.flow_id::text)
   OR EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=OLD.org_id AND r.subject_kind='equity_action'
      AND r.subject_id=OLD.id AND r.status IN('running','waiting'))
   OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=OLD.org_id AND g.subject_kind='equity_action'
      AND g.subject_id=OLD.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Only the requester may withdraw the pending equity action after cancelling its native Flow gates.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.decided_by IS NULL OR NEW.status=OLD.status THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM flow_gates g JOIN flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
   WHERE g.org_id=NEW.org_id AND g.subject_kind='equity_action' AND g.subject_id=NEW.id
     AND g.status=CASE WHEN NEW.status='rejected' THEN 'rejected' ELSE 'approved' END
     AND g.decided_by=NEW.decided_by AND g.decided_at IS NOT NULL
     AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
     AND (NEW.decided_by<>NEW.requested_by OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
       WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
         AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
   OR EXISTS(SELECT 1 FROM flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='equity_action'
     AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
  RAISE EXCEPTION 'Equity decisions require the completed native Flow gates and their retained policy.';
 END IF;
 RETURN NEW;
END $$;


-- Serial adjustments retain exact observations, posting audit and completed tenant Flow review.
CREATE OR REPLACE FUNCTION public.inventory_serial_count_posted_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.serial_id IS NULL OR NEW.adjustment_movement_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.inventory_serial_count_clone_line_matches(NEW) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Copied serial count evidence must retain its exact registered source identity and observations';
 END IF;
 IF TG_OP='UPDATE' AND NEW.adjustment_movement_id IS NOT DISTINCT FROM OLD.adjustment_movement_id THEN RETURN NEW; END IF;
 IF NOT public.inventory_serial_count_line_matches(NEW.org_id,NEW.id,NEW.adjustment_movement_id,true)
    OR NOT EXISTS(
     SELECT 1 FROM public.stock_count_lines line
     JOIN public.stock_counts count ON count.org_id=line.org_id AND count.id=line.stock_count_id
     JOIN public.inventory_movements movement ON movement.org_id=line.org_id AND movement.id=line.adjustment_movement_id
     JOIN public.audit_log audit ON audit.org_id=count.org_id AND audit.table_name='stock_counts' AND audit.row_id=count.id
     WHERE line.org_id=NEW.org_id AND line.id=NEW.id AND movement.id=NEW.adjustment_movement_id
      AND movement.xmin=(pg_current_xact_id()::text::bigint % 4294967296)::text::xid
      AND audit.xmin=movement.xmin AND audit.changes->>'operation'='post'
      AND audit.actor_id=movement.created_by AND audit.changes->'review'->>'postedBy'=audit.actor_id::text
      AND count.updated_by=audit.actor_id AND count.review_released
      AND audit.changes->'review'->'policy'=count.submission_policy
      AND EXISTS(SELECT 1 FROM public.flow_submissions submission
        WHERE submission.org_id=count.org_id AND submission.subject_kind='stock_count'
          AND submission.subject_id=count.id AND submission.policy=count.submission_policy
          AND public.flow_submission_approved(submission.org_id,submission.subject_kind,submission.subject_id,submission.id))
    ) THEN
  RAISE EXCEPTION 'Serial count adjustment requires exact posted count, journal and tenant Flow review evidence';
 END IF;
 RETURN NEW;
END $$;
