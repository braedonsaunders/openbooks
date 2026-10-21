-- Project approved employee bank changes from their exact native Flow receipt.
-- Ordinary party bank records retain their own tenant-authored Flow admission.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.party_bank_accounts ADD COLUMN source_change_request_id uuid
 REFERENCES public.hrm_employment_change_requests(id);
CREATE UNIQUE INDEX bank_accounts_source_change ON public.party_bank_accounts(org_id,source_change_request_id)
 WHERE source_change_request_id IS NOT NULL;
ALTER TABLE public.party_bank_accounts ALTER COLUMN approval_status SET DEFAULT 'pending',
 ALTER COLUMN is_active SET DEFAULT false;

CREATE FUNCTION public.employment_bank_projection_authorized(account public.party_bank_accounts) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.hrm_employment_change_requests r
  JOIN public.worker_employments e ON e.org_id=r.org_id AND e.id=r.employment_id
  JOIN public.flow_submissions s ON s.org_id=r.org_id AND s.subject_kind='hrm_employment_change_request'
   AND s.subject_id=r.id AND s.actor_id=r.submitted_by
  WHERE r.org_id=account.org_id AND r.id=account.source_change_request_id AND r.status='approved'
   AND e.worker_party_id=account.party_id AND r.payload->>'kind'='bank_change'
   AND r.updated_by=account.approved_by AND r.submitted_by=account.submitted_by
   AND r.decision_snapshot->>'outcome'='approved'
   AND s.context->>'requestId'=r.id::text AND s.context->>'payloadDigest'=r.payload_digest
   AND s.context->'payload'=r.payload
   AND r.payload->>'bankName' IS NOT DISTINCT FROM account.bank_name
   AND r.payload->>'country' IS NOT DISTINCT FROM account.country
   AND r.payload->>'currency' IS NOT DISTINCT FROM account.currency
   AND coalesce(nullif(r.payload->'routing','null'::jsonb),'{}'::jsonb)=account.routing
   AND r.payload->>'sealedAccount'=account.account_number_encrypted
   AND r.payload->>'accountLastFour'=account.account_last_four
   AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id
    AND newer.subject_kind=s.subject_kind AND newer.subject_id=s.subject_id
    AND (newer.created_at,newer.id)>(s.created_at,s.id))
   AND ((s.policy->>'kind'='ungated' AND account.approved_by=s.actor_id
      AND public.flow_ungated_submission_authorized(r.org_id,s.subject_kind,r.id,s.actor_id))
    OR (s.policy->>'kind'='gated' AND public.flow_submission_approved(r.org_id,s.subject_kind,r.id,s.id)
      AND EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text
       AND g.status='approved' AND g.decided_by=account.approved_by))))
$$;

CREATE OR REPLACE FUNCTION public.bank_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE fingerprint text;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.source_change_request_id IS DISTINCT FROM OLD.source_change_request_id THEN
  RAISE EXCEPTION 'The bank detail source request is immutable. File a new bank change.';
 END IF;
 IF NEW.source_change_request_id IS NOT NULL THEN
  IF TG_OP='INSERT' THEN
   IF NEW.approval_status<>'approved' OR NOT NEW.is_active OR NEW.approved_at IS NULL
     OR NOT public.employment_bank_projection_authorized(NEW) THEN
    RAISE EXCEPTION 'Apply these exact bank details through their completed native employment-change Flow.';
   END IF;
  ELSIF public.bank_approval_fingerprint(NEW) IS DISTINCT FROM public.bank_approval_fingerprint(OLD)
    OR ROW(NEW.approved_by,NEW.approved_at,NEW.submitted_by,NEW.approval_status)
      IS DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at,OLD.submitted_by,OLD.approval_status) THEN
   RAISE EXCEPTION 'Approved employment bank details are immutable. File a replacement bank change.';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approval_status<>'pending' OR NEW.is_active OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
   RAISE EXCEPTION 'Save new bank details pending native Flow routing.';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.approval_status='approved' AND (OLD.approval_status<>'approved'
   OR public.bank_approval_fingerprint(NEW) IS DISTINCT FROM public.bank_approval_fingerprint(OLD)) THEN
  fingerprint:=public.bank_approval_fingerprint(NEW);
  IF public.flow_ungated_submission_authorized(NEW.org_id,'party_bank_account',NEW.id,NEW.approved_by,
     jsonb_build_object('approvalFingerprint',fingerprint)) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='party_bank_account' AND g.subject_id=NEW.id
      AND g.status='approved' AND g.decided_by=NEW.approved_by
      AND r.context->>'approvalFingerprint'=fingerprint
      AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
      AND (NEW.approved_by IS DISTINCT FROM NEW.submitted_by OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
         WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
          AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
   OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='party_bank_account'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Release the current bank details through their configured native Flow gates.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
