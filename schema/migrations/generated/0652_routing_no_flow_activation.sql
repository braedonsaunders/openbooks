-- OpenBooks forward migration 0652_routing_no_flow_activation.
--
-- Approval is an optional tenant Flow for routing revisions. A draft no
-- enabled Accounting-event Flow claims (zero enabled flows for the
-- financial_change subject kind and no run for the change) activates
-- directly: the engine records a draft -> pending -> approved financial
-- change carrying automatic no-flow decision evidence
-- (payload.decision.mode 'automatic', policy.flowConfigured false,
-- approved_by = submitted_by), then runs the same canonical activation
-- writer every approval uses — audited, actor recorded, superseding the
-- previously active revision per the existing effectivity rules. A
-- configured Flow still governs through propose/submit/gates/apply.
--
-- Admission mirrors the HRM no-flow direct-apply precedent: the guard
-- admits the self-decided change only with the automatic evidence
-- atomically present, and re-proves no enabled flow plus no run in
-- storage. Existing proposed, approved, and applied history keeps its
-- original controls.
--
-- The retained self-decision guard admits the same automatic evidence for
-- the manufacturing routing and BOM activation operations only: without
-- it the draft to pending to approved self decision the direct path
-- records could never land. Every other operation keeps its gate-policy
-- self-approval control.
--
-- The production BOM revision guard admits the same evidence when the
-- approved replacement writes its lines: the delete and inserts run
-- under the recorded change key, and a self-decided change is permitted
-- only with the automatic no-flow evidence re-proven in storage.
--
-- No schema, data, or backfill: three trigger function replacements,
-- otherwise a no-op. Reapply-safe by construction.

CREATE OR REPLACE FUNCTION public.manufacturing_routing_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.activation_change_id IS NOT NULL THEN RAISE EXCEPTION 'Routing revisions start as unapproved drafts.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='draft' AND NEW.status='active' THEN
  IF NEW.activation_change_id IS NULL OR NOT EXISTS(SELECT 1 FROM financial_changes change
   WHERE change.org_id=NEW.org_id AND change.id=NEW.activation_change_id AND change.subject_id=NEW.id
    AND change.domain='manufacturing' AND change.operation='routing_revision_activation' AND change.status='approved'
    AND change.approved_by IS NOT NULL AND (change.approved_by<>change.submitted_by OR public.financial_change_self_decision_authorized(change.org_id,change.id,change.submitted_by)
     OR (change.approved_by=change.submitted_by
      AND COALESCE(change.payload->'decision'->>'mode','')='automatic'
      AND COALESCE(change.payload->'decision'->'policy'->>'flowConfigured','')='false'
      AND NOT EXISTS(SELECT 1 FROM flows f WHERE f.org_id=change.org_id AND f.subject_kind='financial_change' AND f.enabled)
      AND NOT EXISTS(SELECT 1 FROM flow_runs r WHERE r.org_id=change.org_id AND r.subject_kind='financial_change' AND r.subject_id=change.id)))
    AND ((change.before_state->'candidate')-ARRAY['operations','locations'])=jsonb_build_object(
      'id',OLD.id,'orgId',OLD.org_id,'producedItemId',OLD.produced_item_id,'code',OLD.code,'name',OLD.name,'version',OLD.version,'status','draft',
      'effectiveFrom',OLD.effective_from::text,'effectiveTo',OLD.effective_to::text,'defaultIssueLocationId',OLD.default_issue_location_id,'defaultReceiptLocationId',OLD.default_receipt_location_id,'overheadBasis',OLD.overhead_basis)
    AND change.before_state->'candidate'->'operations'=(SELECT coalesce(jsonb_agg(jsonb_build_object('id',operation.id,'orgId',operation.org_id,'routingId',operation.routing_id,'sequence',operation.sequence,'name',operation.name,'workCenterId',operation.work_center_id,
      'setupMinutes',operation.setup_minutes::text,'runMinutesPerUnit',operation.run_minutes_per_unit::text,'laborMinutesPerUnit',operation.labor_minutes_per_unit::text,'laborTimeSource',operation.labor_time_source,'backflushAt',operation.backflush_at,'qualityGate',operation.quality_gate,'workCenterSubsidiaryId',center.subsidiary_id) ORDER BY operation.sequence),'[]'::jsonb)
      FROM mfg_routing_operations operation JOIN mfg_work_centers center ON center.org_id=operation.org_id AND center.id=operation.work_center_id WHERE operation.org_id=OLD.org_id AND operation.routing_id=OLD.id))
    OR (NEW.produced_item_id,NEW.code,NEW.name,NEW.version,NEW.effective_from,NEW.effective_to,NEW.default_issue_location_id,NEW.default_receipt_location_id,NEW.overhead_basis)
      IS DISTINCT FROM (OLD.produced_item_id,OLD.code,OLD.name,OLD.version,OLD.effective_from,OLD.effective_to,OLD.default_issue_location_id,OLD.default_receipt_location_id,OLD.overhead_basis) THEN
   RAISE EXCEPTION 'Routing activation requires its unchanged approved revision proposal.' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.activation_change_id IS DISTINCT FROM OLD.activation_change_id THEN
  RAISE EXCEPTION 'Routing activation evidence is immutable.' USING ERRCODE='23514';
 END IF;
 IF OLD.status<>'draft' THEN
  IF (NEW.produced_item_id,NEW.code,NEW.name,NEW.version,NEW.effective_from,NEW.default_issue_location_id,NEW.default_receipt_location_id,NEW.overhead_basis)
    IS DISTINCT FROM (OLD.produced_item_id,OLD.code,OLD.name,OLD.version,OLD.effective_from,OLD.default_issue_location_id,OLD.default_receipt_location_id,OLD.overhead_basis)
    OR NEW.status NOT IN ('active','archived') THEN RAISE EXCEPTION 'Approved routing content is immutable; create a new revision.' USING ERRCODE='23514'; END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NOT EXISTS(
    SELECT 1 FROM financial_changes change JOIN mfg_routings candidate ON candidate.org_id=change.org_id AND candidate.id=change.subject_id
    WHERE change.org_id=NEW.org_id AND change.domain='manufacturing' AND change.operation='routing_revision_activation'
      AND change.status='approved' AND candidate.status='draft' AND candidate.produced_item_id=NEW.produced_item_id
      AND candidate.effective_from=NEW.effective_to AND change.approved_by IS NOT NULL
      AND (change.approved_by<>change.submitted_by OR public.financial_change_self_decision_authorized(change.org_id,change.id,change.submitted_by)
       OR (change.approved_by=change.submitted_by
        AND COALESCE(change.payload->'decision'->>'mode','')='automatic'
        AND COALESCE(change.payload->'decision'->'policy'->>'flowConfigured','')='false'
        AND NOT EXISTS(SELECT 1 FROM flows f WHERE f.org_id=change.org_id AND f.subject_kind='financial_change' AND f.enabled)
        AND NOT EXISTS(SELECT 1 FROM flow_runs r WHERE r.org_id=change.org_id AND r.subject_kind='financial_change' AND r.subject_id=change.id)))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(change.payload->'supersedes') prior
        WHERE prior->>'id'=OLD.id::text AND prior->>'effectiveTo' IS NOT DISTINCT FROM OLD.effective_to::text)) THEN
    RAISE EXCEPTION 'Changing a prior effective window requires an approved successor revision.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.financial_change_self_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.approved_by=NEW.submitted_by AND NOT public.financial_change_self_decision_authorized(NEW.org_id,NEW.id,NEW.approved_by)
  AND NOT (NEW.domain='manufacturing' AND (NEW.operation='routing_revision_activation' OR NEW.operation='bom_revision_activation')
   AND COALESCE(NEW.payload->'decision'->>'mode','')='automatic'
   AND COALESCE(NEW.payload->'decision'->'policy'->>'flowConfigured','')='false'
   AND NOT EXISTS(SELECT 1 FROM flows f WHERE f.org_id=NEW.org_id AND f.subject_kind='financial_change' AND f.enabled)
   AND NOT EXISTS(SELECT 1 FROM flow_runs r WHERE r.org_id=NEW.org_id AND r.subject_kind='financial_change' AND r.subject_id=NEW.id)) THEN
  RAISE EXCEPTION 'The retained accounting-event approval policy must explicitly permit a native self decision.';
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.production_bom_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE subject_org uuid;subject_item uuid;change_key text;proposal public.financial_changes%ROWTYPE;governed boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  subject_org:=OLD.org_id;subject_item:=OLD.assembly_item_id;
 ELSE
  IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
  subject_org:=NEW.org_id;subject_item:=NEW.assembly_item_id;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.assembly_item_id) IS DISTINCT FROM (OLD.org_id,OLD.assembly_item_id) THEN
  RAISE EXCEPTION 'A recipe line cannot change its organization or assembly.' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['updated_at','updated_by'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['updated_at','updated_by'] THEN RETURN NEW; END IF;
 governed:=EXISTS(SELECT 1 FROM public.mfg_work_orders WHERE org_id=subject_org AND produced_item_id=subject_item AND released_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.mfg_routings WHERE org_id=subject_org AND produced_item_id=subject_item AND activation_change_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.financial_changes WHERE org_id=subject_org AND subject_id=subject_item AND domain='manufacturing' AND operation='bom_revision_activation');
 IF NOT governed THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 change_key:=nullif(current_setting('openbooks.production_bom_changes',true),'')::jsonb->>(subject_org::text||':'||subject_item::text);
 IF change_key IS NULL OR change_key!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'This production recipe requires an approved revision; open its BOM editor and submit the revision for approval.' USING ERRCODE='23514'; END IF;
 SELECT * INTO proposal FROM public.financial_changes WHERE org_id=subject_org AND id=change_key::uuid AND subject_id=subject_item
  AND domain='manufacturing' AND operation='bom_revision_activation' AND status='approved' FOR SHARE;
 IF NOT FOUND OR proposal.approved_by IS NULL OR (proposal.approved_by=proposal.submitted_by AND NOT public.financial_change_self_decision_authorized(proposal.org_id,proposal.id,proposal.submitted_by)
  AND NOT (COALESCE(proposal.payload->'decision'->>'mode','')='automatic'
   AND COALESCE(proposal.payload->'decision'->'policy'->>'flowConfigured','')='false'
   AND NOT EXISTS(SELECT 1 FROM flows f WHERE f.org_id=proposal.org_id AND f.subject_kind='financial_change' AND f.enabled)
   AND NOT EXISTS(SELECT 1 FROM flow_runs r WHERE r.org_id=proposal.org_id AND r.subject_kind='financial_change' AND r.subject_id=proposal.id))) THEN
  RAISE EXCEPTION 'A current recipe requires its permitted approval decision.' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal.before_state->'lines') previous WHERE previous->>'id'=OLD.id::text
    AND public.production_bom_line_evidence(previous,false)=public.production_bom_line_evidence(to_jsonb(OLD),true)) THEN
   RAISE EXCEPTION 'The recipe changed after approval; propose its current revision again.' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal.payload->'components') component
   WHERE public.production_bom_line_evidence(component,false)=public.production_bom_line_evidence(to_jsonb(NEW),true)) THEN
  RAISE EXCEPTION 'Apply the exact approved recipe replacement; direct line changes are refused.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
