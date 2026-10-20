-- Freeze tenant Flow submissions for native record and financial command approvals.
-- Zero-gate routing releases the owning command; configured gates retain the submitted policy.
-- Backfill: none. Recorded financial history and prior decisions remain unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE flow_gates ADD COLUMN escalated_from_gate_id uuid;
CREATE UNIQUE INDEX flow_gates_org_id_id_unique ON flow_gates(org_id,id);
ALTER TABLE flow_gates ADD CONSTRAINT flow_gates_escalated_from_fk
 FOREIGN KEY(org_id,escalated_from_gate_id) REFERENCES flow_gates(org_id,id);
CREATE FUNCTION public.flow_gate_escalation_lineage_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.escalated_from_gate_id IS DISTINCT FROM OLD.escalated_from_gate_id THEN
   RAISE EXCEPTION 'A gate retains its original escalation lineage.';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.escalated_from_gate_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.flow_gates parent WHERE parent.org_id=NEW.org_id AND parent.id=NEW.escalated_from_gate_id
     AND parent.run_id=NEW.run_id AND parent.flow_id=NEW.flow_id AND parent.node_id=NEW.node_id
     AND parent.group_key=NEW.group_key AND parent.quorum=NEW.quorum AND parent.status='escalated') THEN
  RAISE EXCEPTION 'An escalation replacement must retain its native gate group and replaced decision.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER flow_gate_escalation_lineage_guard BEFORE INSERT OR UPDATE ON flow_gates
 FOR EACH ROW EXECUTE FUNCTION public.flow_gate_escalation_lineage_guard();

ALTER TABLE financial_changes ADD COLUMN submission_policy jsonb;

CREATE FUNCTION public.flow_submission_policy_valid(
  organization uuid, subject_kind text, subject_id uuid, actor uuid, policy jsonb
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT coalesce(
  policy->'version'='1'::jsonb AND policy->>'trigger' IN('on_submit','on_create','on_update') AND policy->>'kind' IN('gated','ungated')
  AND policy-ARRAY['version','trigger','kind','flowIds','runIds']='{}'::jsonb
  AND jsonb_typeof(policy->'flowIds')='array' AND jsonb_typeof(policy->'runIds')='array'
  AND policy->'flowIds'=(SELECT coalesce(jsonb_agg(f.id::text ORDER BY f.id),'[]'::jsonb)
    FROM public.flows f WHERE f.org_id=organization AND f.subject_kind=flow_submission_policy_valid.subject_kind AND f.enabled)
  AND (SELECT count(*) FROM jsonb_array_elements(policy->'runIds'))=
      (SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'runIds'))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(policy->'runIds') run_id
    WHERE NOT EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=organization
      AND r.id::text=run_id AND r.subject_kind=flow_submission_policy_valid.subject_kind
      AND r.subject_id=flow_submission_policy_valid.subject_id AND r.trigger=policy->>'trigger'
      AND r.created_by IS NOT DISTINCT FROM actor AND r.error IS NULL AND r.status IN('completed','waiting')
      AND policy->'flowIds' ? r.flow_id::text))
  AND CASE WHEN policy->>'kind'='gated' THEN EXISTS(SELECT 1 FROM public.flow_gates g
    WHERE g.org_id=organization AND policy->'runIds' ? g.run_id::text AND g.status IN('pending','escalated'))
   ELSE NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=organization
      AND ((g.subject_kind=flow_submission_policy_valid.subject_kind AND g.subject_id=flow_submission_policy_valid.subject_id
        AND g.status IN('pending','escalated')) OR policy->'runIds' ? g.run_id::text))
    AND NOT EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=organization
      AND policy->'runIds' ? r.id::text AND r.status<>'completed') END,
 false);
$function$;

-- Every subject uses the same immutable dispatch receipt, including submissions
-- for which no Flow matches. Graph snapshots explain the tenant policy in effect.
CREATE TABLE public.flow_submissions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 subject_kind text NOT NULL,subject_id uuid NOT NULL,actor_id uuid,
 policy jsonb NOT NULL,context jsonb NOT NULL,graphs jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT flow_submissions_actor_owned FOREIGN KEY(actor_id) REFERENCES public.users(id),
 CONSTRAINT flow_submissions_org_id_id_unique UNIQUE(org_id,id),
 CONSTRAINT flow_submissions_shape CHECK(length(subject_kind) BETWEEN 1 AND 100
   AND jsonb_typeof(context)='object' AND jsonb_typeof(graphs)='array'));
CREATE INDEX flow_submissions_subject ON public.flow_submissions(org_id,subject_kind,subject_id,created_at,id);
ALTER TABLE public.flow_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.flow_submissions USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.flow_submissions IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.flow_submissions
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
CREATE FUNCTION public.flow_submission_receipt_guard() RETURNS trigger
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
     WHERE u.org_id=NEW.org_id AND u.id=NEW.actor_id AND u.is_active))
   OR NOT public.flow_submission_policy_valid(NEW.org_id,NEW.subject_kind,NEW.subject_id,NEW.actor_id,NEW.policy)
   OR NEW.graphs IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'graph',f.graph) ORDER BY f.id),'[]'::jsonb)
     FROM public.flows f WHERE f.org_id=NEW.org_id AND f.subject_kind=NEW.subject_kind AND f.enabled) THEN
  RAISE EXCEPTION 'The Flow submission requires complete routing evidence and the current graph snapshots.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER flow_submission_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.flow_submissions
 FOR EACH ROW EXECUTE FUNCTION public.flow_submission_receipt_guard();

CREATE FUNCTION public.flow_ungated_submission_authorized(organization uuid,kind text,subject uuid,actor uuid,expected_context jsonb DEFAULT '{}'::jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind
   AND s.subject_id=subject AND s.actor_id IS NOT DISTINCT FROM actor AND s.policy->>'kind'='ungated' AND s.context @> expected_context
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(s.policy->'runIds') run_id WHERE NOT EXISTS(
     SELECT 1 FROM public.flow_runs r WHERE r.org_id=s.org_id AND r.id::text=run_id
       AND r.subject_kind=s.subject_kind AND r.subject_id=s.subject_id AND r.status='completed' AND r.error IS NULL))
   AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND s.policy->'runIds' ? g.run_id::text)
   AND NOT EXISTS(SELECT 1 FROM public.flow_submissions later WHERE later.org_id=s.org_id AND later.subject_kind=s.subject_kind
     AND later.subject_id=s.subject_id AND (later.created_at,later.id)>(s.created_at,s.id))
   AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind
     AND g.subject_id=s.subject_id AND g.status IN('pending','escalated')));
$$;

CREATE OR REPLACE FUNCTION financial_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scrap_work_order_subsidiary_id uuid;
  scrap_posted_entry_id uuid;
  scrap_posted_journal_subsidiary_id uuid;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP='DELETE' THEN
    IF coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'financial changes are immutable evidence; propose a correcting change';
  END IF;
  IF TG_OP='INSERT' AND NEW.submission_policy IS NOT NULL AND NOT public.openbooks_clone_authority() THEN
    RAISE EXCEPTION 'Submission routing evidence is captured only on submission.';
  END IF;
  IF TG_OP='UPDATE' AND NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
    IF OLD.status<>'draft' OR NEW.status<>'pending' OR OLD.submission_policy IS NOT NULL
      OR NOT public.flow_submission_policy_valid(NEW.org_id,'financial_change',NEW.id,NEW.submitted_by,NEW.submission_policy) THEN
      RAISE EXCEPTION 'The accounting event requires complete native Flow routing evidence, frozen on submission.';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='pending' AND NEW.submission_policy IS NULL THEN
    RAISE EXCEPTION 'Submit the accounting event through its native Flow routing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subsidiaries WHERE id=NEW.subsidiary_id AND org_id=NEW.org_id) THEN
    RAISE EXCEPTION 'financial change subsidiary must belong to the organization';
  END IF;
  IF TG_OP='INSERT' THEN
    IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'financial changes must start as draft'; END IF;
  END IF;
  IF NEW.domain = 'manufacturing' AND (
       TG_OP = 'INSERT'
       OR (OLD.status = 'draft' AND NEW.status = 'pending')
       OR (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
       OR (OLD.status = 'approved' AND NEW.status = 'applied')) THEN
    IF NEW.operation = 'work_order_loss_disposition' THEN
      IF NEW.payload->>'workOrderId' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
        OR NEW.before_state->'order'->>'id' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.before_state->'order'->>'subsidiary_id' IS DISTINCT FROM NEW.subsidiary_id::text
        OR NEW.before_state->>'onDate' IS DISTINCT FROM NEW.effective_on::text
        OR NEW.before_state->>'quantity' IS DISTINCT FROM NEW.payload->'input'->>'quantity'
        OR coalesce(NEW.before_state->>'value','') !~ '^[0-9]+([.][0-9]{1,4})?$'
        OR coalesce(NEW.before_state->>'quantity','') !~ '^[0-9]+([.][0-9]{1,4})?$'
        OR jsonb_typeof(NEW.payload->'input'->'times') IS DISTINCT FROM 'array'
        OR NOT EXISTS(SELECT 1 FROM public.mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.subject_id AND subsidiary_id=NEW.subsidiary_id) THEN
        RAISE EXCEPTION 'Production loss approval must bind its work, actual discarded quantity, conversion time, WIP and booking entity.' USING ERRCODE='23514';
      END IF;
      IF (NEW.before_state->>'quantity')::numeric<=0 OR (NEW.before_state->>'value')::numeric>999999999999999.9999 THEN RAISE EXCEPTION 'Production loss quantities and values require exact supported precision.' USING ERRCODE='23514'; END IF;
    ELSIF NEW.operation = 'standard_cost_rollup' THEN
      IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
        OR NEW.payload->>'itemId' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.payload->>'subsidiaryId' IS DISTINCT FROM NEW.subsidiary_id::text
        OR NEW.payload->>'onDate' IS DISTINCT FROM NEW.effective_on::text
        OR NEW.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
        OR coalesce(NEW.payload->>'batchQuantity','') !~ '^[0-9]+([.][0-9]{1,4})?$'
        OR coalesce(NEW.payload->>'standardCost','') !~ '^[0-9]+([.][0-9]{1,4})?$'
        OR NOT EXISTS(SELECT 1 FROM public.item_inventory_profiles WHERE org_id=NEW.org_id AND item_id=NEW.subject_id AND costing_method='standard') THEN
        RAISE EXCEPTION 'Standard roll-up must bind a tenant standard-cost item, costing date, positive batch, standard, and booking entity.' USING ERRCODE='23514';
      END IF;
      IF (NEW.payload->>'batchQuantity')::numeric<=0 THEN RAISE EXCEPTION 'Standard roll-up batch must be positive.' USING ERRCODE='23514'; END IF;
    ELSIF NEW.operation = 'bom_revision_activation' THEN
      IF NEW.payload->>'assemblyItemId' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
        OR jsonb_typeof(NEW.payload->'components') IS DISTINCT FROM 'array'
        OR jsonb_typeof(NEW.before_state->'lines') IS DISTINCT FROM 'array'
        OR jsonb_array_length(NEW.payload->'components') NOT BETWEEN 1 AND 500
        OR NOT EXISTS(SELECT 1 FROM public.items WHERE org_id=NEW.org_id AND id=NEW.subject_id AND kind<>'kit') THEN
        RAISE EXCEPTION 'BOM approval must bind its tenant produced item, component revision and booking entity.' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.operation = 'routing_revision_activation' THEN
      IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
        OR NEW.payload->>'routingId' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
        OR jsonb_typeof(NEW.payload->'supersedes') IS DISTINCT FROM 'array'
        OR NEW.before_state->'candidate'->>'id' IS DISTINCT FROM NEW.subject_id::text
        OR NEW.before_state->'candidate'->>'effectiveFrom' IS DISTINCT FROM NEW.effective_on::text
        OR NOT EXISTS(SELECT 1 FROM public.mfg_routings WHERE org_id=NEW.org_id AND id=NEW.subject_id) THEN
        RAISE EXCEPTION 'Routing approval must bind its tenant revision, effective date and governed prior windows.' USING ERRCODE='23514';
      END IF;
    ELSE
    IF NEW.operation <> 'scrap_snapshot_restatement' THEN
      RAISE EXCEPTION 'manufacturing financial changes admit only the scrap_snapshot_restatement operation, not %', NEW.operation;
    END IF;
    IF NEW.payload IS NULL OR jsonb_typeof(NEW.payload) <> 'object' THEN
      RAISE EXCEPTION 'manufacturing scrap restatement proposals must carry an object payload binding the event, work order, subsidiary, and approval flag';
    END IF;
    IF NOT (NEW.payload ? 'event_id')
      OR NOT (NEW.payload ? 'work_order_id')
      OR NOT (NEW.payload ? 'subsidiary_id')
      OR NOT (NEW.payload ? 'requiredSubsidiaryIds') THEN
      RAISE EXCEPTION 'manufacturing scrap restatement proposals must bind event_id, work_order_id, subsidiary_id, and requiredSubsidiaryIds in the payload';
    END IF;
    IF jsonb_typeof(NEW.payload -> 'requiredSubsidiaryIds') <> 'array'
      OR jsonb_typeof(NEW.payload -> 'approval_required') <> 'boolean' THEN
      RAISE EXCEPTION 'manufacturing scrap restatement proposals must bind requiredSubsidiaryIds as an array and the engine-derived approval_required as a boolean';
    END IF;
    IF (NEW.payload ->> 'event_id') <> NEW.subject_id::text THEN
      RAISE EXCEPTION 'manufacturing scrap restatement subject must be the bound event';
    END IF;
    SELECT work_order.subsidiary_id, scrap_event.posted_entry_id
      INTO scrap_work_order_subsidiary_id, scrap_posted_entry_id
      FROM public.mfg_scrap_events scrap_event
      JOIN public.mfg_work_orders work_order
        ON work_order.org_id = scrap_event.org_id
       AND work_order.id = scrap_event.work_order_id
     WHERE scrap_event.org_id = NEW.org_id
       AND scrap_event.id = NEW.subject_id
       AND scrap_event.work_order_id::text = (NEW.payload ->> 'work_order_id');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'manufacturing scrap restatement must bind the same-organization event, its work order, and that work order''s subsidiary';
    END IF;
    IF scrap_work_order_subsidiary_id IS NULL THEN
      RAISE EXCEPTION 'manufacturing scrap restatement for event % is refused: work order % carries no subsidiary, and a restatement requires a non-null authoritative work-order subsidiary', NEW.subject_id, (NEW.payload ->> 'work_order_id');
    END IF;
    IF scrap_work_order_subsidiary_id IS DISTINCT FROM NEW.subsidiary_id THEN
      RAISE EXCEPTION 'manufacturing scrap restatement for event % must book the work order''s subsidiary %, not %', NEW.subject_id, scrap_work_order_subsidiary_id, NEW.subsidiary_id;
    END IF;
    IF (NEW.payload ->> 'subsidiary_id') IS DISTINCT FROM NEW.subsidiary_id::text THEN
      RAISE EXCEPTION 'manufacturing scrap restatement for event % payload subsidiary % must equal the booking subsidiary %', NEW.subject_id, (NEW.payload ->> 'subsidiary_id'), NEW.subsidiary_id;
    END IF;
    IF (NEW.payload -> 'requiredSubsidiaryIds') <> jsonb_build_array(NEW.subsidiary_id::text) THEN
      RAISE EXCEPTION 'manufacturing scrap restatement requiredSubsidiaryIds must be exactly the booking subsidiary';
    END IF;
    IF scrap_posted_entry_id IS NOT NULL THEN
      SELECT journal_entry.subsidiary_id
        INTO scrap_posted_journal_subsidiary_id
        FROM public.journal_entries journal_entry
       WHERE journal_entry.org_id = NEW.org_id
         AND journal_entry.id = scrap_posted_entry_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'manufacturing scrap restatement for event % references posted entry % which has no same-organization journal entry; reconcile the posted entry through the controlled accounting evidence correction workflow before retrying the restatement, without posting a duplicate entry, reversing the entry, rewriting the event, or fabricating journal evidence', NEW.subject_id, scrap_posted_entry_id;
      END IF;
      IF scrap_posted_journal_subsidiary_id IS DISTINCT FROM NEW.subsidiary_id THEN
        RAISE EXCEPTION 'manufacturing scrap restatement for event % posted entry % books subsidiary %, not the bound booking subsidiary %', NEW.subject_id, scrap_posted_entry_id, scrap_posted_journal_subsidiary_id, NEW.subsidiary_id;
      END IF;
    ELSE
      IF (NEW.payload ? 'posted_entry_id')
        OR (NEW.payload ? 'journal_entry_id')
        OR (NEW.payload ? 'entry_id') THEN
        RAISE EXCEPTION 'manufacturing scrap restatement for unposted event % must not carry journal evidence; payload keys posted_entry_id, journal_entry_id, and entry_id are refused', NEW.subject_id;
      END IF;
    END IF;
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by','submission_policy'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by','submission_policy']) THEN
    RAISE EXCEPTION 'financial change proposal is immutable; create a new proposal';
  END IF;
  IF NOT ((OLD.status='draft' AND NEW.status='pending') OR
          (OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR
          (OLD.status='approved' AND NEW.status='applied')) THEN
    RAISE EXCEPTION 'invalid financial change transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status <> 'pending' AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'financial change approval cannot be rewritten';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.financial_change_self_decision_authorized(
  organization uuid, change_id uuid, decision_actor uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT decision_actor IS NOT NULL AND (
  EXISTS (SELECT 1 FROM public.financial_changes c WHERE c.org_id=organization AND c.id=change_id
    AND c.submitted_by=decision_actor AND c.submission_policy->>'kind'='ungated'
    AND c.submission_policy->'version'='1'::jsonb
    AND public.flow_ungated_submission_authorized(c.org_id,'financial_change',c.id,decision_actor))
  OR (EXISTS (
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
  )));
$function$;

CREATE OR REPLACE FUNCTION public.financial_change_self_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.approved_by=NEW.submitted_by AND NOT public.financial_change_self_decision_authorized(NEW.org_id,NEW.id,NEW.approved_by) THEN
  RAISE EXCEPTION 'Submit through Flows; release requires successful ungated routing or its retained gate decisions.';
 END IF;
 RETURN NEW;
END $function$;


ALTER TABLE close_reopen_requests ADD COLUMN submission_policy jsonb;
CREATE FUNCTION public.reopen_submission_policy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.submission_policy IS NOT NULL THEN RAISE EXCEPTION 'Submit the saved reopen through Flows.'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
  IF OLD.status<>'requested' OR NEW.status<>'requested' OR OLD.submission_policy IS NOT NULL
    OR NOT public.flow_submission_policy_valid(NEW.org_id,'close_reopen_request',NEW.id,NEW.requested_by,NEW.submission_policy) THEN
   RAISE EXCEPTION 'Reopen routing evidence must be complete and freezes on submission.';
  END IF;
 END IF;
 IF OLD.status='requested' AND NEW.status='approved' AND NEW.submission_policy IS NULL THEN
  RAISE EXCEPTION 'Submit the reopen through Flows before releasing it.';
 END IF;
 IF OLD.status='requested' AND NEW.status IN('approved','rejected') THEN
  IF NEW.submission_policy->>'kind'='ungated' THEN
   IF NEW.status<>'approved' OR NEW.approved_by IS DISTINCT FROM NEW.requested_by THEN
    RAISE EXCEPTION 'An ungated reopen is released by its requester, without a human decision.';
   END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='close_reopen_request' AND g.subject_id=NEW.id
      AND g.status=NEW.status AND g.decided_by=NEW.approved_by AND g.decided_at IS NOT NULL
      AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
      AND (NEW.approved_by<>NEW.requested_by OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
          WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
            AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id
      AND g.subject_kind='close_reopen_request' AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete the configured reopen gates before releasing the request.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reopen_submission_policy_guard BEFORE INSERT OR UPDATE ON close_reopen_requests
 FOR EACH ROW EXECUTE FUNCTION public.reopen_submission_policy_guard();

ALTER TABLE equity_action_requests DROP CONSTRAINT equity_action_requests_decision;
ALTER TABLE equity_action_requests ADD CONSTRAINT equity_action_requests_decision CHECK (
 (status='pending_approval' AND decided_by IS NULL AND decided_at IS NULL AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval)
 OR (status='applied' AND applied_at IS NOT NULL AND result IS NOT NULL
   AND ((released_without_approval AND decided_by IS NULL AND decided_at IS NULL)
     OR (NOT released_without_approval AND decided_by IS NOT NULL AND decided_at IS NOT NULL)))
 OR (status='rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
   AND length(btrim(decision_comment)) BETWEEN 1 AND 2000 AND applied_at IS NULL AND NOT released_without_approval));
CREATE FUNCTION public.equity_action_flow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
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
CREATE TRIGGER equity_action_flow_decision_guard BEFORE UPDATE ON equity_action_requests
 FOR EACH ROW EXECUTE FUNCTION public.equity_action_flow_decision_guard();

ALTER TABLE stock_counts ADD COLUMN submitted_by uuid,
 ADD COLUMN submission_policy jsonb, ADD COLUMN review_released boolean NOT NULL DEFAULT false;
ALTER TABLE stock_counts ADD CONSTRAINT stock_count_submitter_owned FOREIGN KEY(submitted_by) REFERENCES users(id);
CREATE FUNCTION public.stock_count_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.submission_policy IS NOT NULL OR NEW.review_released THEN RAISE EXCEPTION 'Stock counts start without review admission.'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='review' AND NEW.status IN('counting','cancelled') THEN
  IF EXISTS(SELECT 1 FROM flow_gates WHERE org_id=NEW.org_id AND subject_kind='stock_count'
    AND subject_id=NEW.id AND status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Withdraw the native count approval gates before changing the count.';
  END IF;
  NEW.submission_policy:=NULL; NEW.review_released:=false; NEW.submitted_by:=NULL;
  RETURN NEW;
 END IF;
 IF OLD.status='counting' AND NEW.status='review' THEN
  IF NEW.submitted_by IS NULL OR NOT public.flow_submission_policy_valid(NEW.org_id,'stock_count',NEW.id,NEW.submitted_by,NEW.submission_policy)
    OR NEW.review_released IS DISTINCT FROM (NEW.submission_policy->>'kind'='ungated') THEN
   RAISE EXCEPTION 'Submit the counted observations through their native Flow routing.';
  END IF;
 ELSIF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
  RAISE EXCEPTION 'Count review policy freezes on submission; return to counting for a new review.';
 END IF;
 IF OLD.status='review' AND NEW.status='review' AND NOT OLD.review_released AND NEW.review_released THEN
  IF NEW.submission_policy->>'kind' IS DISTINCT FROM 'gated'
    OR NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id
      AND s.subject_kind='stock_count' AND s.subject_id=NEW.id AND s.policy=NEW.submission_policy
      AND public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id))
    OR NOT EXISTS(SELECT 1 FROM flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='stock_count'
      AND g.subject_id=NEW.id AND NEW.submission_policy->'runIds' ? g.run_id::text
      AND g.status='approved' AND g.decided_by=NEW.updated_by)
    OR EXISTS(SELECT 1 FROM flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='stock_count'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete all configured count review gates before releasing it.';
  END IF;
 END IF;
 IF OLD.status='review' AND NEW.status='posted' AND NOT OLD.review_released THEN
  RAISE EXCEPTION 'The stock count has not been released by its Flow submission policy.';
 END IF;
 IF OLD.status='review' AND NEW.counted_on IS DISTINCT FROM OLD.counted_on THEN
  RAISE EXCEPTION 'Return the count to counting before changing its date.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_count_flow_admission_guard BEFORE INSERT OR UPDATE ON stock_counts
 FOR EACH ROW EXECUTE FUNCTION public.stock_count_flow_admission_guard();


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
  ) OR public.flow_ungated_submission_authorized(organization,subject_kind,subject_id,decision_actor,
    jsonb_build_object('packageId',package_id::text,'revision',submitted_revision,'status','submitted','submittedBy',decision_actor::text)));
$function$;

CREATE OR REPLACE FUNCTION public.hrm_employment_change_request_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
DECLARE
  computed_digest text;
  run_org uuid;
  run_kind text;
  run_subject uuid;
  change_org uuid;
  change_employment uuid;
  change_revision integer;
  direct_admission boolean := false;
BEGIN
  -- Canonical digest over the exact bytes of the jsonb normalized text
  -- form. Storage computes; callers never supply a trusted digest.
  computed_digest :=
    encode(digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256'), 'hex');

  IF TG_OP = 'INSERT' THEN
    -- Clone replay: the sandbox/sample-company clone replays immutable
    -- terminal history verbatim while the clone authority holds, which is
    -- only inside the clone's own maintenance transaction. Admit that
    -- replayed INSERT — the digest is still recomputed in storage below —
    -- while every ordinary session keeps the born-draft refusals that
    -- follow. UPDATE and DELETE of this history stay blocked: this
    -- admission returns only on the INSERT path.
    IF public.openbooks_clone_authority() THEN
      NEW.payload_digest := computed_digest;
      RETURN NEW;
    END IF;
    -- Rows are born drafts. A forged submission (pending_approval with a
    -- run, a snapshot, or submission stamps on insert) is refused: submit
    -- through the draft -> pending_approval transition instead.
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'HRM change request must be inserted as draft, then submitted — insert with status % is refused.', NEW.status;
    END IF;
    IF NEW.submitted_at IS NOT NULL OR NEW.submitted_by IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted unsubmitted — submit through the draft -> pending_approval transition instead.';
    END IF;
    IF NEW.flow_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted without a flow run — the run is stamped at submit instead.';
    END IF;
    IF NEW.decision_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted without a decision snapshot — it is written atomically with approve/reject instead.';
    END IF;
    IF NEW.applied_at IS NOT NULL OR NEW.applied_by IS NOT NULL
       OR NEW.applied_employment_revision IS NOT NULL
       OR NEW.applied_employment_change_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request must be inserted unapplied — application evidence is stamped on approved -> applied instead.';
    END IF;
    NEW.payload_digest := computed_digest;
    RETURN NEW;
  END IF;

  -- Identity and creator are frozen from insert, even in draft: a proposal
  -- about another employment is a new request, not an edit. The row id and
  -- creation timestamp are frozen with them — history must not be re-keyed
  -- or re-dated.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION
      'HRM change request identity (id, org, employment, created_at, creator) is immutable — file a new request instead.';
  END IF;

  -- No-flow direct admission: approval is an optional tenant Flow. A draft
  -- flipping straight to approved is admitted only as the submitter's own
  -- direct application — stamps, reason, and an automatic no-flow snapshot
  -- atomically, the kind preconditions re-proven in storage (a hire lands
  -- only on a version-less identity; every other kind needs existing
  -- versions), and no enabled Flow plus no run to contradict the direct
  -- decision. Every operand is two-valued (COALESCE/IS NULL/EXISTS), so the
  -- flag is false unless the whole admission holds — never unknown.
  IF OLD.status = 'draft' AND NEW.status = 'approved'
     AND NEW.submitted_at IS NOT NULL AND NEW.submitted_by IS NOT NULL
     AND NEW.reason IS NOT NULL AND length(btrim(NEW.reason)) > 0
     AND NEW.flow_run_id IS NULL
     AND NEW.decision_snapshot IS NOT NULL
     AND COALESCE(NEW.payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change', 'bank_change')
     AND COALESCE(NEW.decision_snapshot->>'mode', '') = 'automatic'
     AND NEW.decision_snapshot->'policy'->>'kind'='ungated'
     AND public.flow_ungated_submission_authorized(NEW.org_id,'hrm_employment_change_request',NEW.id,NEW.submitted_by,
       jsonb_build_object('payloadDigest',NEW.payload_digest,'expectedEmploymentRevision',NEW.expected_employment_revision))
     AND (
       (
         COALESCE(NEW.payload->>'kind', '') = 'hire'
         AND NOT EXISTS (
           SELECT 1 FROM public.worker_employment_versions v
            WHERE v.org_id = NEW.org_id AND v.employment_id = NEW.employment_id
         )
       ) OR (
         COALESCE(NEW.payload->>'kind', '') <> 'hire'
         AND EXISTS (
           SELECT 1 FROM public.worker_employment_versions v
            WHERE v.org_id = NEW.org_id AND v.employment_id = NEW.employment_id
         )
       )
     )
  THEN
    direct_admission := true;
  END IF;

  -- Payload/digest/schema-version/expected-revision live only in draft.
  -- Draft payload edits recompute the digest in storage; anything else
  -- attempting a silent re-point is refused.
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_schema_version IS DISTINCT FROM OLD.payload_schema_version
     OR NEW.expected_employment_revision IS DISTINCT FROM OLD.expected_employment_revision THEN
    IF OLD.status <> 'draft' OR NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'HRM change request payload, schema version, and expected revision freeze on submit — file a new request for a revised proposal instead.';
    END IF;
    NEW.payload_digest := computed_digest;
  ELSIF NEW.payload_digest IS DISTINCT FROM OLD.payload_digest THEN
    RAISE EXCEPTION
      'HRM change request digest is storage-computed and immutable outside draft payload edits — it cannot be re-pointed.';
  END IF;

  -- Draft edits advance the request revision by exactly one; submitted rows
  -- never move it (resubmission is a new request, not a revision bump).
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.payload IS NOT DISTINCT FROM OLD.payload
       AND NEW.payload_schema_version IS NOT DISTINCT FROM OLD.payload_schema_version
       AND NEW.expected_employment_revision IS NOT DISTINCT FROM OLD.expected_employment_revision
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
      -- Touch-only update (e.g. updated_at): revision stays put.
      IF NEW.request_revision IS DISTINCT FROM OLD.request_revision THEN
        RAISE EXCEPTION
          'HRM change request revision moves only with a draft edit, by exactly one — leave request_revision alone on a touch update.';
      END IF;
    ELSIF NEW.request_revision <> OLD.request_revision + 1 THEN
      RAISE EXCEPTION
        'HRM change request draft edits advance request_revision by exactly one (was %, got %) — do not skip or reuse revisions.', OLD.request_revision, NEW.request_revision;
    END IF;
  ELSIF NEW.request_revision IS DISTINCT FROM OLD.request_revision THEN
    RAISE EXCEPTION
      'HRM change request revision freezes on submit — file a new request for a revised proposal instead.';
  END IF;

  -- Lifecycle transitions. Terminal states never leave; rejected and
  -- withdrawn never resurrect (a revised proposal is a new request, so an
  -- old approval can never be re-pointed at it). The no-flow direct
  -- admission is the only draft -> approved path besides submission.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status NOT IN ('pending_approval', 'withdrawn') AND NOT direct_admission THEN
      RAISE EXCEPTION
        'HRM change request draft must submit (pending_approval) or withdraw — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'pending_approval'
            AND NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION
        'HRM change request awaiting approval resolves to approved, rejected, or withdrawn — transition to % is refused.', NEW.status;
    ELSIF OLD.status = 'approved' AND NEW.status <> 'applied' THEN
      RAISE EXCEPTION
        'HRM change request approved resolves only to applied — transition to % is refused. Withdraw or reject before approval instead.', NEW.status;
    ELSIF OLD.status IN ('rejected', 'withdrawn', 'applied') THEN
      RAISE EXCEPTION
        'HRM change request % is terminal — file a new request for a revised proposal instead.', OLD.status;
    END IF;
  END IF;

  -- Submission stamps are set once, on submit, and never re-pointed. A
  -- bare flip to pending_approval without them is refused here with a
  -- named remedy (the presence CHECKs backstop the same rule). The direct
  -- admission stamps actor/time/reason atomically on its draft -> approved
  -- flip; the run stays null by design there, admitted by the rewritten
  -- presence CHECKs above.
  IF (OLD.status = 'draft' AND NEW.status = 'pending_approval') OR direct_admission THEN
    IF NEW.submitted_at IS NULL OR NEW.submitted_by IS NULL
       OR (NEW.flow_run_id IS NULL AND NOT direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request submit stamps submission actor/time and the native flow run atomically — set submitted_by, submitted_at, and flow_run_id in the same update instead.';
    END IF;
    IF NEW.reason IS NULL OR length(btrim(NEW.reason)) = 0 THEN
      RAISE EXCEPTION
        'HRM change request submit carries a non-blank reason — record why the change is proposed instead.';
    END IF;
  END IF;
  IF OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'pending_approval') OR direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request submission stamps are set only on draft -> pending_approval — submit through that transition instead.';
    END IF;
  ELSIF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
        OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION
      'HRM change request submission actor and time are immutable once set — they record what was submitted, not what is convenient.';
  END IF;

  -- Submission reason is submission evidence: frozen once submitted.
  IF OLD.submitted_at IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION
      'HRM change request reason freezes on submit — record later rationale in the audit trail, not on the request.';
  END IF;

  -- The native run anchor is stamped at submit, verified against the live
  -- native run (same org, governed subject kind/id), and never re-pointed.
  -- Direct applications carry no run, so this block skips them.
  IF NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id THEN
    IF OLD.flow_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request flow run is retained once stamped — it cannot be re-pointed to another run.';
    END IF;
    IF NEW.flow_run_id IS NULL THEN
      RAISE EXCEPTION
        'HRM change request flow run cannot be cleared once stamped — it is retained as approval evidence.';
    END IF;
  END IF;
  IF NEW.flow_run_id IS NOT NULL THEN
    SELECT org_id, subject_kind, subject_id
      INTO run_org, run_kind, run_subject
      FROM public.flow_runs WHERE id = NEW.flow_run_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HRM change request flow run % does not exist — submit against a live native run instead.', NEW.flow_run_id;
    END IF;
    IF run_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION
        'HRM change request flow run % belongs to another organization — submit against a run in this organization instead.', NEW.flow_run_id;
    END IF;
    IF run_kind <> 'hrm_employment_change_request' OR run_subject IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION
        'HRM change request flow run % is not opened for this request (kind %, subject %) — open the governed HRM approval run for this request instead.', NEW.flow_run_id, run_kind, run_subject;
    END IF;
  END IF;

  -- Decision snapshot is written once, atomically with approve/reject, and
  -- frozen forever (the binding CHECK pins its keys to the row). The
  -- direct admission writes it atomically on draft -> approved.
  IF NEW.decision_snapshot IS DISTINCT FROM OLD.decision_snapshot THEN
    IF OLD.decision_snapshot IS NOT NULL THEN
      RAISE EXCEPTION
        'HRM change request decision snapshot is immutable once written — it records the decision that was made, not the one wanted.';
    END IF;
    IF NOT ((OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected')) OR direct_admission) THEN
      RAISE EXCEPTION
        'HRM change request decision snapshot is written only on pending_approval -> approved/rejected — decide through that transition instead.';
    END IF;
  END IF;

  -- Application evidence lands atomically with approved -> applied, linked
  -- to a live canonical change in this org. applied_by stays evidence:
  -- this trigger authenticates nothing about the application user.
  IF NEW.applied_employment_change_id IS DISTINCT FROM OLD.applied_employment_change_id THEN
    IF NOT (OLD.status = 'approved' AND NEW.status = 'applied') THEN
      RAISE EXCEPTION
        'HRM change request application evidence is stamped only on approved -> applied — apply through that transition instead.';
    END IF;
  END IF;
  IF NEW.status = 'applied' AND OLD.status = 'approved' THEN
    SELECT org_id, employment_id, revision
      INTO change_org, change_employment, change_revision
      FROM public.employment_changes WHERE id = NEW.applied_employment_change_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'HRM change request applied change % does not exist — apply against the canonical change the approval produced instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION
        'HRM change request applied change % belongs to another organization — apply against a change in this organization instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_employment IS DISTINCT FROM NEW.employment_id THEN
      RAISE EXCEPTION
        'HRM change request applied change % is recorded against another employment — apply against the canonical change for this employment instead.', NEW.applied_employment_change_id;
    END IF;
    IF change_revision IS DISTINCT FROM NEW.applied_employment_revision THEN
      RAISE EXCEPTION
        'HRM change request applied change % carries revision %, not the applied revision % — stamp the exact canonical revision the approval produced instead.', NEW.applied_employment_change_id, change_revision, NEW.applied_employment_revision;
    END IF;
  END IF;
  IF (OLD.status = 'applied')
     AND (NEW.applied_at IS DISTINCT FROM OLD.applied_at
          OR NEW.applied_by IS DISTINCT FROM OLD.applied_by
          OR NEW.applied_employment_revision IS DISTINCT FROM OLD.applied_employment_revision
          OR NEW.applied_employment_change_id IS DISTINCT FROM OLD.applied_employment_change_id) THEN
    RAISE EXCEPTION
      'HRM change request application evidence is immutable once applied — a second application is a duplicate, not an update.';
  END IF;

  RETURN NEW;
END;
$func$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_run_presence') THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      DROP CONSTRAINT hrm_employment_change_requests_run_presence;
  END IF;
  ALTER TABLE ONLY public.hrm_employment_change_requests
    ADD CONSTRAINT hrm_employment_change_requests_run_presence
    CHECK (
      status NOT IN ('pending_approval', 'approved', 'rejected', 'applied')
      OR flow_run_id IS NOT NULL
      OR (
        COALESCE(payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change', 'bank_change')
        AND COALESCE(decision_snapshot->>'mode', '') = 'automatic'
        AND (COALESCE(decision_snapshot->'policy'->>'flowConfigured', '') = 'false' OR decision_snapshot->'policy'->>'kind'='ungated')
      )
    );
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_employment_change_requests_snapshot_binding') THEN
    ALTER TABLE ONLY public.hrm_employment_change_requests
      DROP CONSTRAINT hrm_employment_change_requests_snapshot_binding;
  END IF;
  ALTER TABLE ONLY public.hrm_employment_change_requests
    ADD CONSTRAINT hrm_employment_change_requests_snapshot_binding
    CHECK (
      decision_snapshot IS NULL
      OR (
        jsonb_typeof(decision_snapshot) = 'object'
        AND (decision_snapshot ? 'gates')
        AND jsonb_typeof(decision_snapshot -> 'gates') = 'array'
        AND (decision_snapshot ? 'payload_digest')
        AND jsonb_typeof(decision_snapshot -> 'payload_digest') = 'string'
        AND (decision_snapshot ->> 'payload_digest') = payload_digest
        AND (decision_snapshot ? 'payload_schema_version')
        AND jsonb_typeof(decision_snapshot -> 'payload_schema_version') = 'string'
        AND (decision_snapshot ->> 'payload_schema_version') = payload_schema_version
        AND (decision_snapshot ? 'expected_employment_revision')
        AND jsonb_typeof(decision_snapshot -> 'expected_employment_revision') = 'number'
        AND (decision_snapshot ->> 'expected_employment_revision')::numeric = expected_employment_revision
        AND (
          (
            (decision_snapshot ? 'flow_run_id')
            AND jsonb_typeof(decision_snapshot -> 'flow_run_id') = 'string'
            AND flow_run_id IS NOT NULL
            AND (decision_snapshot ->> 'flow_run_id') = flow_run_id::text
          )
          OR (
            COALESCE(payload->>'kind', '') IN ('hire', 'status_change', 'assignment_change', 'termination', 'position_assignment', 'profile_change', 'bank_change')
            AND COALESCE(decision_snapshot->>'mode', '') = 'automatic'
            AND (COALESCE(decision_snapshot->'policy'->>'flowConfigured', '') = 'false' OR decision_snapshot->'policy'->>'kind'='ungated')
          )
        )
      )
    );
END
$$;



CREATE OR REPLACE FUNCTION public.benefit_enrollment_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $func$
DECLARE run_row public.flow_runs%ROWTYPE; mode text; unused_withdrawal boolean := false;
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.benefit_historical_clone_matches(TG_RELID,to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('elected','waived') OR NEW.flow_run_id IS NOT NULL OR NEW.submission_snapshot IS NOT NULL OR NEW.decision_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'Create a benefit election, then submit it through the plan approval setting; active coverage cannot be supplied on creation.' USING ERRCODE='23514';
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
      RAISE EXCEPTION 'The reward must snapshot its program approval setting; create it through the Benefits record action.';
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
      RAISE EXCEPTION 'Workflow submission requires the pinned Flows approval setting and a submitted reward; submit through its record action.';
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
    RAISE EXCEPTION 'Configure a Benefits approval policy in Flows before submitting this reward; submit it through its configured workflow.';
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
      IF NEW.decision_snapshot->>'mode' = 'automatic' THEN
        IF NEW.status <> 'approved' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NULL OR run_row.status <> 'completed'
          OR run_row.context->'submissionPolicy'->>'ungatedOutcome' IS DISTINCT FROM 'apply'
          OR EXISTS (SELECT 1 FROM public.flow_gates WHERE org_id = NEW.org_id AND subject_kind = 'hrm_benefit_award' AND subject_id = NEW.id) THEN
          RAISE EXCEPTION 'Direct Benefits processing requires an explicit completed ungated policy and records no human approver.';
        END IF;
      ELSIF NEW.decision_snapshot->>'mode' = 'human' THEN
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
        RAISE EXCEPTION 'Benefits decision mode must be explicit direct processing or a native human gate decision.';
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

CREATE FUNCTION public.checklist_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.approval_status='approved' AND OLD.approval_status<>'approved' THEN
  IF NEW.flow_run_id IS NULL THEN
   IF NOT public.flow_ungated_submission_authorized(NEW.org_id,'hrm_process_step',NEW.id,NEW.submitted_by,
     jsonb_build_object('submittedAt',NEW.submitted_at::text)) THEN
    RAISE EXCEPTION 'Checklist release requires its native ungated submission receipt.';
   END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_process_step'
    AND subject_id=NEW.id AND status='approved' AND decided_by=NEW.updated_by AND decided_at IS NOT NULL)
   OR EXISTS(SELECT 1 FROM flow_gates WHERE org_id=NEW.org_id AND subject_kind='hrm_process_step'
    AND subject_id=NEW.id AND status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete the checklist Flow gates before releasing its evidence.';
  END IF;
 END IF;
 IF NEW.status='done' AND OLD.status<>'done' AND NEW.approval_status<>'approved' THEN
  RAISE EXCEPTION 'Submit the checklist evidence through its native Flows before completion.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checklist_flow_admission_guard BEFORE UPDATE ON hrm_process_steps
 FOR EACH ROW EXECUTE FUNCTION public.checklist_flow_admission_guard();

ALTER TABLE budget_scenarios ADD COLUMN submission_policy jsonb;
CREATE FUNCTION public.budget_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status NOT IN('draft','archived') OR NEW.submission_policy IS NOT NULL THEN
   RAISE EXCEPTION 'Create a draft budget before submitting it through Flows.';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='draft' AND NEW.status='pending_approval' THEN
  IF NEW.submitted_by IS NULL OR NOT public.flow_submission_policy_valid(NEW.org_id,'budget_scenario',NEW.id,NEW.submitted_by,NEW.submission_policy)
   OR NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind='budget_scenario'
    AND s.subject_id=NEW.id AND s.actor_id=NEW.submitted_by AND s.policy=NEW.submission_policy
    AND s.context @> jsonb_build_object('revision',OLD.revision)
    AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
      AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))) THEN
   RAISE EXCEPTION 'Submit the current budget revision through native Flow routing.';
  END IF;
 ELSIF OLD.status='pending_approval' AND NEW.status='draft' THEN
  IF NEW.submission_policy IS NOT NULL OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id
    AND g.subject_kind='budget_scenario' AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Reject through the Flow gate or withdraw the submitted budget before editing it.';
  END IF;
 ELSIF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
  RAISE EXCEPTION 'Budget submission routing is immutable until the budget returns to draft.';
 END IF;
 IF NEW.status='approved' AND OLD.status<>'approved' THEN
  IF OLD.status<>'pending_approval' OR NEW.submission_policy IS NULL THEN
   RAISE EXCEPTION 'Submit the budget through Flows before release.';
  END IF;
  IF NEW.submission_policy->>'kind'='ungated' THEN
   IF NEW.approved_by IS DISTINCT FROM NEW.submitted_by
    OR NOT public.flow_ungated_submission_authorized(NEW.org_id,'budget_scenario',NEW.id,NEW.submitted_by,
      jsonb_build_object('revision',OLD.revision-1)) THEN
    RAISE EXCEPTION 'An ungated budget requires its current submission receipt.';
   END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id
    AND s.subject_kind='budget_scenario' AND s.subject_id=NEW.id AND s.policy=NEW.submission_policy
    AND public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id))
    OR NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='budget_scenario' AND g.subject_id=NEW.id
      AND NEW.submission_policy->'runIds' ? r.id::text AND g.status='approved' AND g.decided_by=NEW.approved_by
      AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
      AND (NEW.approved_by IS DISTINCT FROM NEW.submitted_by OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
         WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
          AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='budget_scenario'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete every configured budget approval gate before release.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget_flow_admission_guard BEFORE INSERT OR UPDATE ON budget_scenarios
 FOR EACH ROW EXECUTE FUNCTION public.budget_flow_admission_guard();


CREATE FUNCTION public.bank_approval_fingerprint(account public.party_bank_accounts) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(account.id,account.org_id,account.party_id,
   account.bank_name,account.country,account.currency,account.routing,account.account_number_encrypted,
   extract(epoch FROM account.submitted_at))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.bank_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE fingerprint text;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
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
CREATE TRIGGER bank_flow_admission_guard BEFORE INSERT OR UPDATE ON party_bank_accounts
 FOR EACH ROW EXECUTE FUNCTION public.bank_flow_admission_guard();

ALTER TABLE crm_sales_quotas ADD COLUMN submitted_by uuid,
 ADD COLUMN submission_policy jsonb,
 ADD CONSTRAINT sales_quota_submitter_owned FOREIGN KEY(submitted_by) REFERENCES users(id);
CREATE FUNCTION public.sales_quota_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.lifecycle NOT IN('draft') OR NEW.submission_policy IS NOT NULL THEN
   RAISE EXCEPTION 'Create a draft quota before submitting it through Flows.';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.lifecycle='draft' AND NEW.lifecycle='pending_approval' THEN
  IF NEW.submitted_by IS NULL OR NOT public.flow_submission_policy_valid(NEW.org_id,'sales_quota',NEW.id,NEW.submitted_by,NEW.submission_policy)
   OR NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind='sales_quota'
    AND s.subject_id=NEW.id AND s.actor_id=NEW.submitted_by AND s.policy=NEW.submission_policy
    AND s.context @> jsonb_build_object('revision',OLD.revision)
    AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
      AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))) THEN
   RAISE EXCEPTION 'Submit the current quota revision through native Flow routing.';
  END IF;
 ELSIF OLD.lifecycle='pending_approval' AND NEW.lifecycle='draft' THEN
  IF NEW.submission_policy IS NOT NULL OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id
    AND g.subject_kind='sales_quota' AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Reject through the Flow gate or withdraw the submitted quota before editing it.';
  END IF;
 ELSIF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
  RAISE EXCEPTION 'Budget submission routing is immutable until the quota returns to draft.';
 END IF;
 IF OLD.lifecycle='pending_approval' AND NEW.lifecycle<>'draft' AND
  (to_jsonb(NEW)-ARRAY['lifecycle','revision','updated_at','updated_by','reason','approved_at','approved_by']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['lifecycle','revision','updated_at','updated_by','reason','approved_at','approved_by']) THEN
  RAISE EXCEPTION 'Submitted quota terms are immutable; withdraw before editing.';
 END IF;
 IF NEW.lifecycle='approved' AND OLD.lifecycle<>'approved' THEN
  IF OLD.lifecycle<>'pending_approval' OR NEW.submission_policy IS NULL THEN
   RAISE EXCEPTION 'Submit the quota through Flows before release.';
  END IF;
  IF NEW.submission_policy->>'kind'='ungated' THEN
   IF NEW.approved_by IS DISTINCT FROM NEW.submitted_by
    OR NOT public.flow_ungated_submission_authorized(NEW.org_id,'sales_quota',NEW.id,NEW.submitted_by,
      jsonb_build_object('revision',OLD.revision-1)) THEN
    RAISE EXCEPTION 'An ungated quota requires its current submission receipt.';
   END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='sales_quota' AND g.subject_id=NEW.id
      AND NEW.submission_policy->'runIds' ? r.id::text AND g.status='approved' AND g.decided_by=NEW.approved_by
      AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
      AND (NEW.approved_by IS DISTINCT FROM NEW.submitted_by OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
         WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
          AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='sales_quota'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete every configured quota approval gate before release.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_quota_flow_admission_guard BEFORE INSERT OR UPDATE ON crm_sales_quotas
 FOR EACH ROW EXECUTE FUNCTION public.sales_quota_flow_admission_guard();

ALTER TABLE saas_metrics_normalization_requests DROP CONSTRAINT saas_metrics_normalization_requests_approver_distinct;
CREATE FUNCTION public.normalization_request_flow_authorized(organization uuid,subject uuid,actor uuid,outcome text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.saas_metrics_normalization_requests q WHERE q.org_id=organization AND q.id=subject AND (
   (outcome='approved' AND actor=q.requested_by AND public.flow_ungated_submission_authorized(organization,'metrics_normalization',subject,actor,
     jsonb_build_object('requestHash',q.request_hash)))
   OR (EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
     WHERE g.org_id=organization AND g.subject_kind='metrics_normalization' AND g.subject_id=subject AND g.status=outcome
       AND g.decided_by=actor AND r.context->>'requestHash'=q.request_hash
       AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text
       AND (actor<>q.requested_by OR EXISTS(
         SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
          WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
           AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
     AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=organization
       AND g.subject_kind='metrics_normalization' AND g.subject_id=subject AND g.status IN('pending','escalated')))))
$$;
CREATE OR REPLACE FUNCTION public.saas_metrics_normalization_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  actor_org uuid;
  live boolean;
  prior_digest text;
  new_digest text;
BEGIN
  IF TG_OP='DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'saas normalization requests are durable audit and cannot be deleted; cancel the request instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Actor identities are validated against the subject: the requester and
  -- the approver must belong to the requesting organization.
  IF NEW.requested_by IS NOT NULL THEN
    SELECT org_id INTO actor_org FROM public.users WHERE id = NEW.requested_by;
    IF actor_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'saas normalization requester must be a user of the requesting organization; choose a requester in this organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.approved_by IS NOT NULL THEN
    SELECT org_id INTO actor_org FROM public.users WHERE id = NEW.approved_by;
    IF actor_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'saas normalization approver must be a user of the requesting organization; choose an approver in this organization'
        USING ERRCODE = 'check_violation';
    END IF;

  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'new saas normalization requests start as pending; claim the pending request to begin work'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'saas normalization approval is recorded by updating the pending request, not at insert; insert without approver, then record approval'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_heartbeat_at IS NOT NULL THEN
      RAISE EXCEPTION 'new saas normalization requests hold no lease; claim the pending request to take a lease token'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> 0 THEN
      RAISE EXCEPTION 'new saas normalization requests start at attempt zero; claims pending attempts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'new saas normalization requests carry no outcome; finalize a running claim to record one'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_requested',
      jsonb_build_object('event', 'saas_normalization_requested', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', 0,
        'statusBefore', NULL, 'statusAfter', NEW.status,
        'priorLeaseDigest', NULL, 'newLeaseDigest', NULL,
        'actor', NEW.requested_by, 'reason', NEW.reason),
      NEW.requested_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Request identity is immutable; a new month or idempotency key is a new request.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'saas normalization request identity (organization, month, idempotency key, request hash, requester) is immutable; file a new request instead'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The approver is immutable once recorded; the approval timestamp follows it.
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'saas normalization approver is immutable once recorded; the recorded approval stands'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'saas normalization approval time is immutable once recorded; the recorded approval stands'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.approved_by IS NULL) <> (NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'saas normalization approval needs both approver and approval time; record them together on the pending request'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Terminal rows are immutable; further work is a new request.
  IF OLD.status IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'saas normalization requests in terminal state % are immutable; file a new request for further work', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Liveness: the presented token must equal the stored live token and the
  -- stored lease must not have expired. Every later mutation and
  -- finalization funnels through this flag.
  live := OLD.lease_token IS NOT NULL
          AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
          AND OLD.lease_expires_at IS NOT NULL
          AND OLD.lease_expires_at > now();
  prior_digest := CASE WHEN OLD.lease_token IS NULL THEN NULL
    ELSE 'sha256:' || encode(public.digest(convert_to(OLD.lease_token::text, 'UTF8'), 'sha256'), 'hex') END;
  new_digest := CASE WHEN NEW.lease_token IS NULL THEN NULL
    ELSE 'sha256:' || encode(public.digest(convert_to(NEW.lease_token::text, 'UTF8'), 'sha256'), 'hex') END;

  IF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL
    AND NOT public.normalization_request_flow_authorized(NEW.org_id,NEW.id,NEW.approved_by,'approved') THEN
   RAISE EXCEPTION 'Complete native tenant Flow routing before releasing the correction.' USING ERRCODE='23514';
  END IF;

  -- Pending rows change only by recording approval, claiming, or cancelling.
  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF NEW.lease_token IS DISTINCT FROM OLD.lease_token
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL
       OR NEW.progress IS DISTINCT FROM OLD.progress THEN
      RAISE EXCEPTION 'pending saas normalization requests change only by recording approval, claiming to running, or cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    IF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL THEN
      INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_approved',
        jsonb_build_object('event', 'saas_normalization_approved', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', NEW.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'actor', NEW.approved_by, 'reason', NEW.reason),
        NEW.approved_by, NEW.idempotency_key::text);
    END IF;
    RETURN NEW;
  END IF;

  -- First claim: pending to running opens attempt one with a fresh live lease.
  -- Execution requires a recorded approval and a presented transition actor.
  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'claiming a saas normalization request requires a recorded approval; record approver and approval time on the pending request, then claim'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM NEW.approved_by THEN
      RAISE EXCEPTION 'claiming a saas normalization request requires the approver as the acting user; record the approver as updated_by when claiming'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'claiming a saas normalization request needs a fresh lease token with a future expiry; generate a token and claim again'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'claiming a saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a claimed saas normalization request carries no outcome yet; finalize after work completes'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_claimed',
      jsonb_build_object('event', 'saas_normalization_claimed', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.requested_by AND NOT public.normalization_request_flow_authorized(NEW.org_id,NEW.id,NEW.updated_by,'rejected') THEN
      RAISE EXCEPTION 'cancelling a pending saas normalization request requires the requester as the acting user; record the requester as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'cancelling an unclaimed saas normalization request takes no lease; cancel without lease fields'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Running to running: either a live heartbeat under the live token, or a
  -- stale reacquisition after expiry. Heartbeats manufacture no audit event.
  IF OLD.status = 'running' AND NEW.status = 'running' THEN
    IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
      IF OLD.lease_expires_at IS NULL OR OLD.lease_expires_at > now() THEN
        RAISE EXCEPTION 'saas normalization lease is still live; heartbeat with the live token, or wait for expiry and reacquire'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request requires the approver as the acting user; record the approver as updated_by when reacquiring'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request needs a fresh lease token with a future expiry; generate a token and reacquire'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
        RAISE EXCEPTION 'a reacquired saas normalization request carries no outcome yet; finalize after work completes'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.last_heartbeat_at := now();
      NEW.updated_at := now();
      INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_abandoned',
        jsonb_build_object('event', 'saas_normalization_abandoned', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', OLD.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
          'actor', NEW.updated_by, 'reason', NEW.reason),
        NEW.updated_by, NEW.idempotency_key::text),
        (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_reacquired',
        jsonb_build_object('event', 'saas_normalization_reacquired', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', NEW.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
          'actor', NEW.updated_by, 'reason', NEW.reason),
        NEW.updated_by, NEW.idempotency_key::text);
      RETURN NEW;
    END IF;
    IF OLD.lease_expires_at IS NULL OR OLD.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'saas normalization lease has expired; reacquire with a fresh token before further heartbeats'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'saas normalization heartbeat requires the approver as the acting user; record the approver as updated_by when heartbeating'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'heartbeats open no new attempts; keep attempt_count at % or reacquire after expiry', OLD.attempt_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_expires_at < OLD.lease_expires_at THEN
      RAISE EXCEPTION 'heartbeats may extend the saas normalization lease expiry, never shorten it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'running saas normalization requests carry progress only; finalize to record an outcome'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Finalization under the live lease token: exactly one terminal event.
  IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed') THEN
    IF NOT live THEN
      RAISE EXCEPTION 'finalizing a saas normalization request requires the live lease token; heartbeat or reacquire first, then finalize'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'finalizing a saas normalization request requires the approver as the acting user; record the approver as updated_by when finalizing'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'finalization closes the current attempt; keep attempt_count at %', OLD.attempt_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'succeeded' THEN
      IF NEW.result IS NULL THEN
        RAISE EXCEPTION 'a succeeded saas normalization must store its result; include the result document'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
        RAISE EXCEPTION 'a succeeded saas normalization carries a result, not a failure; clear failure and remedy'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW.failure IS NULL OR btrim(NEW.failure) = '' THEN
        RAISE EXCEPTION 'a failed saas normalization must name the failure; describe what went wrong'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.remedy IS NULL OR btrim(NEW.remedy) = '' THEN
        RAISE EXCEPTION 'a failed saas normalization must name the remedy; record how the operator recovers'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.result IS NOT NULL THEN
        RAISE EXCEPTION 'a failed saas normalization carries failure and remedy, not a result; clear the result'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id,
      CASE WHEN NEW.status = 'succeeded' THEN 'saas_normalization_succeeded' ELSE 'saas_normalization_failed' END,
      jsonb_build_object('event', CASE WHEN NEW.status = 'succeeded' THEN 'saas_normalization_succeeded' ELSE 'saas_normalization_failed' END,
        'requestId', NEW.id, 'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'cancelled' THEN
    IF NOT live THEN
      RAISE EXCEPTION 'cancelling a running saas normalization request requires the live lease token; heartbeat or reacquire first'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'cancelling a running saas normalization request requires the approver as the acting user; record the approver as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Retry from failure re-enters the lifecycle with a fresh live lease.
  IF OLD.status = 'failed' AND NEW.status = 'running' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request requires the approver as the acting user; record the approver as updated_by when retrying'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request needs a fresh lease token with a future expiry; generate a token and retry'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a retried saas normalization request starts clear; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_retried',
      jsonb_build_object('event', 'saas_normalization_retried', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'failed' AND NEW.status = 'cancelled' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'cancelling a failed saas normalization request requires the approver as the acting user; record the approver as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'saas normalization requests move pending to running to succeeded, failed or cancelled, and failed may retry to running; % to % is not a legal transition', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END
$fn$;


ALTER TABLE hrm_offers ADD COLUMN approval_status text NOT NULL DEFAULT 'none'
 CHECK(approval_status IN('none','pending','approved','rejected')),
 ADD COLUMN approval_version integer,
 ADD COLUMN submitted_by uuid,
 ADD COLUMN submission_policy jsonb,
 ADD CONSTRAINT recruiting_offer_submitter_owned FOREIGN KEY(submitted_by) REFERENCES users(id);
CREATE FUNCTION public.offer_approval_fingerprint(offer public.hrm_offers) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(offer.id,offer.org_id,offer.application_id,offer.employer_subsidiary_id,
   offer.position_id,offer.department_id,offer.job_title,offer.employment_kind,offer.proposed_start_on::text,
   offer.compensation_amount::text,offer.compensation_currency,offer.compensation_basis,offer.expires_on::text,
   offer.version,offer.rendered_file_id,(SELECT v.payload FROM public.hrm_offer_versions v
    WHERE v.org_id=offer.org_id AND v.offer_id=offer.id AND v.version=offer.version))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.recruiting_offer_flow_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE fingerprint text;
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approval_status<>'none' OR NEW.submission_policy IS NOT NULL THEN
   RAISE EXCEPTION 'Create draft offer terms before submission through Flows.';
  END IF;
  RETURN NEW;
 END IF;
 fingerprint:=public.offer_approval_fingerprint(NEW);
 IF NEW.approval_status='none' AND OLD.approval_status<>'none' THEN
  IF NEW.status<>'draft' OR NEW.submission_policy IS NOT NULL OR NEW.approval_version IS NOT NULL
   OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='recruiting_offer'
    AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Cancel outstanding offer gates before replacing submitted terms.';
  END IF;
 ELSIF NEW.submission_policy IS DISTINCT FROM OLD.submission_policy THEN
  IF NEW.submitted_by IS NULL OR OLD.approval_status NOT IN('none','rejected')
    OR NEW.status<>'draft' OR NEW.approval_version IS DISTINCT FROM NEW.version
    OR NOT public.flow_submission_policy_valid(NEW.org_id,'recruiting_offer',NEW.id,NEW.submitted_by,NEW.submission_policy)
    OR NOT EXISTS(SELECT 1 FROM public.flow_submissions f WHERE f.org_id=NEW.org_id AND f.subject_kind='recruiting_offer'
      AND f.subject_id=NEW.id AND f.actor_id=NEW.submitted_by AND f.policy=NEW.submission_policy
      AND f.context->>'approvalFingerprint'=fingerprint) THEN
   RAISE EXCEPTION 'Submit the exact current offer version through native Flow routing.';
  END IF;
 END IF;
 IF OLD.approval_status IN('pending','approved') AND NEW.approval_status<>'none'
   AND public.offer_approval_fingerprint(OLD) IS DISTINCT FROM fingerprint THEN
  RAISE EXCEPTION 'Submitted offer terms are immutable; render and submit a new version.';
 END IF;
 IF NEW.approval_status IN('approved','rejected') AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
  IF NEW.approval_version IS DISTINCT FROM NEW.version OR NEW.submission_policy IS NULL THEN
   RAISE EXCEPTION 'The decision must name the submitted offer version.';
  END IF;
  IF NEW.approval_status='approved' AND NEW.submission_policy->>'kind'='ungated'
   AND public.flow_ungated_submission_authorized(NEW.org_id,'recruiting_offer',NEW.id,NEW.updated_by,
     jsonb_build_object('approvalFingerprint',fingerprint)) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='recruiting_offer' AND g.subject_id=NEW.id
      AND NEW.submission_policy->'runIds' ? r.id::text AND g.status=NEW.approval_status AND g.decided_by=NEW.updated_by
      AND r.context->>'approvalFingerprint'=fingerprint
      AND (NEW.updated_by IS DISTINCT FROM NEW.submitted_by OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
         WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate'
          AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb)))
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='recruiting_offer'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete the configured offer Flow gates before releasing these terms.';
  END IF;
 END IF;
 IF NEW.status='sent' AND OLD.status='draft' AND (NEW.approval_status<>'approved' OR NEW.approval_version IS DISTINCT FROM NEW.version) THEN
  RAISE EXCEPTION 'Release this offer version through Flows before issuance.';
 END IF;
 IF NEW.signature_status='sent' AND OLD.signature_status IS DISTINCT FROM 'sent' AND NEW.status<>'sent' THEN
  RAISE EXCEPTION 'Release the offer before issuing its signing link.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recruiting_offer_flow_admission_guard BEFORE INSERT OR UPDATE ON hrm_offers
 FOR EACH ROW EXECUTE FUNCTION public.recruiting_offer_flow_admission_guard();

CREATE FUNCTION public.flow_command_record_fingerprint(record jsonb,dependencies jsonb DEFAULT NULL) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(((record-ARRAY['status','lifecycle','approval_status','updated_at','updated_by',
   'approved_at','approved_by','submitted_at','submitted_by'])||jsonb_build_object('dependencies',dependencies))::text,'UTF8')),'hex')
$$;
CREATE FUNCTION public.flow_submission_approved(organization uuid,kind text,subject uuid,submission uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind
  AND s.subject_id=subject AND s.id=submission AND s.policy->>'kind'='gated'
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
CREATE FUNCTION public.flow_subject_decision_authorized(organization uuid,kind text,subject uuid,actor uuid,fingerprint text,outcome text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind AND s.subject_id=subject
  AND s.context->>'approvalFingerprint'=fingerprint
  AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
    AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))
  AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind AND g.subject_id=s.subject_id AND g.status IN('pending','escalated'))
  AND ((outcome='approved' AND s.policy->>'kind'='ungated' AND public.flow_ungated_submission_authorized(s.org_id,s.subject_kind,s.subject_id,actor))
   OR (s.policy->>'kind'='gated' AND (outcome='rejected' OR outcome='approved' AND public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id))
    AND EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
     WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind AND g.subject_id=s.subject_id AND s.policy->'runIds' ? r.id::text
       AND g.status=outcome AND g.decided_by=actor AND r.status IN('waiting','completed') AND r.error IS NULL
       AND (actor<>s.actor_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
        WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate' AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb))))))
$$;
CREATE FUNCTION public.flow_command_authorized(organization uuid,kind text,subject uuid,actor uuid,fingerprint text,expected_command jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=organization AND s.subject_kind=kind AND s.subject_id=subject
   AND s.context->>'approvalFingerprint'=fingerprint AND (expected_command IS NULL OR s.context->'command' @> expected_command)
   AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
     AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))
   AND NOT EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind
     AND g.subject_id=s.subject_id AND g.status IN('pending','escalated'))
   AND ((s.policy->>'kind'='ungated' AND public.flow_ungated_submission_authorized(s.org_id,s.subject_kind,s.subject_id,actor))
    OR (s.policy->>'kind'='gated' AND public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id) AND EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
      WHERE g.org_id=s.org_id AND g.subject_kind=s.subject_kind AND g.subject_id=s.subject_id AND s.policy->'runIds' ? r.id::text
        AND g.status='approved' AND g.decided_by=actor AND r.context->>'approvalFingerprint'=fingerprint
        AND (actor<>s.actor_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.context->'submissionPolicy'->'graph'->'nodes') node
          WHERE node->>'id'=g.node_id AND node->'data'->>'kind'='gate' AND node->'data'->'gate'->'preventSelfApproval'='false'::jsonb))))))
$$;
CREATE FUNCTION public.subcontract_change_approval_dependencies(organization uuid,subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('subcontract',to_jsonb(s),
  'schedule',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM subcontract_sov_lines l WHERE l.org_id=s.org_id AND l.subcontract_id=s.id),
  'applications',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM vendor_pay_applications a WHERE a.org_id=s.org_id AND a.subcontract_id=s.id),
  'applicationLines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM vendor_pay_application_lines l JOIN vendor_pay_applications a ON a.org_id=l.org_id AND a.id=l.pay_application_id WHERE a.org_id=s.org_id AND a.subcontract_id=s.id))
 FROM subcontracts s WHERE s.org_id=organization AND s.id=subject
$$;
CREATE FUNCTION public.reconciliation_approval_dependencies(organization uuid,subject uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('account',to_jsonb(a),
  'matches',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM reconciliation_matches m WHERE m.org_id=r.org_id AND m.reconciliation_id=r.id),
  'statements',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM bank_statements s WHERE s.org_id=r.org_id AND s.account_id=r.account_id AND s.statement_date<=r.through_date),
  'statementLines',(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM bank_statement_lines l WHERE l.org_id=r.org_id AND l.account_id=r.account_id AND l.posted_on<=r.through_date),
  'sourceState',(SELECT to_jsonb(state)-'observed_at' FROM source_reconciliation_state state WHERE state.org_id=r.org_id AND state.account_id=r.account_id),
  'journals',(SELECT coalesce(jsonb_agg(jsonb_build_object('line',to_jsonb(l)-ARRAY['reconciled_at','reconciliation_id'],'entry',to_jsonb(j)) ORDER BY l.id),'[]'::jsonb) FROM journal_lines l JOIN journal_entries j ON j.org_id=l.org_id AND j.id=l.entry_id WHERE l.org_id=r.org_id AND l.account_id=r.account_id AND j.posting_date<=r.through_date))
 FROM reconciliations r JOIN accounts a ON a.org_id=r.org_id AND a.id=r.account_id WHERE r.org_id=organization AND r.id=subject
$$;
CREATE FUNCTION public.native_command_approval_guard() RETURNS trigger
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
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON rebate_agreements FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('rebate_agreement','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON rebate_claims FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('rebate_claim','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON subcontracts FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('subcontract','active');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON subcontract_change_orders FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('subcontract_change_order','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON vendor_pay_applications FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('vendor_pay_application','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON pay_applications FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('customer_pay_application','approved');

-- Replace the independent-checker clauses while preserving the original complete-stamp and lifecycle checks.
DO $$ DECLARE c record; expression text; BEGIN
 FOR c IN SELECT conrelid,conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
  WHERE conrelid IN('public.rebate_agreements'::regclass,'public.rebate_claims'::regclass) AND contype='c'
    AND pg_get_expr(conbin,conrelid) LIKE '%approved_by <> created_by%'
 LOOP
  expression:=replace(c.expression,'(approved_by <> created_by)','true');
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.conrelid::regclass,c.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK(%s)',c.conrelid::regclass,c.conname,expression);
 END LOOP;
END $$;

CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON hrm_headcount_plan_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('headcount_plan_line','approved|opened');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON hrm_headcount_plans FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('headcount_plan','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON hrm_comp_cycle_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('compensation_cycle_line','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON hrm_per_diem_entries FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('per_diem_entry','approved');
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON hrm_travel_pay_entries FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('travel_pay_entry','approved');
ALTER TABLE change_sets DROP CONSTRAINT change_sets_actor_separation;
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON change_sets FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('sandbox_change_set','approved');

CREATE FUNCTION public.compensation_cycle_approval_fingerprint(c public.hrm_comp_cycles) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT public.flow_command_record_fingerprint(to_jsonb(c)-ARRAY['revision','flow_run_id'],
  (SELECT coalesce(jsonb_agg(to_jsonb(l)-ARRAY['status','revision','decided_at','approver_party_id','updated_at','updated_by','reason'] ORDER BY l.id),'[]'::jsonb)
   FROM public.hrm_comp_cycle_lines l WHERE l.org_id=c.org_id AND l.cycle_id=c.id))
$$;
CREATE FUNCTION public.compensation_cycle_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status='approved' THEN RAISE EXCEPTION 'Create the compensation round before submission through Flows.'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'approved' AND NEW.status='approved' AND NOT public.flow_command_authorized(NEW.org_id,'hrm_comp_cycle',NEW.id,NEW.updated_by,public.compensation_cycle_approval_fingerprint(OLD)) THEN
  RAISE EXCEPTION 'Release the compensation round through its complete native Flow submission.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER compensation_cycle_flow_guard BEFORE INSERT OR UPDATE ON hrm_comp_cycles FOR EACH ROW EXECUTE FUNCTION public.compensation_cycle_flow_guard();

CREATE FUNCTION public.financial_change_flow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD.status='pending' AND NEW.status IN('approved','rejected') THEN
  IF NEW.status='approved' AND NEW.submission_policy->>'kind'='ungated' AND NEW.approved_by=NEW.submitted_by
   AND public.flow_ungated_submission_authorized(NEW.org_id,'financial_change',NEW.id,NEW.approved_by) THEN RETURN NEW; END IF;
  IF NEW.submission_policy IS NULL OR NOT EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind='financial_change' AND g.subject_id=NEW.id
      AND NEW.submission_policy->'runIds' ? r.id::text AND g.status=NEW.status AND g.decided_by=NEW.approved_by
      AND r.context->'submissionPolicy'->>'flowId'=r.flow_id::text)
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='financial_change'
      AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete every configured accounting-event Flow gate before deciding the proposal.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_change_flow_decision_guard BEFORE UPDATE ON financial_changes FOR EACH ROW EXECUTE FUNCTION public.financial_change_flow_decision_guard();

CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON change_orders FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('customer_change_order','approved');
CREATE FUNCTION public.compliance_waiver_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL THEN RAISE EXCEPTION 'File the exception before submitting it through Flows.'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.approved_at IS NOT NULL AND (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revoke_reason','updated_at','updated_by']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revoke_reason','updated_at','updated_by']) THEN
  RAISE EXCEPTION 'An effective compliance exception is immutable; revoke it with a reason and submit a new exception.';
 END IF;
 IF OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL AND NOT public.flow_command_authorized(NEW.org_id,'compliance_waiver',NEW.id,NEW.approved_by,public.flow_command_record_fingerprint(to_jsonb(OLD))) THEN
  RAISE EXCEPTION 'Release this exception through its complete native Flow submission.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER compliance_waiver_flow_guard BEFORE INSERT OR UPDATE ON compliance_waivers FOR EACH ROW EXECUTE FUNCTION public.compliance_waiver_flow_guard();

CREATE FUNCTION public.native_command_pending_terms_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $pending$
DECLARE before_row jsonb; after_row jsonb; candidate jsonb; subject_key uuid; organization uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND (after_row-ARRAY['updated_at','updated_by']) IS NOT DISTINCT FROM
   (before_row-ARRAY['updated_at','updated_by']) THEN RETURN NEW; END IF;
 -- Both old and new ownership matter when a child is moved between parents.
 FOR candidate IN SELECT value FROM jsonb_array_elements(jsonb_build_array(before_row,after_row)) WHERE value<>'null'::jsonb LOOP
  organization:=(candidate->>'org_id')::uuid;
  subject_key:=coalesce((candidate->>nullif(TG_ARGV[1],''))::uuid,(candidate->>'id')::uuid);
  IF EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=organization AND g.subject_kind=ANY(string_to_array(TG_ARGV[0],'|')) AND g.subject_id=subject_key
      AND r.context ? 'command' AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Recall the pending native Flow submission before changing these terms.';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
$pending$;
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON rebate_agreements FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('customer_rebate_agreement|vendor_rebate_agreement','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON rebate_claims FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('customer_rebate_claim|vendor_rebate_claim','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON subcontracts FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('subcontract','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON subcontract_sov_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('subcontract','subcontract_id');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON subcontract_change_orders FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('subcontract_change_order','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON vendor_pay_applications FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('vendor_pay_application','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON vendor_pay_application_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('vendor_pay_application','pay_application_id');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON pay_applications FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('customer_pay_application','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON pay_application_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('customer_pay_application','pay_application_id');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON change_orders FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('customer_change_order','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_headcount_plans FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('headcount_plan','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_headcount_plan_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('headcount_plan_line','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_comp_cycle_lines FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('compensation_cycle_line','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_per_diem_entries FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('per_diem_entry','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_travel_pay_entries FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('travel_pay_entry','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON change_sets FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('sandbox_change_set','');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON change_set_items FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('sandbox_change_set','change_set_id');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON compliance_waivers FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('compliance_waiver','');


CREATE FUNCTION public.compliance_certificate_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.verified_at IS NOT NULL OR NEW.verified_by IS NOT NULL OR NEW.verified_revision IS NOT NULL THEN
   RAISE EXCEPTION 'Record the certificate before submitting verification through Flows.';
  END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.verified_at,NEW.verified_by,NEW.verified_revision) IS DISTINCT FROM ROW(OLD.verified_at,OLD.verified_by,OLD.verified_revision)
  AND NEW.verified_at IS NOT NULL THEN
  IF NEW.status<>'active' OR NEW.verified_revision IS DISTINCT FROM OLD.revision OR NEW.revision<>OLD.revision+1
    OR (to_jsonb(NEW)-ARRAY['status','verified_at','verified_by','verified_revision','revision','rejected_reason','updated_at','updated_by'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','verified_at','verified_by','verified_revision','revision','rejected_reason','updated_at','updated_by'])
    OR NOT public.flow_command_authorized(NEW.org_id,'compliance_certificate',NEW.id,NEW.verified_by,
      public.flow_command_record_fingerprint(to_jsonb(OLD)),jsonb_build_object('revision',OLD.revision)) THEN
   RAISE EXCEPTION 'Verify this exact certificate revision through its native Flow submission.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER compliance_certificate_flow_guard BEFORE INSERT OR UPDATE ON compliance_records
 FOR EACH ROW EXECUTE FUNCTION public.compliance_certificate_flow_guard();
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON compliance_records
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('compliance_certificate','');

CREATE FUNCTION public.crew_time_batch_approval_fingerprint(b public.crew_time_batches) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT public.flow_command_record_fingerprint(to_jsonb(b),(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb)
  FROM public.crew_time_batch_lines l WHERE l.org_id=b.org_id AND l.batch_id=b.id))
$$;
CREATE FUNCTION public.crew_time_batch_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status IN('approved','posted','rejected') THEN RAISE EXCEPTION 'Create a draft crew batch before native submission.'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='submitted' AND NEW.status IN('approved','rejected') THEN
  IF (to_jsonb(NEW)-ARRAY['status','submitted_at','updated_at','updated_by']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','submitted_at','updated_at','updated_by']) THEN
   RAISE EXCEPTION 'A crew decision cannot replace submitted hours, project or signature evidence.';
  END IF;
  IF NEW.status='approved' AND public.flow_ungated_submission_authorized(NEW.org_id,'crew_time_batch',NEW.id,NEW.updated_by,
    jsonb_build_object('approvalFingerprint',public.crew_time_batch_approval_fingerprint(OLD))) THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.flow_submissions s JOIN public.flow_runs r ON r.org_id=s.org_id AND s.policy->'runIds' ? r.id::text
    JOIN public.flow_gates g ON g.org_id=r.org_id AND g.run_id=r.id
    WHERE s.org_id=NEW.org_id AND s.subject_kind='crew_time_batch' AND s.subject_id=NEW.id
      AND s.context->>'approvalFingerprint'=public.crew_time_batch_approval_fingerprint(OLD)
      AND g.status=NEW.status AND g.decided_by=NEW.updated_by AND r.status IN('waiting','completed') AND r.error IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
        AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))
      AND (NEW.status='rejected' OR public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id)))
    OR EXISTS(SELECT 1 FROM public.flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='crew_time_batch'
       AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
   RAISE EXCEPTION 'Complete the current crew batch Flow submission before deciding it.';
  END IF;
 ELSIF OLD.status='draft' AND NEW.status IN('approved','posted','rejected') THEN
  RAISE EXCEPTION 'Submit the crew batch through Flows before release.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crew_time_batch_flow_guard BEFORE INSERT OR UPDATE ON crew_time_batches
 FOR EACH ROW EXECUTE FUNCTION public.crew_time_batch_flow_guard();


CREATE FUNCTION public.leave_request_approval_fingerprint(r public.hrm_leave_requests) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT public.flow_command_record_fingerprint(to_jsonb(r)-ARRAY['flow_instance_id','decided_by','decided_at','decision_reason'])
$$;
CREATE FUNCTION public.resourcing_request_approval_fingerprint(r public.res_requests) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT public.flow_command_record_fingerprint(to_jsonb(r)-ARRAY['flow_instance_id','decided_by','decided_at','decision_comment'])
$$;
CREATE FUNCTION public.native_request_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE kind text:=TG_ARGV[0];fingerprint text; allowed text[]:=ARRAY['status','flow_instance_id','decided_by','decided_at','decision_reason','decision_comment','updated_at','updated_by'];
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'File a draft request before native submission.'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'draft' AND (to_jsonb(NEW)-allowed) IS DISTINCT FROM (to_jsonb(OLD)-allowed) THEN
  RAISE EXCEPTION 'Submitted request terms are immutable. Cancel or withdraw the request and file the replacement.';
 END IF;
 IF kind='hrm_leave_request' THEN fingerprint:=public.flow_command_record_fingerprint(to_jsonb(OLD)-ARRAY['flow_instance_id','decided_by','decided_at','decision_reason']);
 ELSE fingerprint:=public.flow_command_record_fingerprint(to_jsonb(OLD)-ARRAY['flow_instance_id','decided_by','decided_at','decision_comment']); END IF;
 IF OLD.status='draft' AND NEW.status='submitted' THEN
  IF NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind=kind AND s.subject_id=NEW.id
    AND s.actor_id=NEW.updated_by AND s.context->>'approvalFingerprint'=fingerprint
    AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
      AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))) THEN
   RAISE EXCEPTION 'Submit the exact request through native Flow routing.';
  END IF;
 END IF;
 IF NEW.status IN('approved','rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF OLD.status<>'submitted' OR NOT public.flow_subject_decision_authorized(NEW.org_id,kind,NEW.id,NEW.updated_by,fingerprint,NEW.status) THEN
   RAISE EXCEPTION 'Complete this request through its current native Flow submission.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_request_flow_guard BEFORE INSERT OR UPDATE ON hrm_leave_requests FOR EACH ROW EXECUTE FUNCTION public.native_request_flow_guard('hrm_leave_request');
CREATE TRIGGER native_request_flow_guard BEFORE INSERT OR UPDATE ON res_requests FOR EACH ROW EXECUTE FUNCTION public.native_request_flow_guard('resourcing_request');


CREATE FUNCTION public.employment_mapping_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create the exact mapping subject before native submission.'; END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.mapping_digest,NEW.org_id,NEW.id,NEW.requested_by,NEW.created_by) IS DISTINCT FROM ROW(OLD.mapping_digest,OLD.org_id,OLD.id,OLD.requested_by,OLD.created_by) THEN
  RAISE EXCEPTION 'A mapping submission identity and exact mapping digest are immutable.';
 END IF;
 IF NEW.status IN('approved','rejected','pending_approval') AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF NOT EXISTS(SELECT 1 FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind='hrm_employment_migration_mapping' AND s.subject_id=NEW.id
    AND s.context->>'mappingDigest'=NEW.mapping_digest
    AND NOT EXISTS(SELECT 1 FROM public.flow_submissions newer WHERE newer.org_id=s.org_id AND newer.subject_kind=s.subject_kind
      AND newer.subject_id=s.subject_id AND (newer.created_at,newer.id)>(s.created_at,s.id))
    AND ((OLD.status='draft' AND NEW.status='pending_approval' AND s.policy->>'kind'='gated' AND s.actor_id=NEW.updated_by)
      OR (OLD.status='draft' AND NEW.status='approved' AND public.flow_ungated_submission_authorized(s.org_id,s.subject_kind,s.subject_id,NEW.updated_by))
      OR (OLD.status='pending_approval' AND EXISTS(SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
        WHERE g.org_id=s.org_id AND s.policy->'runIds' ? r.id::text AND g.status=NEW.status AND g.decided_by=NEW.updated_by
          AND r.status IN('waiting','completed') AND r.error IS NULL AND (NEW.status='rejected' OR public.flow_submission_approved(s.org_id,s.subject_kind,s.subject_id,s.id)))))) THEN
   RAISE EXCEPTION 'Release this exact mapping set through its current native Flow submission.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employment_mapping_flow_guard BEFORE INSERT OR UPDATE ON hrm_employment_migration_approvals
 FOR EACH ROW EXECUTE FUNCTION public.employment_mapping_flow_guard();

CREATE OR REPLACE FUNCTION public.benefit_clone_decision_evidence(evidence jsonb, seed uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $function$
DECLARE result jsonb:=evidence; identity_key text; entries_data jsonb;
BEGIN
 IF evidence IS NULL THEN RETURN NULL; END IF;
 FOREACH identity_key IN ARRAY ARRAY['planId','runId','submissionId'] LOOP
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
 IF jsonb_typeof(result->'policy')='object' THEN
  result:=jsonb_set(result,'{policy}',public.flow_clone_evidence(result->'policy',seed,'policy'));
 END IF;
 RETURN result;
END $function$;
CREATE TRIGGER native_command_approval_guard BEFORE INSERT OR UPDATE ON reconciliations
 FOR EACH ROW EXECUTE FUNCTION public.native_command_approval_guard('bank_reconciliation_sign_off','signed_off');
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON reconciliations
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('bank_reconciliation_sign_off|bank_reconciliation_review','');


CREATE OR REPLACE FUNCTION public.hrm_training_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE session_row public.hrm_training_sessions; course_row public.hrm_training_courses;
 author_person uuid; decision_person uuid; employer uuid; qualification_status text; passed boolean;
 validity integer; evidence_required boolean; qualification_issued date;
BEGIN
 IF TG_OP='DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Training history cannot be deleted; retire a course, cancel a session or void a participant outcome with a reason.';
 END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='hrm_training_feedback' THEN RAISE EXCEPTION 'Training feedback is immutable; append a corrected feedback entry with the previous entry as its predecessor.'; END IF;
  IF ROW(NEW.id,NEW.org_id,NEW.created_at,NEW.created_by,NEW.request_hash) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.created_at,OLD.created_by,OLD.request_hash) THEN
   RAISE EXCEPTION 'Training ownership and creation evidence are immutable; create a successor record.';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Training revision changed; reload the record before saving.'; END IF;
 END IF;
 IF TG_TABLE_NAME='hrm_training_courses' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create a course draft before submission through Flows.'; END IF;
   SELECT party_id INTO author_person FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by AND is_active;
   IF author_person IS NULL OR author_person IS DISTINCT FROM NEW.author_party_id THEN RAISE EXCEPTION 'Course authorship needs a native person identity; link the author to their person record before creating the course.'; END IF;
   IF NEW.qualification_type_id IS NOT NULL THEN
    SELECT validity_months,requires_evidence INTO validity,evidence_required FROM public.hrm_qualification_types WHERE org_id=NEW.org_id AND id=NEW.qualification_type_id AND is_active FOR SHARE;
    IF NOT FOUND OR NEW.qualification_validity_months IS DISTINCT FROM validity OR NEW.qualification_requires_evidence IS DISTINCT FROM evidence_required THEN
     RAISE EXCEPTION 'Qualification policy changed; reload the native qualification type before creating the course draft.';
    END IF;
   END IF;
  ELSE
   IF (to_jsonb(NEW)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'A course definition is immutable; create an effective-dated successor version.';
   END IF;
   IF NOT ((OLD.status='draft' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status='retired')) THEN
    RAISE EXCEPTION 'This course transition is unavailable; reload the course and choose an action for its current state.';
   END IF;
   IF NEW.status='approved' THEN
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by OR NOT public.flow_command_authorized(NEW.org_id,'training_course',NEW.id,NEW.decided_by,
      public.flow_command_record_fingerprint(to_jsonb(OLD)),jsonb_build_object('expectedRevision',OLD.revision,'reason',NEW.reason)) THEN
     RAISE EXCEPTION 'Release this course revision through its complete native tenant Flow submission.';
    END IF;
   ELSIF ROW(NEW.decided_by,NEW.decided_at) IS DISTINCT FROM ROW(OLD.decided_by,OLD.decided_at) THEN
    RAISE EXCEPTION 'Course approval evidence is immutable; create a successor course version.';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_training_sessions' THEN
  SELECT * INTO course_row FROM public.hrm_training_courses WHERE org_id=NEW.org_id AND id=NEW.course_id FOR SHARE;
  IF NOT FOUND OR course_row.subsidiary_id<>NEW.subsidiary_id THEN RAISE EXCEPTION 'The course is unavailable for this employer; select an approved course in this employer scope.'; END IF;
  IF NEW.starts_on<>(NEW.starts_at AT TIME ZONE NEW.time_zone)::date OR NEW.ends_on<>(NEW.ends_at AT TIME ZONE NEW.time_zone)::date THEN
   RAISE EXCEPTION 'Session dates do not match their time zone; choose exact session times again.';
  END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'draft' OR course_row.status<>'approved' OR NEW.starts_on<course_row.effective_from OR (course_row.effective_to IS NOT NULL AND NEW.ends_on>course_row.effective_to) THEN
    RAISE EXCEPTION 'Create a draft session within an approved course effective window; select a matching course version.';
   END IF;
  ELSE
   IF (to_jsonb(NEW)-ARRAY['status','revision','reason','updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','reason','updated_at','updated_by']) THEN
    RAISE EXCEPTION 'Session delivery details are immutable; cancel it and create a corrected session.';
   END IF;
   IF NOT ((OLD.status='draft' AND NEW.status IN ('scheduled','cancelled')) OR (OLD.status='scheduled' AND NEW.status IN ('in_progress','cancelled')) OR (OLD.status='in_progress' AND NEW.status IN ('completed','cancelled'))) THEN
    RAISE EXCEPTION 'This session transition is unavailable; reload the session and choose an action for its current state.';
   END IF;
   IF NEW.status='scheduled' AND course_row.status<>'approved' THEN RAISE EXCEPTION 'The course is retired; cancel this draft and create a session for an approved successor.'; END IF;
   IF NEW.status='in_progress' AND NEW.starts_at>now() THEN RAISE EXCEPTION 'The scheduled session has not started; start it at or after its recorded start time.'; END IF;
   IF NEW.status='completed' AND NEW.ends_at>now() THEN RAISE EXCEPTION 'The session has not ended; record final delivery after its recorded end time.'; END IF;
   IF NEW.status='completed' AND EXISTS(SELECT 1 FROM public.hrm_training_participants WHERE org_id=NEW.org_id AND session_id=NEW.id AND status IN ('invited','accepted')) THEN
    RAISE EXCEPTION 'Participant outcomes are unfinished; record each result or decline/cancel the invitation before closing the session.';
   END IF;
   IF NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM public.hrm_training_participants WHERE org_id=NEW.org_id AND session_id=NEW.id AND status IN ('completed','failed')) THEN
    RAISE EXCEPTION 'This session has no completed participant results; record a delivered result or cancel the unused session.';
   END IF;
   IF NEW.status='cancelled' AND EXISTS(SELECT 1 FROM public.hrm_training_participants WHERE org_id=NEW.org_id AND session_id=NEW.id AND status NOT IN ('declined','cancelled','voided')) THEN
    RAISE EXCEPTION 'Session participants still have active invitations or outcomes; cancel invitations and void outcomes before cancelling the session.';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_training_participants' THEN
  SELECT * INTO session_row FROM public.hrm_training_sessions WHERE org_id=NEW.org_id AND id=NEW.session_id FOR UPDATE;
  IF NOT FOUND OR session_row.subsidiary_id<>NEW.subsidiary_id THEN RAISE EXCEPTION 'The training session is unavailable; choose a visible employer session.'; END IF;
  SELECT employer_subsidiary_id INTO employer FROM public.worker_employments WHERE org_id=NEW.org_id AND id=NEW.employment_id FOR UPDATE;
  IF TG_OP='INSERT' OR NEW.status IN ('completed','failed') THEN
   IF employer IS DISTINCT FROM NEW.subsidiary_id THEN RAISE EXCEPTION 'The participant employment belongs to a different employer; choose an employment for the session employer.'; END IF;
   IF NOT EXISTS(SELECT employment_id FROM public.worker_employment_versions WHERE org_id=NEW.org_id AND employment_id=NEW.employment_id AND recorded_until IS NULL AND status IN ('active','on_leave')
    GROUP BY employment_id HAVING range_agg(daterange(effective_from,effective_to,'[)')) @> daterange(session_row.starts_on,session_row.ends_on,'[]')) THEN
    RAISE EXCEPTION 'Employment history does not cover the session; choose a covered session or record verified employment history through its native workflow.';
   END IF;
  END IF;
  SELECT * INTO course_row FROM public.hrm_training_courses WHERE org_id=NEW.org_id AND id=session_row.course_id FOR SHARE;
  IF NEW.qualification_type_id IS DISTINCT FROM course_row.qualification_type_id THEN RAISE EXCEPTION 'Participant qualification policy differs from its approved course; reload the course definition.'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'invited' OR session_row.status<>'scheduled' THEN RAISE EXCEPTION 'Schedule the session before inviting participants.'; END IF;
   IF (SELECT count(*) FROM public.hrm_training_participants WHERE org_id=NEW.org_id AND session_id=NEW.session_id AND status NOT IN ('declined','cancelled'))>=session_row.capacity THEN
    RAISE EXCEPTION 'The training session is full; choose another session or decline an unused invitation.';
   END IF;
  ELSE
   IF ROW(NEW.session_id,NEW.employment_id,NEW.subsidiary_id,NEW.qualification_type_id) IS DISTINCT FROM ROW(OLD.session_id,OLD.employment_id,OLD.subsidiary_id,OLD.qualification_type_id) THEN
    RAISE EXCEPTION 'Participant ownership is immutable; create a new invitation for the correct employment.';
   END IF;
   IF NOT ((OLD.status='invited' AND NEW.status IN ('accepted','declined','cancelled','completed','failed')) OR
    (OLD.status='accepted' AND NEW.status IN ('declined','cancelled','completed','failed')) OR
    (OLD.status IN ('completed','failed') AND NEW.status='voided')) THEN
    RAISE EXCEPTION 'This participant transition is unavailable; reload the participant and choose an action for its current state.';
   END IF;
   IF NEW.status IN ('completed','failed') THEN
    IF session_row.status<>'in_progress' THEN RAISE EXCEPTION 'Start the training session before recording participant results.'; END IF;
    IF session_row.ends_at>now() THEN RAISE EXCEPTION 'The session has not ended; record final attendance and assessment after its end time.'; END IF;
    IF NEW.attendance_seconds IS NULL OR NEW.attendance_seconds>session_row.duration_seconds OR
     ((course_row.passing_score IS NOT NULL)<>(NEW.score IS NOT NULL)) THEN RAISE EXCEPTION 'Attendance or assessment is incomplete; record valid attendance and the declared assessment score.'; END IF;
    passed := NEW.attendance_seconds::bigint*100>=session_row.duration_seconds::bigint*course_row.minimum_attendance_percent
     AND (course_row.passing_score IS NULL OR NEW.score>=course_row.passing_score);
    IF (NEW.status='completed')<>passed THEN RAISE EXCEPTION 'The outcome differs from the approved course thresholds; calculate the result from recorded attendance and assessment.'; END IF;
    IF NEW.status='completed' AND course_row.qualification_type_id IS NOT NULL AND NEW.qualification_id IS NULL THEN
     RAISE EXCEPTION 'A passing course outcome needs its native qualification evidence; record or link the matching qualification before completing.';
    END IF;
    IF NEW.qualification_id IS NOT NULL THEN
     SELECT issued_on,status INTO qualification_issued,qualification_status FROM public.hrm_worker_qualifications WHERE org_id=NEW.org_id AND id=NEW.qualification_id;
     IF qualification_issued IS DISTINCT FROM session_row.ends_on OR qualification_status='revoked' THEN RAISE EXCEPTION 'The qualification does not match the completion date or is revoked; choose matching non-revoked qualification evidence.'; END IF;
    END IF;
   ELSIF NEW.status='voided' THEN
    IF (to_jsonb(NEW)-ARRAY['status','revision','reason','updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','reason','updated_at','updated_by']) THEN
     RAISE EXCEPTION 'Training results are immutable; void the unchanged outcome with a reason.';
    END IF;
    IF NEW.qualification_created THEN
     SELECT status INTO qualification_status FROM public.hrm_worker_qualifications WHERE org_id=NEW.org_id AND id=NEW.qualification_id;
     IF qualification_status IS DISTINCT FROM 'revoked' THEN RAISE EXCEPTION 'The training-issued qualification is still active; revoke it with the same correction reason before voiding the outcome.'; END IF;
    END IF;
   ELSE
    IF ROW(NEW.attendance_seconds,NEW.score,NEW.evidence_file_id,NEW.notes,NEW.qualification_id,NEW.qualification_created,NEW.completion_hash) IS DISTINCT FROM
       ROW(OLD.attendance_seconds,OLD.score,OLD.evidence_file_id,OLD.notes,OLD.qualification_id,OLD.qualification_created,OLD.completion_hash) THEN
     RAISE EXCEPTION 'Invitation changes cannot rewrite a training result; use the participant completion action.';
    END IF;
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME='hrm_training_feedback' THEN
  IF NOT EXISTS(SELECT 1 FROM public.hrm_training_participants WHERE org_id=NEW.org_id AND id=NEW.participant_id AND status IN ('completed','failed')) THEN
   RAISE EXCEPTION 'Training feedback needs a completed participant result; complete the participant before recording feedback.';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER native_command_pending_terms_guard BEFORE UPDATE OR DELETE ON hrm_training_courses FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('training_course','');

CREATE TRIGGER headcount_plan_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON hrm_headcount_plan_lines
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('headcount_plan','plan_id');
CREATE TRIGGER native_command_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_matches
 FOR EACH ROW EXECUTE FUNCTION public.native_command_pending_terms_guard('bank_reconciliation_sign_off|bank_reconciliation_review','reconciliation_id');

-- Change-order evidence includes the subcontract's schedule and billed progress.
CREATE FUNCTION public.subcontract_change_pending_terms_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $pending$
DECLARE candidate jsonb; parent_id uuid; organization uuid;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 FOR candidate IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
   CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
   CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END)) WHERE value<>'null'::jsonb LOOP
  organization:=(candidate->>'org_id')::uuid;
  IF TG_TABLE_NAME='subcontracts' THEN parent_id:=(candidate->>'id')::uuid;
  ELSIF TG_TABLE_NAME='vendor_pay_application_lines' THEN
   SELECT subcontract_id INTO parent_id FROM vendor_pay_applications WHERE org_id=organization AND id=(candidate->>'pay_application_id')::uuid;
  ELSE parent_id:=(candidate->>'subcontract_id')::uuid; END IF;
  IF EXISTS(SELECT 1 FROM subcontract_change_orders c JOIN flow_gates g ON g.org_id=c.org_id AND g.subject_id=c.id
    JOIN flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE c.org_id=organization AND c.subcontract_id=parent_id AND g.subject_kind='subcontract_change_order'
      AND g.status IN('pending','escalated') AND r.context ? 'command') THEN
   RAISE EXCEPTION 'Recall the pending subcontract change order before changing its schedule or billed progress.';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END
$pending$;
CREATE TRIGGER subcontract_change_pending_terms_guard BEFORE UPDATE OR DELETE ON subcontracts FOR EACH ROW EXECUTE FUNCTION public.subcontract_change_pending_terms_guard();
CREATE TRIGGER subcontract_change_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON subcontract_sov_lines FOR EACH ROW EXECUTE FUNCTION public.subcontract_change_pending_terms_guard();
CREATE TRIGGER subcontract_change_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON vendor_pay_applications FOR EACH ROW EXECUTE FUNCTION public.subcontract_change_pending_terms_guard();
CREATE TRIGGER subcontract_change_pending_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON vendor_pay_application_lines FOR EACH ROW EXECUTE FUNCTION public.subcontract_change_pending_terms_guard();

CREATE OR REPLACE FUNCTION public.schedule_roster_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE entry_row public.schedule_entries; counterpart_row public.schedule_entries; board public.schedule_boards;
 pattern_row public.schedule_patterns; author_party uuid; allowed text[]; listed integer;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Roster history cannot be deleted; deactivate a pattern, end an assignment, revoke an exception or withdraw a request.' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME <> 'schedule_pattern_exceptions' THEN
  IF ROW(NEW.id, NEW.org_id, NEW.created_at, NEW.created_by) IS DISTINCT FROM ROW(OLD.id, OLD.org_id, OLD.created_at, OLD.created_by) THEN
   RAISE EXCEPTION 'Roster creation evidence is immutable; create a new record.' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
   RAISE EXCEPTION 'The roster record changed since it was loaded; reload it and try again.' USING ERRCODE = '40001';
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'schedule_publications' THEN
  SELECT * INTO board FROM public.schedule_boards WHERE org_id = NEW.org_id AND id = NEW.board_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'governed_publication') OR board.publish_policy <> 'governed' THEN
    RAISE EXCEPTION 'Publications are recorded for governed shift roster boards.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL OR NEW.released_without_approval OR NEW.flow_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'A new publication awaits its decision.' USING ERRCODE = '23514';
   END IF;
   SELECT count(*) INTO listed FROM public.schedule_entries x WHERE x.org_id = NEW.org_id AND x.board_id = NEW.board_id AND x.status = 'draft'
    AND x.id = ANY (NEW.entry_ids);
   IF listed <> cardinality(NEW.entry_ids) THEN
    RAISE EXCEPTION 'A publication names the board''s unpublished changes; reload the board.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','flow_run_id','released_without_approval','decided_by','decided_at','decision_reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'A publication keeps the changes it was submitted with; submit a new publication.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = OLD.status THEN
    IF NEW.status <> 'pending' OR OLD.flow_run_id IS NOT NULL OR NEW.decided_by IS NOT NULL OR NEW.released_without_approval THEN
     RAISE EXCEPTION 'Publication evidence is immutable.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NOT ((NEW.decided_by = NEW.updated_by AND NOT NEW.released_without_approval)
       OR (NEW.released_without_approval AND NEW.decided_by IS NULL AND OLD.flow_run_id IS NULL AND NEW.updated_by = OLD.created_by)) THEN
     RAISE EXCEPTION 'A publication is approved by its Flow decider, or released by its submitter when no approval Flow applies.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'declined' THEN
    IF NEW.decided_by IS DISTINCT FROM NEW.updated_by OR NEW.released_without_approval THEN
     RAISE EXCEPTION 'Decision evidence must name the decider.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status = 'withdrawn' THEN
    IF NEW.updated_by <> OLD.created_by OR NEW.decided_by IS NOT NULL
      OR EXISTS(SELECT 1 FROM flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind='schedule_publication' AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
     RAISE EXCEPTION 'Only the submitter withdraws a publication that no approval Flow owns.' USING ERRCODE = '23514';
    END IF;
   ELSE
    RAISE EXCEPTION 'This publication transition is unavailable; reload the board.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_patterns' THEN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
   RAISE EXCEPTION 'The pattern time zone is unknown; select a named time zone such as America/Toronto.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.code, NEW.subsidiary_id) IS DISTINCT FROM ROW(OLD.code, OLD.subsidiary_id) THEN
   RAISE EXCEPTION 'A pattern keeps its code and legal entity; create a new pattern instead.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_pattern_assignments' THEN
  SELECT * INTO board FROM public.schedule_boards WHERE org_id = NEW.org_id AND id = NEW.board_id FOR SHARE;
  SELECT * INTO pattern_row FROM public.schedule_patterns WHERE org_id = NEW.org_id AND id = NEW.pattern_id FOR SHARE;
  IF TG_OP = 'INSERT' THEN
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'patterns') OR NOT board.is_active OR NEW.status <> 'active' THEN
    RAISE EXCEPTION 'Assign recurring patterns on an active shift roster board.' USING ERRCODE = '23514';
   END IF;
   IF NOT pattern_row.is_active THEN
    RAISE EXCEPTION 'The pattern is inactive; reactivate it in Setup before assigning it.' USING ERRCODE = '23514';
   END IF;
   IF pattern_row.subsidiary_id IS NOT NULL AND NEW.subsidiary_id IS DISTINCT FROM pattern_row.subsidiary_id THEN
    RAISE EXCEPTION 'The pattern belongs to another legal entity; choose a pattern of the person''s legal entity.' USING ERRCODE = '23514';
   END IF;
   IF NEW.employment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.worker_employments e WHERE e.org_id = NEW.org_id
      AND e.id = NEW.employment_id AND e.worker_party_id = NEW.worker_party_id) THEN
    RAISE EXCEPTION 'The employment does not belong to this person; select the person again.' USING ERRCODE = '23514';
   END IF;
   IF NEW.generated_through IS NOT NULL THEN
    RAISE EXCEPTION 'A new assignment has not generated bookings yet.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','effective_to','generated_through','last_generation','reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'An assignment keeps its board, pattern, person and start; end it and create a new assignment.' USING ERRCODE = '23514';
   END IF;
   IF OLD.status <> 'active' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
    RAISE EXCEPTION 'An ended or cancelled assignment is history; create a new assignment.' USING ERRCODE = '23514';
   END IF;
   IF OLD.status = 'active' AND NEW.status = 'active' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'End the assignment to change its end date.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'ended' AND OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to THEN
    RAISE EXCEPTION 'An assignment can end earlier than planned, never later; create a new assignment to extend it.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = 'cancelled' AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'Cancelling keeps the assignment''s dates.' USING ERRCODE = '23514';
   END IF;
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_pattern_exceptions' THEN
  IF TG_OP = 'UPDATE' THEN
   IF to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','revoke_reason'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','revoke_reason']
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'A pattern exception is revoked once with its actor and reason; record a new exception instead.' USING ERRCODE = '23514';
   END IF;
  ELSIF NEW.revoked_at IS NOT NULL THEN
   RAISE EXCEPTION 'A new pattern exception is active.' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'schedule_entry_requests' THEN
  SELECT * INTO entry_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.entry_id FOR SHARE;
  IF NEW.counterpart_entry_id IS NOT NULL THEN
   SELECT * INTO counterpart_row FROM public.schedule_entries WHERE org_id = NEW.org_id AND id = NEW.counterpart_entry_id FOR SHARE;
  END IF;
  IF TG_OP = 'INSERT' THEN
   SELECT party_id INTO author_party FROM public.users WHERE org_id = NEW.org_id AND id = NEW.created_by AND is_active FOR SHARE;
   IF author_party IS NULL OR author_party <> NEW.worker_party_id THEN
    RAISE EXCEPTION 'A shift request is made by the scheduled person from their own schedule.' USING ERRCODE = '23514';
   END IF;
   IF NOT public.schedule_board_has_capability(NEW.org_id, NEW.board_id, 'shift_requests') THEN
    RAISE EXCEPTION 'Shift requests are made for shifts on shift roster boards; ask the scheduler to change this booking.' USING ERRCODE = '23514';
   END IF;
   IF entry_row.status <> 'published' OR entry_row.closed_at IS NOT NULL OR entry_row.revision <> NEW.entry_revision
      OR entry_row.worker_party_id IS DISTINCT FROM NEW.worker_party_id OR entry_row.board_id <> NEW.board_id OR entry_row.starts_at <= now() THEN
    RAISE EXCEPTION 'A shift request names a current published future booking of the requester; reload the schedule.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status <> (CASE WHEN NEW.kind = 'swap' THEN 'awaiting_counterpart' ELSE 'pending' END)
      OR NEW.decided_by IS NOT NULL OR NEW.counterpart_responded_by IS NOT NULL THEN
    RAISE EXCEPTION 'A new swap awaits the colleague''s answer; other requests await a decision.' USING ERRCODE = '23514';
   END IF;
   IF NEW.kind = 'swap' AND (counterpart_row.status <> 'published' OR counterpart_row.closed_at IS NOT NULL OR counterpart_row.revision <> NEW.counterpart_entry_revision
      OR counterpart_row.worker_party_id IS DISTINCT FROM NEW.counterpart_party_id OR counterpart_row.board_id <> NEW.board_id OR counterpart_row.starts_at <= now()) THEN
    RAISE EXCEPTION 'A swap names a colleague''s current published future booking on the same board; reload the schedule.' USING ERRCODE = '23514';
   END IF;
  ELSE
   allowed := ARRAY['status','counterpart_responded_by','counterpart_responded_at','flow_run_id','released_without_approval','decided_by','decided_at','decision_reason','revision','updated_at','updated_by'];
   IF to_jsonb(NEW) - allowed IS DISTINCT FROM to_jsonb(OLD) - allowed THEN
    RAISE EXCEPTION 'Shift request details are immutable; withdraw it and make a new request.' USING ERRCODE = '23514';
   END IF;
   IF NEW.status = OLD.status THEN
    IF ROW(NEW.counterpart_responded_by, NEW.decided_by, NEW.released_without_approval) IS DISTINCT FROM ROW(OLD.counterpart_responded_by, OLD.decided_by, OLD.released_without_approval)
       OR (OLD.flow_run_id IS NOT NULL AND NEW.flow_run_id IS DISTINCT FROM OLD.flow_run_id) THEN
     RAISE EXCEPTION 'Shift request evidence is immutable.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'awaiting_counterpart' AND NEW.status IN ('pending','declined') AND NEW.updated_by <> OLD.created_by THEN
    SELECT party_id INTO author_party FROM public.users WHERE org_id = NEW.org_id AND id = NEW.updated_by AND is_active FOR SHARE;
    IF author_party IS DISTINCT FROM NEW.counterpart_party_id THEN
     RAISE EXCEPTION 'Only the colleague named in a swap can accept or decline it.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'pending' AND (NEW.counterpart_responded_by IS DISTINCT FROM NEW.updated_by OR NEW.decided_by IS NOT NULL) THEN
     RAISE EXCEPTION 'Accepting a swap records the colleague''s answer and awaits a decision.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'declined' AND NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN
     RAISE EXCEPTION 'Declining a swap records the colleague as the decider.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status IN ('awaiting_counterpart','pending') AND NEW.status = 'withdrawn' THEN
    IF NEW.updated_by <> OLD.created_by OR NEW.decided_by IS NOT NULL THEN
     RAISE EXCEPTION 'Only the request author can withdraw it; a decider declines it instead.' USING ERRCODE = '23514';
    END IF;
   ELSIF OLD.status = 'pending' AND NEW.status IN ('approved','declined') THEN
    IF NOT ((NEW.decided_by = NEW.updated_by AND NOT NEW.released_without_approval)
       OR (NEW.status = 'approved' AND NEW.released_without_approval AND NEW.decided_by IS NULL AND OLD.flow_run_id IS NULL
           AND NEW.updated_by IN (OLD.created_by, coalesce(OLD.counterpart_responded_by, OLD.created_by)))) THEN
     RAISE EXCEPTION 'A shift request is decided through its approval Flow, or released by its submitter when no approval Flow applies.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'approved' AND (entry_row.status <> 'published' OR entry_row.revision <> OLD.entry_revision
       OR (OLD.kind = 'swap' AND (counterpart_row.status <> 'published' OR counterpart_row.revision <> OLD.counterpart_entry_revision))) THEN
     RAISE EXCEPTION 'The booking changed after the request was made; decline this request and ask for a new one.' USING ERRCODE = '23514';
    END IF;
   ELSE
    RAISE EXCEPTION 'This shift request transition is unavailable; reload the request.' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE FUNCTION public.schedule_flow_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE kind text:=TG_ARGV[0]; receipt public.flow_submissions; actor uuid;
BEGIN
 IF OLD.status<>'pending' OR NEW.status NOT IN('approved','declined') THEN RETURN NEW; END IF;
 SELECT * INTO receipt FROM public.flow_submissions s WHERE s.org_id=NEW.org_id AND s.subject_kind=kind
  AND s.subject_id=NEW.id ORDER BY s.created_at DESC,s.id DESC LIMIT 1;
 actor:=NEW.updated_by;
 IF NOT FOUND THEN RAISE EXCEPTION 'Submit this schedule record through native tenant Flows before release.'; END IF;
 IF NEW.released_without_approval THEN
  IF NEW.status<>'approved' OR NEW.decided_by IS NOT NULL OR NOT public.flow_ungated_submission_authorized(NEW.org_id,kind,NEW.id,actor) THEN
   RAISE EXCEPTION 'This schedule record has no complete zero-gate Flow submission.';
  END IF;
 ELSIF NEW.decided_by IS DISTINCT FROM actor OR NOT EXISTS(
   SELECT 1 FROM public.flow_gates g JOIN public.flow_runs r ON r.org_id=g.org_id AND r.id=g.run_id
    WHERE g.org_id=NEW.org_id AND g.subject_kind=kind AND g.subject_id=NEW.id
      AND receipt.policy->'runIds' ? r.id::text AND g.decided_by=actor AND g.decided_at IS NOT NULL
      AND g.status=CASE WHEN NEW.status='approved' THEN 'approved' ELSE 'rejected' END
      AND r.status IN('waiting','completed') AND r.error IS NULL)
   OR (NEW.status='approved' AND NOT public.flow_submission_approved(NEW.org_id,kind,NEW.id,receipt.id))
   OR EXISTS(SELECT 1 FROM flow_gates g WHERE g.org_id=NEW.org_id AND g.subject_kind=kind AND g.subject_id=NEW.id AND g.status IN('pending','escalated')) THEN
  RAISE EXCEPTION 'Complete the configured schedule Flow gates before releasing this record.';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_flow_decision_guard BEFORE UPDATE ON schedule_publications
 FOR EACH ROW EXECUTE FUNCTION public.schedule_flow_decision_guard('schedule_publication');
CREATE TRIGGER schedule_flow_decision_guard BEFORE UPDATE ON schedule_entry_requests
 FOR EACH ROW EXECUTE FUNCTION public.schedule_flow_decision_guard('schedule_entry_request');
-- Copy tenant identities inside frozen Flow evidence while retaining graph node identities.
CREATE FUNCTION public.flow_clone_evidence(value jsonb,seed uuid,field_name text DEFAULT '',target_org uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE result jsonb; item record; scalar text; identity_field boolean;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(value)='string' THEN
  scalar:=value#>>'{}';
  IF field_name='intent' THEN
   BEGIN RETURN to_jsonb(public.production_canonical_json(public.flow_clone_evidence(scalar::jsonb,seed,'',target_org)));
   EXCEPTION WHEN invalid_text_representation THEN RETURN value; END;
  END IF;
  identity_field:=field_name='id' OR field_name~'(Id|Ids|_id|_ids|By|_by)$'
    OR field_name IN('requestKey','subcontract_consumption_key');
  IF identity_field AND field_name NOT IN('nodeId','node_id')
    AND scalar~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   IF field_name IN('orgId','org_id') AND target_org IS NOT NULL THEN RETURN to_jsonb(target_org::text); END IF;
   RETURN to_jsonb(public.ob_rebase(scalar::uuid,seed)::text);
  END IF;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(public.flow_clone_evidence(element,seed,field_name,target_org) ORDER BY ordinal),'[]'::jsonb)
    INTO result FROM jsonb_array_elements(value) WITH ORDINALITY entries(element,ordinal);
  RETURN result;
 ELSIF jsonb_typeof(value)='object' THEN
  result:='{}'::jsonb;
  FOR item IN SELECT key,entry FROM jsonb_each(value) entries(key,entry) LOOP
   result:=result||jsonb_build_object(CASE WHEN field_name='material_usage_variance_delta_by_component'
     AND item.key~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN public.ob_rebase(item.key::uuid,seed)::text ELSE item.key END,CASE
    WHEN item.key IN('id','source','target') AND field_name IN('nodes','edges') THEN item.entry
    WHEN item.key='custom' THEN item.entry
    ELSE public.flow_clone_evidence(item.entry,seed,item.key,target_org) END);
  END LOOP;
  RETURN result;
 END IF;
 RETURN value;
END $$;
CREATE OR REPLACE FUNCTION public.benefit_clone_submission_evidence(evidence jsonb,seed uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public,pg_catalog AS $$
 SELECT public.flow_clone_evidence(evidence,seed,'context')
$$;
SELECT openbooks_refresh_query_catalog();
