-- Provider return approvals bind financial source evidence and the exact
-- queued action, independently of operational messages and delivery history.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.provider_return_approval_fingerprint(organization uuid,subject uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT public.flow_command_record_fingerprint(to_jsonb(d)-ARRAY['status_history','reason'],jsonb_build_object(
  'refundSource',(SELECT entry->'refundSource' FROM jsonb_array_elements(d.status_history) WITH ORDINALITY e(entry,ord) WHERE entry ? 'refundSource' ORDER BY ord DESC LIMIT 1),
  'pendingAction',(SELECT entry->'pendingAction' FROM jsonb_array_elements(d.status_history) WITH ORDINALITY e(entry,ord) WHERE entry ? 'pendingAction' ORDER BY ord DESC LIMIT 1),
  'pendingEvent',(SELECT entry->'event' FROM jsonb_array_elements(d.status_history) WITH ORDINALITY e(entry,ord) WHERE entry ? 'pendingAction' ORDER BY ord DESC LIMIT 1)))
 FROM public.payment_disputes d WHERE d.org_id=organization AND d.id=subject
$$;

CREATE FUNCTION public.provider_return_command_approved(organization uuid,subject uuid,action text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization
  AND s.subject_kind='payment_dispute_review' AND s.subject_id=subject AND s.policy->>'kind'='gated'
  AND s.context->>'approvalFingerprint'=public.provider_return_approval_fingerprint(organization,subject)
  AND s.context->'command'=jsonb_build_object('action',action)
  AND public.flow_submission_approved(organization,'payment_dispute_review',subject,s.id))
$$;

-- Tenant-authored Flows are the sole approval policy for provider returns.
ALTER TABLE public.psp_provider_configs DROP COLUMN refund_policy;
