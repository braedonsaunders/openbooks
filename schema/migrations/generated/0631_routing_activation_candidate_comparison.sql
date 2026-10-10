-- Routing activation compares the approved candidate header after extracting it; jsonb '-' binds tighter than '->', so the key must be extracted first.
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
    AND change.approved_by IS NOT NULL AND (change.approved_by<>change.submitted_by OR public.financial_change_self_decision_authorized(change.org_id,change.id,change.submitted_by))
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
      AND (change.approved_by<>change.submitted_by OR public.financial_change_self_decision_authorized(change.org_id,change.id,change.submitted_by))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(change.payload->'supersedes') prior
        WHERE prior->>'id'=OLD.id::text AND prior->>'effectiveTo' IS NOT DISTINCT FROM OLD.effective_to::text)) THEN
    RAISE EXCEPTION 'Changing a prior effective window requires an approved successor revision.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
