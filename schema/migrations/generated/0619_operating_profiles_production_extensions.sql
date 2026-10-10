-- Versioned operating compositions preserve native project and production identities.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

CREATE TABLE public.operating_profiles (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL CHECK(length(btrim(code)) BETWEEN 1 AND 80), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 family text NOT NULL CHECK(family IN('project','production')), current_version_id uuid,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_by uuid,
 UNIQUE(org_id,id), UNIQUE(org_id,code), UNIQUE(org_id,id,family)
);
CREATE TABLE public.operating_profile_versions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), profile_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), family text NOT NULL CHECK(family IN('project','production')),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND definition->>'family'=family),
 published_at timestamptz NOT NULL DEFAULT now(), published_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
 UNIQUE(org_id,id), UNIQUE(org_id,profile_id,version), UNIQUE(org_id,profile_id,id),
 FOREIGN KEY(org_id,profile_id,family) REFERENCES public.operating_profiles(org_id,id,family)
);
ALTER TABLE public.operating_profiles ADD CONSTRAINT operating_profile_current_version_fk
 FOREIGN KEY(org_id,id,current_version_id) REFERENCES public.operating_profile_versions(org_id,profile_id,id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.projects ADD COLUMN operating_profile_version_id uuid;
ALTER TABLE public.projects ADD COLUMN operating_department_id uuid;
ALTER TABLE public.projects ADD CONSTRAINT projects_operating_profile_version_fk FOREIGN KEY(org_id,operating_profile_version_id) REFERENCES public.operating_profile_versions(org_id,id);
ALTER TABLE public.projects ADD CONSTRAINT projects_operating_department_fk FOREIGN KEY(org_id,operating_department_id) REFERENCES public.departments(org_id,id);
ALTER TABLE public.mfg_work_orders ADD COLUMN operating_profile_version_id uuid;
ALTER TABLE public.mfg_work_orders ADD COLUMN operating_department_id uuid;
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_operating_profile_version_fk FOREIGN KEY(org_id,operating_profile_version_id) REFERENCES public.operating_profile_versions(org_id,id);
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_operating_department_fk FOREIGN KEY(org_id,operating_department_id) REFERENCES public.departments(org_id,id);

CREATE FUNCTION public.operating_profile_version_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Published operating profiles are immutable; publish a new version.' USING ERRCODE='23514';
END $$;
CREATE TRIGGER operating_profile_version_immutable BEFORE UPDATE OR DELETE ON public.operating_profile_versions FOR EACH ROW EXECUTE FUNCTION public.operating_profile_version_immutable();
CREATE FUNCTION public.work_operating_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE expected_family text;
BEGIN
 expected_family:=CASE WHEN TG_TABLE_NAME='projects' THEN 'project' ELSE 'production' END;
 IF TG_OP='UPDATE' AND (NEW.operating_profile_version_id,NEW.operating_department_id) IS DISTINCT FROM (OLD.operating_profile_version_id,OLD.operating_department_id) THEN
  RAISE EXCEPTION 'Work keeps its operating profile and department; create new work to use another composition.' USING ERRCODE='23514';
 END IF;
 IF NEW.operating_profile_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.operating_profile_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.operating_profile_version_id AND v.family=expected_family) THEN
  RAISE EXCEPTION 'Choose an operating profile for this native work family.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_operating_profile_guard BEFORE INSERT OR UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.work_operating_profile_guard();
CREATE TRIGGER manufacturing_operating_profile_guard BEFORE INSERT OR UPDATE ON public.mfg_work_orders FOR EACH ROW EXECUTE FUNCTION public.work_operating_profile_guard();

ALTER TABLE public.operating_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operating_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.operating_profiles USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
ALTER TABLE public.operating_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operating_profile_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.operating_profile_versions USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.operating_profiles IS 'openbooks:org_isolation:v1';
COMMENT ON POLICY org_isolation ON public.operating_profile_versions IS 'openbooks:org_isolation:v1';

CREATE TABLE public.operating_profile_scopes (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),department_id uuid,
 family text NOT NULL CHECK(family IN('project','production')),profile_ids jsonb NOT NULL CHECK(jsonb_typeof(profile_ids)='array'),default_profile_id uuid,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 UNIQUE(org_id,id),FOREIGN KEY(org_id,department_id) REFERENCES public.departments(org_id,id),
 FOREIGN KEY(org_id,default_profile_id,family) REFERENCES public.operating_profiles(org_id,id,family)
);
CREATE UNIQUE INDEX operating_profile_scope_identity ON public.operating_profile_scopes(org_id,department_id,family) NULLS NOT DISTINCT;
ALTER TABLE public.operating_profile_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operating_profile_scopes FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.operating_profile_scopes USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.operating_profile_scopes IS 'openbooks:org_isolation:v1';

CREATE FUNCTION public.operating_profile_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE profile_value jsonb; profile_uuid uuid;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.department_id,NEW.family) IS DISTINCT FROM (OLD.org_id,OLD.department_id,OLD.family) THEN
  RAISE EXCEPTION 'Workflow scope identity is immutable; create another scope.' USING ERRCODE='23514';
 END IF;
 IF jsonb_array_length(NEW.profile_ids) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Choose between one and one hundred allowed workflows.' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.profile_ids))<>jsonb_array_length(NEW.profile_ids) THEN RAISE EXCEPTION 'Allowed workflows must be distinct.' USING ERRCODE='23514'; END IF;
 FOR profile_value IN SELECT value FROM jsonb_array_elements(NEW.profile_ids) LOOP
  IF jsonb_typeof(profile_value)<>'string' OR (profile_value#>>'{}')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RAISE EXCEPTION 'Choose tenant-owned workflows.' USING ERRCODE='23514'; END IF;
  profile_uuid:=(profile_value#>>'{}')::uuid;
  PERFORM id FROM public.operating_profiles WHERE org_id=NEW.org_id AND id=profile_uuid AND family=NEW.family FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allowed workflow belongs to another work family or organization.' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF NEW.default_profile_id IS NOT NULL AND NOT NEW.profile_ids @> jsonb_build_array(NEW.default_profile_id::text) THEN RAISE EXCEPTION 'The default must be one of the allowed workflows.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operating_profile_scope_guard BEFORE INSERT OR UPDATE ON public.operating_profile_scopes FOR EACH ROW EXECUTE FUNCTION public.operating_profile_scope_guard();

-- Operations may absorb shared approved employee hours independently of machine elapsed minutes.
ALTER TABLE public.mfg_routing_operations ADD COLUMN labor_time_source text NOT NULL DEFAULT 'operation' CHECK(labor_time_source IN('operation','approved_time'));
ALTER TABLE public.mfg_wo_operations ADD COLUMN labor_time_source text NOT NULL DEFAULT 'operation' CHECK(labor_time_source IN('operation','approved_time'));
ALTER TABLE public.mfg_wo_operations ADD COLUMN labor_minutes_per_unit numeric(19,4) CHECK(labor_minutes_per_unit>=0);
UPDATE public.mfg_wo_operations o SET labor_minutes_per_unit=r.labor_minutes_per_unit FROM public.mfg_work_orders w,public.mfg_routing_operations r
 WHERE w.org_id=o.org_id AND w.id=o.work_order_id AND r.org_id=w.org_id AND r.routing_id=w.routing_id AND r.sequence=o.sequence;
ALTER TABLE public.time_entries ADD COLUMN production_consumed_operation_id uuid;
ALTER TABLE public.time_entries ADD CONSTRAINT time_production_consumed_operation_fk FOREIGN KEY(org_id,work_order_id,production_consumed_operation_id) REFERENCES public.mfg_wo_operations(org_id,work_order_id,id);
ALTER TABLE public.time_entries ADD CONSTRAINT time_production_consumed_target_chk CHECK(production_consumed_operation_id IS NULL OR (work_order_id IS NOT NULL AND wo_operation_id IS NOT NULL AND wo_operation_id=production_consumed_operation_id AND status='approved'));

CREATE FUNCTION public.production_time_history_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD.production_consumed_operation_id IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Consumed production time is immutable; record a governed time correction.' USING ERRCODE='23514';
 END IF;
 IF to_jsonb(NEW)-ARRAY['updated_at','updated_by','payroll_batch_ref'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['updated_at','updated_by','payroll_batch_ref'] THEN
  RAISE EXCEPTION 'Consumed production time is immutable; record a governed time correction.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_time_history_guard BEFORE UPDATE OR DELETE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.production_time_history_guard();

CREATE FUNCTION public.production_operation_time_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF (NEW.labor_time_source,NEW.labor_minutes_per_unit) IS DISTINCT FROM (OLD.labor_time_source,OLD.labor_minutes_per_unit) THEN
  RAISE EXCEPTION 'Released operations keep their labor capture and standard minutes; release a replacement order.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_operation_time_snapshot_guard BEFORE UPDATE ON public.mfg_wo_operations FOR EACH ROW EXECUTE FUNCTION public.production_operation_time_snapshot_guard();

-- A replacement retains the consumed source alongside its separate exact contra.
ALTER TABLE public.time_entries ADD COLUMN corrects_entry_id uuid;
ALTER TABLE public.time_entries ADD CONSTRAINT time_corrects_entry_fk FOREIGN KEY(org_id,corrects_entry_id) REFERENCES public.time_entries(org_id,id);
ALTER TABLE public.time_entries ADD CONSTRAINT time_correction_kind_chk CHECK(corrects_entry_id IS NULL OR (amends_entry_id IS NULL AND hours>=0));
CREATE UNIQUE INDEX time_entries_one_replacement ON public.time_entries(org_id,corrects_entry_id) WHERE corrects_entry_id IS NOT NULL;

-- Standard-cost proposals retain the native immutable approval and lifecycle contract.
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
  IF (to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','result','applied_by','applied_at','updated_at','updated_by']) THEN
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


-- Activation proof and released work remain bound to immutable engineering evidence.
ALTER TABLE public.mfg_routings ADD COLUMN activation_change_id uuid;
ALTER TABLE public.mfg_routings ADD CONSTRAINT mfg_routing_activation_change_fk FOREIGN KEY(org_id,activation_change_id) REFERENCES public.financial_changes(org_id,id);
CREATE FUNCTION public.manufacturing_routing_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
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
CREATE TRIGGER manufacturing_routing_revision_guard BEFORE INSERT OR UPDATE ON public.mfg_routings FOR EACH ROW EXECUTE FUNCTION public.manufacturing_routing_revision_guard();
CREATE FUNCTION public.manufacturing_routing_operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE parent_org uuid; parent_id uuid; parent_status text;
BEGIN
 parent_org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.routing_id ELSE NEW.routing_id END;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(parent_org) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.routing_id) IS DISTINCT FROM (OLD.org_id,OLD.routing_id) THEN RAISE EXCEPTION 'Routing operations cannot move between revisions.' USING ERRCODE='23514'; END IF;
 SELECT status INTO parent_status FROM mfg_routings WHERE org_id=parent_org AND id=parent_id FOR SHARE;
 IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Approved routing operations are immutable; edit a new revision.' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_routing_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_routing_operations FOR EACH ROW EXECUTE FUNCTION public.manufacturing_routing_operation_guard();
-- Optional bounded runs and campaign references share the existing production lifecycle.
ALTER TABLE public.mfg_work_orders ADD COLUMN production_mode text NOT NULL DEFAULT 'order',ADD COLUMN campaign_reference text;
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_production_mode CHECK(production_mode IN('order','batch','continuous') AND (production_mode<>'continuous' OR (planned_start IS NOT NULL AND planned_end IS NOT NULL))),ADD CONSTRAINT mfg_campaign_reference CHECK(campaign_reference IS NULL OR length(btrim(campaign_reference)) BETWEEN 1 AND 100);
CREATE FUNCTION public.manufacturing_released_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD.released_at IS NOT NULL AND (NEW.produced_item_id,NEW.routing_id,NEW.routing_version,NEW.bom_revision,NEW.standard_cost_snapshot,NEW.unit,NEW.quantity_ordered,NEW.subsidiary_id,NEW.released_at,NEW.production_mode,NEW.campaign_reference,CASE WHEN NEW.production_mode='continuous' THEN NEW.planned_start END,CASE WHEN NEW.production_mode='continuous' THEN NEW.planned_end END)
  IS DISTINCT FROM (OLD.produced_item_id,OLD.routing_id,OLD.routing_version,OLD.bom_revision,OLD.standard_cost_snapshot,OLD.unit,OLD.quantity_ordered,OLD.subsidiary_id,OLD.released_at,OLD.production_mode,OLD.campaign_reference,CASE WHEN OLD.production_mode='continuous' THEN OLD.planned_start END,CASE WHEN OLD.production_mode='continuous' THEN OLD.planned_end END) THEN
  RAISE EXCEPTION 'Released work retains its production revision, quantity and cost evidence.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_released_revision_guard BEFORE UPDATE ON public.mfg_work_orders FOR EACH ROW EXECUTE FUNCTION public.manufacturing_released_revision_guard();

-- Completion batches retain actual or explicitly estimated input allocation without rewriting journals.
CREATE TABLE public.mfg_completion_batches (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 work_order_id uuid NOT NULL,completion_entry_id uuid NOT NULL,
 allocation_basis text NOT NULL CONSTRAINT mfg_completion_batch_basis CHECK(allocation_basis IN('recorded','proportional')),
 quantity numeric(19,4) NOT NULL CONSTRAINT mfg_completion_batch_quantity_positive CHECK(quantity>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_completion_batches_org_identity UNIQUE(org_id,id),CONSTRAINT mfg_completion_batches_entry_identity UNIQUE(org_id,completion_entry_id),CONSTRAINT mfg_completion_batches_order_entry_identity UNIQUE(org_id,work_order_id,completion_entry_id),
 CONSTRAINT mfg_completion_batch_order_fk FOREIGN KEY(org_id,work_order_id) REFERENCES public.mfg_work_orders(org_id,id),
 CONSTRAINT mfg_completion_batch_entry_fk FOREIGN KEY(org_id,completion_entry_id) REFERENCES public.journal_entries(org_id,id)
);
CREATE TABLE public.mfg_completion_inputs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 work_order_id uuid NOT NULL,completion_entry_id uuid NOT NULL,input_movement_id uuid NOT NULL,
 quantity numeric(19,4) NOT NULL CONSTRAINT mfg_completion_input_quantity_positive CHECK(quantity>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_completion_inputs_org_identity UNIQUE(org_id,id),CONSTRAINT mfg_completion_inputs_entry_source_identity UNIQUE(org_id,completion_entry_id,input_movement_id),
 CONSTRAINT mfg_completion_input_batch_fk FOREIGN KEY(org_id,work_order_id,completion_entry_id) REFERENCES public.mfg_completion_batches(org_id,work_order_id,completion_entry_id),
 CONSTRAINT mfg_completion_input_movement_fk FOREIGN KEY(org_id,input_movement_id) REFERENCES public.inventory_movements(org_id,id)
);
CREATE INDEX mfg_completion_inputs_source ON public.mfg_completion_inputs(org_id,input_movement_id,completion_entry_id);
ALTER TABLE public.mfg_completion_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_completion_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_completion_batches USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_completion_batches IS 'openbooks:org_isolation:v1';
ALTER TABLE public.mfg_completion_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_completion_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_completion_inputs USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_completion_inputs IS 'openbooks:org_isolation:v1';
CREATE FUNCTION public.manufacturing_completion_trace_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE work_number text; source_quantity numeric; assigned_quantity numeric;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Completion trace evidence is immutable; reverse its receipt to correct the batch.' USING ERRCODE='23514'; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 SELECT number INTO work_number FROM mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.work_order_id FOR SHARE;
 IF work_number IS NULL OR NOT EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.completion_entry_id AND origin='manufacturing' AND status='posted' AND reverses_entry_id IS NULL AND custom->>'work_order_number'=work_number AND custom ? 'completion_quantity') THEN
  RAISE EXCEPTION 'Completion evidence requires the posted receipt of its work order.' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='mfg_completion_batches' THEN
  IF NOT EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.completion_entry_id AND (custom->>'completion_quantity')::numeric=NEW.quantity) THEN RAISE EXCEPTION 'Batch quantity must match its native receipt.' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT -movement.quantity INTO source_quantity FROM inventory_movements movement JOIN journal_entries entry ON entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id
   WHERE movement.org_id=NEW.org_id AND movement.id=NEW.input_movement_id AND movement.kind='assembly_consume' AND movement.status='posted' AND movement.reverses_movement_id IS NULL
    AND entry.origin='manufacturing' AND entry.status='posted' AND entry.custom->>'work_order_number'=work_number
    AND NOT EXISTS(SELECT 1 FROM inventory_movements reversal WHERE reversal.org_id=movement.org_id AND reversal.reverses_movement_id=movement.id AND reversal.status='posted') FOR UPDATE OF movement;
  SELECT coalesce(sum(allocation.quantity),0) INTO assigned_quantity FROM mfg_completion_inputs allocation JOIN journal_entries receipt ON receipt.org_id=allocation.org_id AND receipt.id=allocation.completion_entry_id
   WHERE allocation.org_id=NEW.org_id AND allocation.input_movement_id=NEW.input_movement_id AND receipt.status='posted' AND receipt.reverses_entry_id IS NULL;
  IF source_quantity IS NULL OR NEW.quantity+assigned_quantity>source_quantity THEN RAISE EXCEPTION 'Completion inputs must use unassigned native issues from the same work order.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_completion_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_completion_batches FOR EACH ROW EXECUTE FUNCTION public.manufacturing_completion_trace_guard();
CREATE TRIGGER manufacturing_completion_input_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_completion_inputs FOR EACH ROW EXECUTE FUNCTION public.manufacturing_completion_trace_guard();

-- Effective inspection policy and frozen results share inventory holds with manufacturing execution.
CREATE TABLE public.inventory_inspection_plans (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),revision integer NOT NULL DEFAULT 1,reason text NOT NULL,name text NOT NULL,item_id uuid NOT NULL,
 point text NOT NULL,operation_sequence integer,effective_from date NOT NULL,effective_to date,measures jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT inventory_inspection_plans_org_identity UNIQUE(org_id,id),
 CONSTRAINT inspection_plan_item_fk FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),
 CONSTRAINT inspection_plan_point CHECK((point='receipt' AND operation_sequence IS NULL) OR (point='operation' AND operation_sequence>0)),
 CONSTRAINT inspection_plan_window CHECK(effective_to IS NULL OR effective_to>effective_from),
 CONSTRAINT inspection_plan_measures CHECK(jsonb_typeof(measures)='array' AND jsonb_array_length(measures)<=100),
 CONSTRAINT inspection_plan_revision CHECK(revision>0 AND length(btrim(reason)) BETWEEN 5 AND 500)
);
CREATE TABLE public.inventory_inspections (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),plan_id uuid NOT NULL,plan_snapshot jsonb NOT NULL,
 item_id uuid NOT NULL,subsidiary_id uuid NOT NULL,stock_location_id uuid,receipt_movement_id uuid,work_order_id uuid,operation_id uuid,inspection_sequence integer,lot_id uuid,serial_id uuid,
 quantity numeric(19,4) NOT NULL,status text NOT NULL DEFAULT 'pending',measurements jsonb NOT NULL DEFAULT '{}',reason text,inspected_at timestamptz,inspected_by uuid,
 disposition text,disposition_reason text,disposition_result jsonb,disposed_at timestamptz,disposed_by uuid,rework_operation_id uuid,rework_completed_at timestamptz,scrap_movement_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT inventory_inspections_org_identity UNIQUE(org_id,id),CONSTRAINT inventory_inspection_receipt_identity UNIQUE(org_id,receipt_movement_id),
 CONSTRAINT inspection_plan_fk FOREIGN KEY(org_id,plan_id) REFERENCES public.inventory_inspection_plans(org_id,id),
 CONSTRAINT inspection_item_fk FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),
 CONSTRAINT inspection_entity_fk FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 CONSTRAINT inspection_location_fk FOREIGN KEY(org_id,stock_location_id) REFERENCES public.stock_locations(org_id,id),
 CONSTRAINT inspection_receipt_fk FOREIGN KEY(org_id,receipt_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT inspection_work_fk FOREIGN KEY(org_id,work_order_id) REFERENCES public.mfg_work_orders(org_id,id),
 CONSTRAINT inspection_operation_fk FOREIGN KEY(org_id,work_order_id,operation_id) REFERENCES public.mfg_wo_operations(org_id,work_order_id,id),
 CONSTRAINT inspection_lot_fk FOREIGN KEY(org_id,lot_id) REFERENCES public.lots(org_id,id),CONSTRAINT inspection_serial_fk FOREIGN KEY(org_id,serial_id) REFERENCES public.serials(org_id,id),
 CONSTRAINT inspection_rework_fk FOREIGN KEY(org_id,rework_operation_id) REFERENCES public.mfg_wo_operations(org_id,id),
 CONSTRAINT inspection_scrap_fk FOREIGN KEY(org_id,scrap_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT inspection_subject CHECK((receipt_movement_id IS NOT NULL AND operation_id IS NULL AND stock_location_id IS NOT NULL) OR (receipt_movement_id IS NULL AND operation_id IS NOT NULL AND work_order_id IS NOT NULL)),
 CONSTRAINT inspection_quantity CHECK(quantity>0),
 CONSTRAINT inspection_tracking CHECK(lot_id IS NOT NULL OR serial_id IS NOT NULL OR operation_id IS NOT NULL),
 CONSTRAINT inspection_result CHECK((status='pending' AND inspected_at IS NULL AND inspected_by IS NULL AND disposition IS NULL) OR (status IN ('pass','fail') AND inspected_at IS NOT NULL AND inspected_by IS NOT NULL)),
 CONSTRAINT inspection_disposition CHECK((disposition IS NULL AND disposed_at IS NULL AND disposed_by IS NULL) OR (status='fail' AND disposition IN ('use_as_is','scrap','rework') AND disposed_at IS NOT NULL AND disposed_by IS NOT NULL AND disposition_reason IS NOT NULL AND disposition_result IS NOT NULL))
);
CREATE INDEX inventory_inspection_operation_identity ON public.inventory_inspections(org_id,operation_id,created_at);
CREATE UNIQUE INDEX inventory_inspection_operation_sequence ON public.inventory_inspections(org_id,operation_id,inspection_sequence);
ALTER TABLE public.inventory_inspections ADD CONSTRAINT inspection_operation_sequence CHECK((operation_id IS NULL)=(inspection_sequence IS NULL) AND (inspection_sequence IS NULL OR inspection_sequence>0));
CREATE INDEX inventory_inspection_queue ON public.inventory_inspections(org_id,subsidiary_id,status,created_at);
CREATE INDEX inventory_inspection_lot_holds ON public.inventory_inspections(org_id,lot_id) WHERE status IN ('pending','fail');
CREATE INDEX inventory_inspection_serial_holds ON public.inventory_inspections(org_id,serial_id) WHERE status IN ('pending','fail');
ALTER TABLE public.inventory_inspection_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_inspection_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.inventory_inspection_plans USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.inventory_inspection_plans IS 'openbooks:org_isolation:v1';
ALTER TABLE public.inventory_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.inventory_inspections USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.inventory_inspections IS 'openbooks:org_isolation:v1';
ALTER TABLE public.mfg_wo_operations ADD COLUMN inspection_plan_snapshot jsonb;
CREATE FUNCTION public.inventory_inspection_plan_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Inspection plans retain their history; end the effective window.' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Inspection plan changes require the next revision.' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (EXISTS(SELECT 1 FROM inventory_inspections WHERE org_id=OLD.org_id AND plan_id=OLD.id) OR EXISTS(SELECT 1 FROM mfg_wo_operations WHERE org_id=OLD.org_id AND inspection_plan_snapshot->>'id'=OLD.id::text)) AND
  ((to_jsonb(NEW)-ARRAY['effective_to','revision','reason','updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['effective_to','revision','reason','updated_at','updated_by']) OR NEW.effective_to IS NULL OR NEW.effective_to<(SELECT (now() AT TIME ZONE coalesce(nullif(settings->>'timeZone',''),'UTC'))::date FROM orgs WHERE id=NEW.org_id) OR (OLD.effective_to IS NOT NULL AND NEW.effective_to>OLD.effective_to)) THEN
  RAISE EXCEPTION 'Used inspection plans retain their content and historical effective window.' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('inventory.inspection.plan'),hashtext(NEW.org_id::text||NEW.item_id::text||NEW.point||coalesce(NEW.operation_sequence::text,'')));
 IF EXISTS(SELECT 1 FROM inventory_inspection_plans WHERE org_id=NEW.org_id AND item_id=NEW.item_id AND point=NEW.point AND operation_sequence IS NOT DISTINCT FROM NEW.operation_sequence AND id<>NEW.id AND daterange(effective_from,effective_to,'[)') && daterange(NEW.effective_from,NEW.effective_to,'[)')) THEN
  RAISE EXCEPTION 'Inspection plan effective windows overlap.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_inspection_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_inspection_plans FOR EACH ROW EXECUTE FUNCTION public.inventory_inspection_plan_guard();
CREATE FUNCTION public.inventory_inspection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Inspection evidence is immutable.' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.disposition IS NOT NULL OR NEW.inspected_by IS NOT NULL THEN RAISE EXCEPTION 'Inspections start pending.' USING ERRCODE='23514'; END IF;
  IF NEW.operation_id IS NOT NULL THEN
   PERFORM id FROM mfg_wo_operations WHERE org_id=NEW.org_id AND id=NEW.operation_id FOR UPDATE;
   SELECT coalesce(max(inspection_sequence),0)+1 INTO NEW.inspection_sequence FROM inventory_inspections WHERE org_id=NEW.org_id AND operation_id=NEW.operation_id;
  END IF;
  IF NEW.receipt_movement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_movements source WHERE source.org_id=NEW.org_id AND source.id=NEW.receipt_movement_id AND source.status='posted' AND source.reverses_movement_id IS NULL AND source.quantity=NEW.quantity AND source.quantity>0 AND source.item_id=NEW.item_id AND source.subsidiary_id=NEW.subsidiary_id AND source.stock_location_id=NEW.stock_location_id AND source.lot_id IS NOT DISTINCT FROM NEW.lot_id AND source.serial_id IS NOT DISTINCT FROM NEW.serial_id) THEN RAISE EXCEPTION 'Receipt inspection must bind its exact native stock receipt.' USING ERRCODE='23514'; END IF;
  IF NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mfg_wo_operations operation JOIN mfg_work_orders work ON work.org_id=operation.org_id AND work.id=operation.work_order_id WHERE operation.org_id=NEW.org_id AND operation.id=NEW.operation_id AND work.id=NEW.work_order_id AND work.subsidiary_id=NEW.subsidiary_id AND work.produced_item_id=NEW.item_id AND operation.status IN('pending','running','paused') AND operation.inspection_plan_snapshot=NEW.plan_snapshot) THEN RAISE EXCEPTION 'Operation inspection must bind its released work and frozen plan.' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['quantity','lot_id','serial_id','status','measurements','reason','inspected_at','inspected_by','disposition','disposition_reason','disposition_result','disposed_at','disposed_by','rework_work_order_id','rework_operation_id','rework_completed_at','scrap_movement_id','updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['quantity','lot_id','serial_id','status','measurements','reason','inspected_at','inspected_by','disposition','disposition_reason','disposition_result','disposed_at','disposed_by','rework_work_order_id','rework_operation_id','rework_completed_at','scrap_movement_id','updated_at','updated_by']) THEN RAISE EXCEPTION 'Inspection subject and plan are immutable.' USING ERRCODE='23514'; END IF;
  IF OLD.status<>'pending' AND (NEW.quantity,NEW.lot_id,NEW.serial_id,NEW.status,NEW.measurements,NEW.reason,NEW.inspected_at,NEW.inspected_by) IS DISTINCT FROM (OLD.quantity,OLD.lot_id,OLD.serial_id,OLD.status,OLD.measurements,OLD.reason,OLD.inspected_at,OLD.inspected_by) THEN RAISE EXCEPTION 'Recorded inspection results are immutable.' USING ERRCODE='23514'; END IF;
  IF NEW.receipt_movement_id IS NOT NULL AND NEW.quantity IS DISTINCT FROM OLD.quantity THEN RAISE EXCEPTION 'Receipt inspection quantity retains its stock source.' USING ERRCODE='23514'; END IF;
  IF OLD.status='pending' AND NEW.status NOT IN ('pending','pass','fail') THEN RAISE EXCEPTION 'Invalid inspection result.' USING ERRCODE='23514'; END IF;
  IF OLD.disposition IS NOT NULL AND (NEW.disposition,NEW.disposition_reason,NEW.disposition_result,NEW.disposed_at,NEW.disposed_by,NEW.rework_work_order_id,NEW.rework_operation_id,NEW.scrap_movement_id) IS DISTINCT FROM (OLD.disposition,OLD.disposition_reason,OLD.disposition_result,OLD.disposed_at,OLD.disposed_by,OLD.rework_work_order_id,OLD.rework_operation_id,OLD.scrap_movement_id) THEN RAISE EXCEPTION 'Recorded quality dispositions are immutable.' USING ERRCODE='23514'; END IF;
  IF OLD.scrap_movement_id IS NOT NULL AND NEW.scrap_movement_id IS DISTINCT FROM OLD.scrap_movement_id THEN RAISE EXCEPTION 'Quality scrap has one immutable inventory effect.' USING ERRCODE='23514'; END IF;
  IF OLD.rework_completed_at IS NOT NULL AND NEW.rework_completed_at IS DISTINCT FROM OLD.rework_completed_at THEN RAISE EXCEPTION 'Rework completion is immutable.' USING ERRCODE='23514'; END IF;
 END IF;
 IF (NEW.disposition='rework' AND NEW.receipt_movement_id IS NOT NULL) IS DISTINCT FROM (NEW.rework_work_order_id IS NOT NULL) AND NEW.disposition IS NOT NULL THEN RAISE EXCEPTION 'Receipt rework requires its native repair order.' USING ERRCODE='23514'; END IF;
 IF NEW.rework_work_order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mfg_work_orders repair WHERE repair.org_id=NEW.org_id AND repair.id=NEW.rework_work_order_id AND repair.receipt_rework_inspection_id=NEW.id) THEN RAISE EXCEPTION 'The repair order must retain this exact failed inspection.' USING ERRCODE='23514'; END IF;
 IF NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mfg_wo_operations WHERE org_id=NEW.org_id AND id=NEW.operation_id AND work_order_id=NEW.work_order_id AND NEW.quantity<=quantity_planned) THEN RAISE EXCEPTION 'Operation inspection cannot exceed its released planned quantity.' USING ERRCODE='23514'; END IF;
 IF NEW.status<>'pending' THEN
  IF NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM item_inventory_profiles profile WHERE profile.org_id=NEW.org_id AND profile.item_id=NEW.item_id AND
    ((profile.tracking='none' AND NEW.lot_id IS NULL AND NEW.serial_id IS NULL) OR (profile.tracking='lot' AND NEW.lot_id IS NOT NULL AND NEW.serial_id IS NULL) OR (profile.tracking='serial' AND NEW.serial_id IS NOT NULL AND NEW.lot_id IS NULL AND NEW.quantity=1) OR (profile.tracking='lot_serial' AND NEW.lot_id IS NOT NULL AND NEW.serial_id IS NOT NULL AND NEW.quantity=1))) THEN
    RAISE EXCEPTION 'Operation inspection identifiers must match the produced item tracking policy.' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.measurements)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(NEW.measurements) supplied(key) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plan_snapshot->'measures') measure WHERE measure->>'key'=supplied.key))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plan_snapshot->'measures') measure WHERE (measure->>'required')::boolean AND coalesce(NEW.measurements->> (measure->>'key'),'')='')
   OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.measurements) reading WHERE reading.value<>'' AND reading.value !~ '^-?[0-9]+([.][0-9]{1,4})?$')
   OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.measurements) reading WHERE CASE WHEN reading.value ~ '^-?[0-9]+([.][0-9]{1,4})?$' THEN abs(reading.value::numeric)>999999999999999.9999 ELSE false END) THEN
   RAISE EXCEPTION 'Inspection result requires exact known measurements and every required reading.' USING ERRCODE='23514';
  END IF;
  IF NEW.status='pass' AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.plan_snapshot->'measures') measure WHERE nullif(NEW.measurements->>(measure->>'key'),'') IS NOT NULL
    AND ((measure->>'minimum' IS NOT NULL AND (NEW.measurements->>(measure->>'key'))::numeric<(measure->>'minimum')::numeric)
      OR (measure->>'maximum' IS NOT NULL AND (NEW.measurements->>(measure->>'key'))::numeric>(measure->>'maximum')::numeric))) THEN
    RAISE EXCEPTION 'An out-of-range frozen measurement cannot pass inspection.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.lot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lots WHERE org_id=NEW.org_id AND id=NEW.lot_id AND item_id=NEW.item_id) THEN RAISE EXCEPTION 'Inspection lot must identify its item.' USING ERRCODE='23514'; END IF;
 IF NEW.serial_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM serials WHERE org_id=NEW.org_id AND id=NEW.serial_id AND item_id=NEW.item_id AND (NEW.lot_id IS NULL OR lot_id IS NOT DISTINCT FROM NEW.lot_id)) THEN RAISE EXCEPTION 'Inspection serial must identify its item and lot.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_inspection_guard BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_inspections FOR EACH ROW EXECUTE FUNCTION public.inventory_inspection_guard();
CREATE FUNCTION public.inventory_inspection_scrap_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE inspection inventory_inspections;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO inspection FROM inventory_inspections WHERE org_id=NEW.org_id AND id=NEW.id;
 IF inspection.scrap_movement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_movements movement JOIN journal_entries entry ON entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id WHERE movement.org_id=inspection.org_id AND movement.id=inspection.scrap_movement_id AND movement.status='posted' AND entry.status='posted' AND movement.item_id=inspection.item_id AND movement.subsidiary_id=inspection.subsidiary_id AND movement.stock_location_id=inspection.stock_location_id AND movement.lot_id IS NOT DISTINCT FROM inspection.lot_id AND movement.serial_id IS NOT DISTINCT FROM inspection.serial_id AND movement.quantity=-inspection.quantity AND inspection.disposition='scrap' AND inspection.disposition_result->>'movementId'=movement.id::text) THEN RAISE EXCEPTION 'Quality scrap requires its exact posted inventory disposition.' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_inspection_scrap_guard AFTER INSERT OR UPDATE ON public.inventory_inspections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_inspection_scrap_guard();

-- Released operations retain their inspection plan; completion cannot clear a hold for another identifier.
CREATE FUNCTION public.manufacturing_operation_inspection_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.inspection_plan_snapshot IS DISTINCT FROM OLD.inspection_plan_snapshot THEN
  RAISE EXCEPTION 'Released operations keep their inspection plan.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_operation_inspection_guard BEFORE UPDATE ON public.mfg_wo_operations FOR EACH ROW EXECUTE FUNCTION public.manufacturing_operation_inspection_guard();
CREATE FUNCTION public.inventory_inspection_rework_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.rework_completed_at IS NOT NULL AND OLD.rework_completed_at IS NULL AND NOT (
  NEW.rework_work_order_id IS NOT NULL AND EXISTS(SELECT 1 FROM mfg_work_orders repair JOIN inventory_movements receipt ON receipt.org_id=repair.org_id JOIN journal_entries entry ON entry.org_id=receipt.org_id AND entry.id=receipt.journal_entry_id WHERE repair.org_id=NEW.org_id AND repair.id=NEW.rework_work_order_id AND repair.receipt_rework_inspection_id=NEW.id AND repair.quantity_completed>=NEW.quantity AND receipt.kind='assembly_build' AND receipt.quantity=NEW.quantity AND receipt.lot_id IS NOT DISTINCT FROM NEW.lot_id AND receipt.serial_id IS NOT DISTINCT FROM NEW.serial_id AND receipt.item_id=NEW.item_id AND receipt.status='posted' AND entry.status='posted' AND entry.custom->>'work_order_number'=repair.number)
  OR NEW.rework_work_order_id IS NOT NULL AND EXISTS(SELECT 1 FROM mfg_work_orders repair JOIN financial_changes loss ON loss.org_id=repair.org_id AND loss.id=repair.loss_change_id WHERE repair.org_id=NEW.org_id AND repair.id=NEW.rework_work_order_id AND repair.receipt_rework_inspection_id=NEW.id AND repair.status='cancelled' AND repair.quantity_completed=0 AND repair.quantity_scrapped=NEW.quantity AND loss.status='applied' AND loss.domain='manufacturing' AND loss.operation='work_order_loss_disposition' AND loss.subject_id=repair.id)
  OR EXISTS(
  SELECT 1 FROM mfg_wo_operations operation JOIN inventory_inspections repaired ON repaired.org_id=operation.org_id AND repaired.operation_id=operation.id
   WHERE operation.org_id=NEW.org_id AND operation.id=NEW.rework_operation_id AND operation.status='done' AND operation.quantity_done>=NEW.quantity
     AND repaired.status='pass' AND repaired.quantity>=NEW.quantity AND repaired.lot_id IS NOT DISTINCT FROM NEW.lot_id AND repaired.serial_id IS NOT DISTINCT FROM NEW.serial_id
     AND NOT EXISTS(SELECT 1 FROM inventory_inspections newer WHERE newer.org_id=repaired.org_id AND newer.operation_id=repaired.operation_id
       AND newer.lot_id IS NOT DISTINCT FROM repaired.lot_id AND newer.serial_id IS NOT DISTINCT FROM repaired.serial_id AND newer.inspection_sequence>repaired.inspection_sequence)
 )) THEN RAISE EXCEPTION 'Rework completion requires accepted evidence for the same stock and quantity.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_inspection_rework_guard BEFORE UPDATE ON public.inventory_inspections FOR EACH ROW EXECUTE FUNCTION public.inventory_inspection_rework_guard();

-- Recipe lines distinguish scalable unit/formula inputs from one charge per production batch.
ALTER TABLE public.bom_components ADD COLUMN quantity_basis text NOT NULL DEFAULT 'per_unit',ADD COLUMN formula_output_quantity numeric(19,4) NOT NULL DEFAULT 1;
ALTER TABLE public.bom_components ADD COLUMN output_cost_weight numeric(19,4);
ALTER TABLE public.bom_components ADD CONSTRAINT bom_components_output_cost_weight CHECK(output_cost_weight IS NULL OR (is_byproduct AND output_cost_weight>0));
ALTER TABLE public.bom_components ADD CONSTRAINT bom_components_quantity_basis CHECK(quantity_basis IN('per_unit','per_batch','per_formula') AND formula_output_quantity>0 AND (quantity_basis='per_formula' OR formula_output_quantity=1) AND (NOT is_byproduct OR quantity_basis<>'per_batch'));
ALTER TABLE public.mfg_wo_materials ADD COLUMN quantity_basis text NOT NULL DEFAULT 'per_unit',ADD COLUMN formula_output_quantity numeric(19,4) NOT NULL DEFAULT 1;
ALTER TABLE public.mfg_wo_materials ADD CONSTRAINT mfg_wo_materials_quantity_basis CHECK(quantity_basis IN('per_unit','per_batch','per_formula') AND formula_output_quantity>0 AND (quantity_basis='per_formula' OR formula_output_quantity=1));
CREATE FUNCTION public.manufacturing_material_formula_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF (to_jsonb(NEW)->'quantity_per',to_jsonb(NEW)->'scrap_pct',NEW.quantity_basis,NEW.formula_output_quantity,to_jsonb(NEW)->'output_cost_weight',to_jsonb(NEW)->'standard_cost_snapshot') IS DISTINCT FROM (to_jsonb(OLD)->'quantity_per',to_jsonb(OLD)->'scrap_pct',OLD.quantity_basis,OLD.formula_output_quantity,to_jsonb(OLD)->'output_cost_weight',to_jsonb(OLD)->'standard_cost_snapshot') THEN RAISE EXCEPTION 'Released material and output quantities retain their recipe, cost weights and standard snapshots.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_material_formula_guard BEFORE UPDATE ON public.mfg_wo_materials FOR EACH ROW EXECUTE FUNCTION public.manufacturing_material_formula_guard();

ALTER TABLE public.mfg_wo_byproducts ADD COLUMN quantity_basis text NOT NULL DEFAULT 'per_unit',ADD COLUMN formula_output_quantity numeric(19,4) NOT NULL DEFAULT 1;
ALTER TABLE public.mfg_wo_byproducts ADD COLUMN output_cost_weight numeric(19,4),ADD COLUMN standard_cost_snapshot numeric(19,4);
ALTER TABLE public.mfg_wo_byproducts ADD CONSTRAINT mfg_wo_byproducts_output_cost_weight CHECK(output_cost_weight IS NULL OR output_cost_weight>0);
ALTER TABLE public.mfg_wo_byproducts ADD CONSTRAINT mfg_wo_byproducts_standard_snapshot CHECK(standard_cost_snapshot IS NULL OR (output_cost_weight IS NOT NULL AND standard_cost_snapshot>=0));
ALTER TABLE public.mfg_wo_byproducts ADD CONSTRAINT mfg_wo_byproducts_quantity_basis CHECK(quantity_basis IN('per_unit','per_formula') AND formula_output_quantity>0 AND (quantity_basis='per_formula' OR formula_output_quantity=1));
CREATE TRIGGER manufacturing_byproduct_formula_guard BEFORE UPDATE ON public.mfg_wo_byproducts FOR EACH ROW EXECUTE FUNCTION public.manufacturing_material_formula_guard();

-- Company-owned vendor custody remains valued and is excluded from sale eligibility.
ALTER TABLE public.stock_locations ADD COLUMN custodian_party_id uuid;
ALTER TABLE public.stock_locations ADD CONSTRAINT stock_location_custodian_tenant
 FOREIGN KEY(org_id,custodian_party_id) REFERENCES public.parties(org_id,id);
ALTER TABLE public.stock_locations ADD CONSTRAINT stock_location_subcontract_custody
 CHECK((kind='subcontract')=(custodian_party_id IS NOT NULL) AND (kind<>'subcontract' OR inventory_ownership='owned'));
CREATE FUNCTION public.stock_location_custody_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE parent_kind text; parent_vendor uuid;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.kind,NEW.custodian_party_id,NEW.location_id,NEW.parent_id) IS DISTINCT FROM (OLD.kind,OLD.custodian_party_id,OLD.location_id,OLD.parent_id)
   AND (NEW.kind='subcontract' OR OLD.kind='subcontract') THEN
  IF EXISTS(SELECT 1 FROM public.inventory_movements WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.cost_layers WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.inventory_provisional_costs WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.consignment_stock WHERE org_id=OLD.org_id AND stock_location_id=OLD.id)
    OR EXISTS(SELECT 1 FROM public.stock_locations WHERE org_id=OLD.org_id AND parent_id=OLD.id) THEN
   RAISE EXCEPTION 'Vendor custody identity is fixed after stock history or children; configure another location.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.kind='subcontract' THEN
  PERFORM id FROM public.parties WHERE org_id=NEW.org_id AND id=NEW.custodian_party_id FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM public.parties p WHERE p.org_id=NEW.org_id AND p.id=NEW.custodian_party_id AND p.is_active
    AND (p.kind='vendor' OR EXISTS(SELECT 1 FROM public.vendor_roles v WHERE v.org_id=p.org_id AND v.party_id=p.id))) THEN
   RAISE EXCEPTION 'Choose an active vendor for company-owned custody.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.parent_id IS NOT NULL THEN
  SELECT kind,custodian_party_id INTO parent_kind,parent_vendor FROM public.stock_locations WHERE org_id=NEW.org_id AND id=NEW.parent_id FOR SHARE;
  IF parent_kind='subcontract' AND (NEW.kind<>'subcontract' OR NEW.custodian_party_id IS DISTINCT FROM parent_vendor) THEN
   RAISE EXCEPTION 'Children of vendor custody must preserve the same vendor and custody kind.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_location_custody_guard BEFORE INSERT OR UPDATE OF kind,custodian_party_id,location_id,parent_id ON public.stock_locations
 FOR EACH ROW EXECUTE FUNCTION public.stock_location_custody_guard();

CREATE TABLE public.mfg_subcontracts (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 work_order_id uuid NOT NULL,operation_id uuid NOT NULL,vendor_id uuid NOT NULL,custody_location_id uuid NOT NULL,
 quantity_expected numeric(19,4) NOT NULL,
 status text NOT NULL DEFAULT 'ready',request_snapshot jsonb NOT NULL,cancel_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_subcontracts_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT mfg_subcontract_order_fk FOREIGN KEY(org_id,work_order_id) REFERENCES public.mfg_work_orders(org_id,id),
 CONSTRAINT mfg_subcontract_operation_fk FOREIGN KEY(org_id,operation_id) REFERENCES public.mfg_wo_operations(org_id,id),
 CONSTRAINT mfg_subcontract_vendor_fk FOREIGN KEY(org_id,vendor_id) REFERENCES public.parties(org_id,id),
 CONSTRAINT mfg_subcontract_custody_fk FOREIGN KEY(org_id,custody_location_id) REFERENCES public.stock_locations(org_id,id),
 CONSTRAINT mfg_subcontract_status CHECK(status IN('ready','sent','received','cancelled')),
 CONSTRAINT mfg_subcontract_expected_positive CHECK(quantity_expected>0),
 CONSTRAINT mfg_subcontract_cancel_reason CHECK((status='cancelled')=(cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX mfg_subcontract_open_operation ON public.mfg_subcontracts(org_id,operation_id) WHERE status<>'cancelled';
CREATE TABLE public.mfg_subcontract_shipments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 subcontract_id uuid NOT NULL,material_id uuid NOT NULL,source_location_id uuid NOT NULL,
 quantity numeric(19,4) NOT NULL,value numeric(19,4) NOT NULL,from_movement_id uuid NOT NULL,to_movement_id uuid NOT NULL,request_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_subcontract_shipments_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_from_unique UNIQUE(org_id,from_movement_id),
 CONSTRAINT mfg_subcontract_shipment_to_unique UNIQUE(org_id,to_movement_id),
 CONSTRAINT mfg_subcontract_shipment_contract_fk FOREIGN KEY(org_id,subcontract_id) REFERENCES public.mfg_subcontracts(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_material_fk FOREIGN KEY(org_id,material_id) REFERENCES public.mfg_wo_materials(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_source_fk FOREIGN KEY(org_id,source_location_id) REFERENCES public.stock_locations(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_from_fk FOREIGN KEY(org_id,from_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_to_fk FOREIGN KEY(org_id,to_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT mfg_subcontract_shipment_quantity_positive CHECK(quantity>0),
 CONSTRAINT mfg_subcontract_shipment_value_nonnegative CHECK(value>=0)
);
ALTER TABLE public.mfg_subcontracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_subcontracts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_subcontracts USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_subcontracts IS 'openbooks:org_isolation:v1';
ALTER TABLE public.mfg_subcontract_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_subcontract_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_subcontract_shipments USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_subcontract_shipments IS 'openbooks:org_isolation:v1';
CREATE TABLE public.mfg_subcontract_returns (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 subcontract_id uuid NOT NULL,quantity numeric(19,4) NOT NULL,request_snapshot jsonb NOT NULL,finish_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_subcontract_returns_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT mfg_subcontract_return_contract_fk FOREIGN KEY(org_id,subcontract_id) REFERENCES public.mfg_subcontracts(org_id,id),
 CONSTRAINT mfg_subcontract_return_positive CHECK(quantity>0),
 CONSTRAINT mfg_subcontract_return_reason CHECK(finish_reason IS NULL OR length(btrim(finish_reason)) BETWEEN 5 AND 500)
);
ALTER TABLE public.mfg_subcontract_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_subcontract_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_subcontract_returns USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_subcontract_returns IS 'openbooks:org_isolation:v1';
CREATE FUNCTION public.production_subcontract_return_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE expected numeric; previous numeric; losses numeric; contract_status text;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Vendor deliveries retain their physical return evidence.' USING ERRCODE='23514'; END IF;
 SELECT s.quantity_expected,s.status,o.quantity_scrapped_here INTO expected,contract_status,losses
 FROM public.mfg_subcontracts s JOIN public.mfg_wo_operations o ON o.org_id=s.org_id AND o.id=s.operation_id
 JOIN public.mfg_work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id
 WHERE s.org_id=NEW.org_id AND s.id=NEW.subcontract_id AND w.status IN('released','in_progress') AND o.status='running'
 FOR UPDATE OF s,o,w;
 IF expected IS NULL OR contract_status NOT IN('ready','sent') THEN RAISE EXCEPTION 'Record a delivery on the open vendor operation.' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum(quantity),0) INTO previous FROM public.mfg_subcontract_returns WHERE org_id=NEW.org_id AND subcontract_id=NEW.subcontract_id;
 IF previous+NEW.quantity+losses>expected OR NEW.request_snapshot->>'id' IS DISTINCT FROM NEW.id::text
  OR NEW.request_snapshot->>'subcontractId' IS DISTINCT FROM NEW.subcontract_id::text
  OR (NEW.request_snapshot->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
  OR jsonb_typeof(NEW.request_snapshot->'finish') IS DISTINCT FROM 'boolean'
  OR NEW.request_snapshot->>'finishReason' IS DISTINCT FROM NEW.finish_reason THEN
  RAISE EXCEPTION 'Vendor return quantity and its recorded request must agree with the remaining operation.' USING ERRCODE='23514';
 END IF;
 IF NEW.request_snapshot->>'finish'='true' AND previous+NEW.quantity+losses<expected AND NEW.finish_reason IS NULL THEN
  RAISE EXCEPTION 'Finishing a vendor operation short requires a retained reason.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_subcontract_return_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_subcontract_returns FOR EACH ROW EXECUTE FUNCTION public.production_subcontract_return_guard();
CREATE FUNCTION public.production_subcontract_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Production subcontracts retain their history.' USING ERRCODE='23514';
 END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.org_id,NEW.work_order_id,NEW.operation_id,NEW.vendor_id,NEW.custody_location_id,NEW.quantity_expected,NEW.request_snapshot,NEW.created_at,NEW.created_by)
  IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.work_order_id,OLD.operation_id,OLD.vendor_id,OLD.custody_location_id,OLD.quantity_expected,OLD.request_snapshot,OLD.created_at,OLD.created_by) THEN
  RAISE EXCEPTION 'Production subcontract subject and vendor are immutable.' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mfg_wo_operations o JOIN public.stock_locations l ON l.org_id=o.org_id
  WHERE o.org_id=NEW.org_id AND o.id=NEW.operation_id AND o.work_order_id=NEW.work_order_id
    AND o.quantity_planned=NEW.quantity_expected AND o.backflush_at='none'
    AND l.id=NEW.custody_location_id AND l.kind='subcontract' AND l.inventory_ownership='owned' AND l.custodian_party_id=NEW.vendor_id) THEN
  RAISE EXCEPTION 'Use the released operation and its matching company-owned vendor custody location.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND NOT (
   (OLD.status='ready' AND NEW.status IN('sent','received','cancelled')) OR (OLD.status='sent' AND NEW.status='received')) THEN
  RAISE EXCEPTION 'Invalid production subcontract transition.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='received' AND NOT EXISTS(SELECT 1 FROM public.mfg_wo_operations o WHERE o.org_id=NEW.org_id AND o.id=NEW.operation_id AND o.status='done'
   AND o.quantity_done=(SELECT coalesce(sum(quantity),0) FROM public.mfg_subcontract_returns WHERE org_id=NEW.org_id AND subcontract_id=NEW.id)
   AND EXISTS(SELECT 1 FROM public.mfg_subcontract_returns WHERE org_id=NEW.org_id AND subcontract_id=NEW.id AND request_snapshot->>'finish'='true')) THEN
  RAISE EXCEPTION 'Finish the actual returned vendor operation before closing its subcontract.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='cancelled' AND (length(btrim(NEW.cancel_reason)) NOT BETWEEN 5 AND 500
   OR EXISTS(SELECT 1 FROM public.mfg_subcontract_shipments WHERE org_id=NEW.org_id AND subcontract_id=NEW.id)
   OR EXISTS(SELECT 1 FROM public.mfg_subcontract_returns WHERE org_id=NEW.org_id AND subcontract_id=NEW.id)
   OR EXISTS(SELECT 1 FROM public.mfg_subcontract_service_bills WHERE org_id=NEW.org_id AND subcontract_id=NEW.id AND reversal_entry_id IS NULL)) THEN
  RAISE EXCEPTION 'Only a subcontract without physical or active cost activity may be cancelled, with a reason.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_subcontract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_subcontracts FOR EACH ROW EXECUTE FUNCTION public.production_subcontract_guard();
CREATE FUNCTION public.production_subcontract_shipment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Posted production shipments are immutable; return stock through native transfers.' USING ERRCODE='23514'; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mfg_subcontracts s
   JOIN public.mfg_work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id
   JOIN public.mfg_wo_materials material ON material.org_id=w.org_id AND material.work_order_id=w.id AND material.id=NEW.material_id
   JOIN public.inventory_movements outbound ON outbound.org_id=s.org_id AND outbound.id=NEW.from_movement_id
   JOIN public.inventory_movements inbound ON inbound.org_id=s.org_id AND inbound.id=NEW.to_movement_id
   WHERE s.org_id=NEW.org_id AND s.id=NEW.subcontract_id AND s.status IN('ready','sent')
     AND outbound.status='posted' AND inbound.status='posted' AND outbound.kind='transfer_out' AND inbound.kind='transfer_in'
     AND outbound.subsidiary_id=w.subsidiary_id AND inbound.subsidiary_id=w.subsidiary_id
     AND outbound.item_id=material.component_item_id AND inbound.item_id=material.component_item_id
     AND outbound.stock_location_id=NEW.source_location_id AND inbound.stock_location_id=s.custody_location_id
     AND inbound.paired_movement_id=outbound.id AND outbound.quantity=-NEW.quantity AND inbound.quantity=NEW.quantity
     AND outbound.total_value=-NEW.value AND inbound.total_value=NEW.value
     AND outbound.lot_id IS NOT DISTINCT FROM inbound.lot_id AND outbound.serial_id IS NOT DISTINCT FROM inbound.serial_id
     AND NOT EXISTS(SELECT 1 FROM public.inventory_movements reversal WHERE reversal.org_id=s.org_id AND reversal.reverses_movement_id IN(outbound.id,inbound.id) AND reversal.status='posted')) THEN
  RAISE EXCEPTION 'A production shipment requires its actual valued native transfer, operation material and vendor custody.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_subcontract_shipment_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_subcontract_shipments FOR EACH ROW EXECUTE FUNCTION public.production_subcontract_shipment_guard();

CREATE UNIQUE INDEX mfg_subcontract_consumption_request ON public.journal_entries(org_id,(custom->>'subcontract_consumption_key'))
 WHERE origin='manufacturing' AND reverses_entry_id IS NULL AND custom ? 'subcontract_consumption_key';
CREATE TABLE public.mfg_subcontract_service_bills (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subcontract_id uuid NOT NULL,bill_id uuid NOT NULL,
 source_entry_id uuid NOT NULL,capitalization_entry_id uuid,wip_account_id uuid NOT NULL,amount numeric(19,4) NOT NULL,expense_snapshot jsonb NOT NULL,
 reversal_entry_id uuid,reversal_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_subcontract_service_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT mfg_subcontract_service_contract_fk FOREIGN KEY(org_id,subcontract_id) REFERENCES public.mfg_subcontracts(org_id,id),
 CONSTRAINT mfg_subcontract_service_bill_fk FOREIGN KEY(org_id,bill_id) REFERENCES public.documents(org_id,id),
 CONSTRAINT mfg_subcontract_service_source_fk FOREIGN KEY(org_id,source_entry_id) REFERENCES public.journal_entries(org_id,id),
 CONSTRAINT mfg_subcontract_service_capitalization_fk FOREIGN KEY(org_id,capitalization_entry_id) REFERENCES public.journal_entries(org_id,id),
 CONSTRAINT mfg_subcontract_service_reversal_fk FOREIGN KEY(org_id,reversal_entry_id) REFERENCES public.journal_entries(org_id,id),
 CONSTRAINT mfg_subcontract_service_wip_fk FOREIGN KEY(org_id,wip_account_id) REFERENCES public.accounts(org_id,id),
 CONSTRAINT mfg_subcontract_service_nonnegative CHECK(amount>=0 AND (amount=0)=(capitalization_entry_id IS NULL)),
 CONSTRAINT mfg_subcontract_service_reversal_reason CHECK((reversal_entry_id IS NULL)=(reversal_reason IS NULL))
);
CREATE UNIQUE INDEX mfg_subcontract_service_active_bill ON public.mfg_subcontract_service_bills(org_id,bill_id) WHERE reversal_entry_id IS NULL;
ALTER TABLE public.mfg_subcontract_service_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_subcontract_service_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_subcontract_service_bills USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_subcontract_service_bills IS 'openbooks:org_isolation:v1';
CREATE FUNCTION public.production_subcontract_service_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE cost numeric; actual_expenses jsonb; wo_number text;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted production service costs retain their history.' USING ERRCODE='23514'; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.subcontract_id,NEW.bill_id,NEW.source_entry_id,NEW.capitalization_entry_id,NEW.wip_account_id,NEW.amount,NEW.expense_snapshot,NEW.created_at,NEW.created_by)
   IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.subcontract_id,OLD.bill_id,OLD.source_entry_id,OLD.capitalization_entry_id,OLD.wip_account_id,OLD.amount,OLD.expense_snapshot,OLD.created_at,OLD.created_by)
   OR OLD.reversal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'Production service cost is immutable; record a governed reversal.' USING ERRCODE='23514'; END IF;
  IF NEW.reversal_entry_id IS NULL OR length(btrim(NEW.reversal_reason)) NOT BETWEEN 5 AND 500
    OR NOT EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.reversal_entry_id AND e.reverses_entry_id=OLD.capitalization_entry_id AND e.status='posted') THEN
   RAISE EXCEPTION 'Use the actual posted service-cost reversal and its reason.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mfg_subcontracts s JOIN public.mfg_work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id
   JOIN public.documents d ON d.org_id=s.org_id AND d.id=NEW.bill_id
   JOIN public.journal_entries e ON e.org_id=d.org_id AND e.id=d.posted_entry_id
   WHERE s.org_id=NEW.org_id AND s.id=NEW.subcontract_id AND s.status IN('ready','sent','received')
     AND d.kind='vendor_bill' AND d.status='posted' AND d.party_id=s.vendor_id AND d.subsidiary_id=w.subsidiary_id
     AND e.id=NEW.source_entry_id AND e.source_document_id=d.id AND e.subsidiary_id=w.subsidiary_id AND e.status='posted' AND e.reverses_entry_id IS NULL) THEN
  RAISE EXCEPTION 'Production service cost requires its actual vendor bill and posted source journal.' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(l.amount),0),coalesce(jsonb_agg(jsonb_build_object('accountId',l.account_id::text,'amount',l.amount::text,'departmentId',l.department_id,'locationId',l.location_id) ORDER BY l.line_number),'[]'::jsonb) INTO cost,actual_expenses
  FROM public.journal_lines l JOIN public.accounts a ON a.org_id=l.org_id AND a.id=l.account_id
  WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.source_entry_id AND a.type IN('cogs','expense','expense_other');
 IF actual_expenses='[]'::jsonb OR NEW.amount<>cost OR NEW.expense_snapshot<>actual_expenses THEN
  RAISE EXCEPTION 'Capitalize the bill’s actual functional-currency service expense lines.' USING ERRCODE='23514';
 END IF;
 SELECT w.number INTO wo_number FROM public.mfg_subcontracts s JOIN public.mfg_work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id WHERE s.org_id=NEW.org_id AND s.id=NEW.subcontract_id;
 IF NEW.amount>0 AND (NOT EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.capitalization_entry_id AND e.origin='manufacturing' AND e.status='posted' AND e.reverses_entry_id IS NULL
    AND e.custom->>'work_order_number'=wo_number AND e.custom->>'subcontract_id'=NEW.subcontract_id::text AND e.custom->>'subcontract_service_bill_id'=NEW.bill_id::text AND e.custom->>'subcontract_service_claim_id'=NEW.id::text AND e.custom->>'source_bill_entry_id'=NEW.source_entry_id::text)
   OR (SELECT coalesce(sum(amount),0) FROM public.journal_lines WHERE org_id=NEW.org_id AND entry_id=NEW.capitalization_entry_id AND account_id=NEW.wip_account_id)<>NEW.amount) THEN
  RAISE EXCEPTION 'Use the balanced native manufacturing service-capitalization journal.' USING ERRCODE='23514';
 END IF;
 IF NEW.amount>0 AND EXISTS (
  WITH expected AS (SELECT l.account_id,l.subsidiary_id,l.department_id,l.location_id,sum(l.amount) AS amount
   FROM public.journal_lines l JOIN public.accounts a ON a.org_id=l.org_id AND a.id=l.account_id
   WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.source_entry_id AND a.type IN('cogs','expense','expense_other')
   GROUP BY l.account_id,l.subsidiary_id,l.department_id,l.location_id),
  actual AS (SELECT account_id,subsidiary_id,department_id,location_id,sum(-amount) AS amount FROM public.journal_lines
   WHERE org_id=NEW.org_id AND entry_id=NEW.capitalization_entry_id AND account_id<>NEW.wip_account_id
   GROUP BY account_id,subsidiary_id,department_id,location_id)
  SELECT 1 FROM expected e FULL JOIN actual a ON a.account_id=e.account_id AND a.subsidiary_id IS NOT DISTINCT FROM e.subsidiary_id
   AND a.department_id IS NOT DISTINCT FROM e.department_id AND a.location_id IS NOT DISTINCT FROM e.location_id
  WHERE e.account_id IS NULL OR a.account_id IS NULL OR e.amount<>a.amount
 ) THEN RAISE EXCEPTION 'Production capitalization must reverse the bill’s exact expense accounts and dimensions.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_subcontract_service_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_subcontract_service_bills FOR EACH ROW EXECUTE FUNCTION public.production_subcontract_service_guard();
CREATE FUNCTION public.production_service_bill_status_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF (NEW.status,NEW.posted_entry_id,NEW.party_id,NEW.subsidiary_id) IS DISTINCT FROM (OLD.status,OLD.posted_entry_id,OLD.party_id,OLD.subsidiary_id)
   AND EXISTS(SELECT 1 FROM public.mfg_subcontract_service_bills claim JOIN public.journal_entries cost ON cost.org_id=claim.org_id AND cost.id=claim.capitalization_entry_id
     WHERE claim.org_id=OLD.org_id AND claim.bill_id=OLD.id AND cost.status='posted' AND claim.reversal_entry_id IS NULL) THEN
  RAISE EXCEPTION 'Reverse the production service capitalization before correcting its vendor bill.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_service_bill_status_guard BEFORE UPDATE OF status,posted_entry_id,party_id,subsidiary_id ON public.documents FOR EACH ROW EXECUTE FUNCTION public.production_service_bill_status_guard();
CREATE FUNCTION public.production_service_reversal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE order_number text;
BEGIN
 IF NEW.reverses_entry_id IS NULL OR public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.mfg_subcontract_service_bills claim JOIN public.journal_entries cost ON cost.org_id=claim.org_id AND cost.id=claim.capitalization_entry_id
    WHERE claim.org_id=NEW.org_id AND claim.source_entry_id=NEW.reverses_entry_id AND cost.status='posted' AND claim.reversal_entry_id IS NULL) THEN
  RAISE EXCEPTION 'Reverse the production service capitalization before reversing its bill journal.' USING ERRCODE='23514';
 END IF;
 SELECT w.number INTO order_number FROM public.mfg_subcontract_service_bills claim JOIN public.mfg_subcontracts s ON s.org_id=claim.org_id AND s.id=claim.subcontract_id
    JOIN public.mfg_work_orders w ON w.org_id=s.org_id AND w.id=s.work_order_id WHERE claim.org_id=NEW.org_id AND claim.capitalization_entry_id=NEW.reverses_entry_id;
 IF order_number IS NOT NULL AND EXISTS(SELECT 1 FROM public.journal_entries e WHERE e.org_id=NEW.org_id AND e.origin='manufacturing' AND e.status='posted' AND e.reverses_entry_id IS NULL AND e.custom->>'work_order_number'=order_number AND e.custom ? 'completion_quantity') THEN
  RAISE EXCEPTION 'Reverse completed goods before reversing their production service cost.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_service_reversal_guard BEFORE INSERT ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.production_service_reversal_guard();

-- Only declared native identity fields are rebound; amounts, dates and fingerprints stay evidence.
CREATE FUNCTION public.production_clone_evidence(value jsonb,seed uuid,field_name text DEFAULT '',target_org uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE result jsonb; entry record; next_key text; scalar text; identity_field boolean;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 identity_field:=field_name='id' OR field_name~'(Id|Ids|_id|_ids)$' OR field_name IN('subcontract_consumption_key','requestKey','requestId');
 IF jsonb_typeof(value)='string' AND field_name='intent' THEN
  BEGIN RETURN to_jsonb(public.production_canonical_json(public.production_clone_evidence((value#>>'{}')::jsonb,seed,'',target_org))); EXCEPTION WHEN invalid_text_representation THEN RETURN value; END;
 END IF;
 IF jsonb_typeof(value)='string' AND identity_field THEN
  scalar:=value#>>'{}';
  IF scalar~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   IF field_name IN('orgId','org_id') AND target_org IS NOT NULL THEN RETURN to_jsonb(target_org::text); END IF;
   RETURN to_jsonb(public.ob_rebase(scalar::uuid,seed)::text);
  END IF;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(public.production_clone_evidence(element,seed,field_name,target_org) ORDER BY ordinal),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY a(element,ordinal);
  RETURN result;
 ELSIF jsonb_typeof(value)='object' THEN
  result:='{}'::jsonb;
  FOR entry IN SELECT key,item FROM jsonb_each(value) a(key,item) LOOP
   next_key:=entry.key;
   IF field_name='material_usage_variance_delta_by_component' AND next_key~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN next_key:=public.ob_rebase(next_key::uuid,seed)::text; END IF;
   result:=result||jsonb_build_object(next_key,CASE WHEN entry.key='custom' THEN entry.item ELSE public.production_clone_evidence(entry.item,seed,entry.key,target_org) END);
  END LOOP;
  RETURN result;
 END IF;
 RETURN value;
END $$;


-- Unused components return through their original shipment’s exact valued transfer lineage.
CREATE TABLE public.mfg_subcontract_material_returns (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subcontract_id uuid NOT NULL,shipment_id uuid NOT NULL,
 quantity numeric(19,4) NOT NULL,value numeric(19,4) NOT NULL,from_movement_id uuid NOT NULL,to_movement_id uuid NOT NULL,request_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_by uuid,
 CONSTRAINT mfg_subcontract_material_returns_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT mfg_subcontract_material_return_contract_fk FOREIGN KEY(org_id,subcontract_id) REFERENCES public.mfg_subcontracts(org_id,id),
 CONSTRAINT mfg_subcontract_material_return_shipment_fk FOREIGN KEY(org_id,shipment_id) REFERENCES public.mfg_subcontract_shipments(org_id,id),
 CONSTRAINT mfg_subcontract_material_return_from_fk FOREIGN KEY(org_id,from_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT mfg_subcontract_material_return_to_fk FOREIGN KEY(org_id,to_movement_id) REFERENCES public.inventory_movements(org_id,id),
 CONSTRAINT mfg_subcontract_material_return_quantity CHECK(quantity>0),CONSTRAINT mfg_subcontract_material_return_value CHECK(value>=0)
);
CREATE UNIQUE INDEX mfg_subcontract_material_return_from_unique ON public.mfg_subcontract_material_returns(org_id,from_movement_id);
CREATE UNIQUE INDEX mfg_subcontract_material_return_to_unique ON public.mfg_subcontract_material_returns(org_id,to_movement_id);
ALTER TABLE public.mfg_subcontract_material_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_subcontract_material_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_subcontract_material_returns USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.mfg_subcontract_material_returns IS 'openbooks:org_isolation:v1';
CREATE FUNCTION public.production_subcontract_material_return_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Component returns retain their native transfer evidence.' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.mfg_subcontract_shipments shipment
  JOIN public.mfg_subcontracts contract ON contract.org_id=shipment.org_id AND contract.id=shipment.subcontract_id
  JOIN public.mfg_work_orders work ON work.org_id=contract.org_id AND work.id=contract.work_order_id
  JOIN public.inventory_movements delivered ON delivered.org_id=shipment.org_id AND delivered.id=shipment.to_movement_id
  JOIN public.inventory_movements outbound ON outbound.org_id=shipment.org_id AND outbound.id=NEW.from_movement_id
  JOIN public.inventory_movements inbound ON inbound.org_id=shipment.org_id AND inbound.id=NEW.to_movement_id
  WHERE shipment.org_id=NEW.org_id AND shipment.id=NEW.shipment_id AND contract.id=NEW.subcontract_id
   AND delivered.status='posted' AND outbound.status='posted' AND inbound.status='posted'
   AND outbound.kind='transfer_out' AND inbound.kind='transfer_in' AND inbound.paired_movement_id=outbound.id
   AND outbound.stock_location_id=contract.custody_location_id AND inbound.stock_location_id=shipment.source_location_id
   AND outbound.item_id=delivered.item_id AND inbound.item_id=delivered.item_id
   AND outbound.subsidiary_id=work.subsidiary_id AND inbound.subsidiary_id=work.subsidiary_id
   AND outbound.lot_id IS NOT DISTINCT FROM delivered.lot_id AND inbound.lot_id IS NOT DISTINCT FROM delivered.lot_id
   AND outbound.serial_id IS NOT DISTINCT FROM delivered.serial_id AND inbound.serial_id IS NOT DISTINCT FROM delivered.serial_id
   AND outbound.quantity=-NEW.quantity AND inbound.quantity=NEW.quantity AND outbound.total_value=-NEW.value AND inbound.total_value=NEW.value
   AND (SELECT coalesce(sum(consumption.quantity),0) FROM public.cost_layer_consumptions consumption JOIN public.cost_layers layer ON layer.org_id=consumption.org_id AND layer.id=consumption.cost_layer_id
     WHERE consumption.org_id=NEW.org_id AND consumption.issue_movement_id=outbound.id AND layer.source_movement_id=delivered.id)=NEW.quantity
   AND NOT EXISTS(SELECT 1 FROM public.cost_layer_consumptions consumption JOIN public.cost_layers layer ON layer.org_id=consumption.org_id AND layer.id=consumption.cost_layer_id
     WHERE consumption.org_id=NEW.org_id AND consumption.issue_movement_id=outbound.id AND layer.source_movement_id IS DISTINCT FROM delivered.id)) THEN
  RAISE EXCEPTION 'Return unused stock through its actual original shipment and valued paired transfer.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_subcontract_material_return_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_subcontract_material_returns FOR EACH ROW EXECUTE FUNCTION public.production_subcontract_material_return_guard();


-- Retained conversion snapshots keep the work center’s original cost classification.
CREATE FUNCTION public.production_work_center_cost_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF (NEW.kind,NEW.absorbs_overhead) IS DISTINCT FROM (OLD.kind,OLD.absorbs_overhead)
  AND EXISTS(SELECT 1 FROM public.mfg_wo_operations WHERE org_id=OLD.org_id AND work_center_id=OLD.id) THEN
  RAISE EXCEPTION 'Create a new work center for a changed kind or overhead treatment; released operations retain their cost classification.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_work_center_cost_identity_guard BEFORE UPDATE OF kind,absorbs_overhead ON public.mfg_work_centers FOR EACH ROW EXECUTE FUNCTION public.production_work_center_cost_identity_guard();


-- Personal display mode augments the existing saved-view preference, preserving selected views.
ALTER TABLE public.user_list_preferences ADD COLUMN presentation text;
ALTER TABLE public.user_list_preferences ADD COLUMN view_selection_explicit boolean NOT NULL DEFAULT true;
ALTER TABLE public.user_list_preferences ADD CONSTRAINT user_list_preferences_presentation CHECK(presentation IS NULL OR presentation IN('list','board'));

-- Approved zero-output disposition retains consumed stock and recognizes actual conversion without a fictional receipt.
ALTER TABLE public.mfg_work_orders ADD COLUMN loss_change_id uuid;
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_work_order_loss_change_fk FOREIGN KEY(org_id,loss_change_id) REFERENCES public.financial_changes(org_id,id);
ALTER TABLE public.mfg_scrap_events ADD COLUMN disposition_change_id uuid;
ALTER TABLE public.mfg_scrap_events ADD CONSTRAINT mfg_scrap_disposition_change_fk FOREIGN KEY(org_id,disposition_change_id) REFERENCES public.financial_changes(org_id,id);
ALTER TABLE public.mfg_scrap_events DROP CONSTRAINT mfg_scrap_snapshot_operation_chk;
ALTER TABLE public.mfg_scrap_events ADD CONSTRAINT mfg_scrap_snapshot_operation_chk CHECK(treatment<>'operation' OR
 (classification='abnormal' AND operation_id IS NOT NULL AND component_item_id IS NULL
 AND (frozen_value>0 OR frozen_value=0 AND frozen_unit_cost=0 AND disposition_change_id IS NOT NULL)
 AND frozen_unit_cost IS NOT NULL AND frozen_unit_cost>=0 AND plan_fingerprint IS NULL AND lot_id IS NULL AND serial_id IS NULL AND approval_required IS NOT NULL));
CREATE UNIQUE INDEX mfg_scrap_one_loss_disposition ON public.mfg_scrap_events(org_id,disposition_change_id) WHERE disposition_change_id IS NOT NULL;
CREATE UNIQUE INDEX mfg_work_order_one_loss_change ON public.mfg_work_orders(org_id,loss_change_id) WHERE loss_change_id IS NOT NULL;
CREATE FUNCTION public.manufacturing_loss_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE change financial_changes; work mfg_work_orders; balance numeric;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.disposition_change_id IS NOT NULL THEN RAISE EXCEPTION 'Approved loss evidence is immutable.' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.disposition_change_id IS DISTINCT FROM OLD.disposition_change_id OR (OLD.disposition_change_id IS NOT NULL AND (to_jsonb(NEW)-ARRAY['updated_at','updated_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','updated_by'])) THEN RAISE EXCEPTION 'Approved loss evidence is immutable.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.disposition_change_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO change FROM financial_changes WHERE org_id=NEW.org_id AND id=NEW.disposition_change_id FOR SHARE;
 SELECT * INTO work FROM mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.work_order_id FOR UPDATE;
 IF change.id IS NULL OR work.id IS NULL OR change.domain<>'manufacturing' OR change.operation<>'work_order_loss_disposition' OR change.status<>'approved'
   OR change.subject_id<>work.id OR change.subsidiary_id IS DISTINCT FROM work.subsidiary_id OR work.status<>'on_hold' OR work.quantity_completed<>0
   OR NEW.classification<>'abnormal' OR NEW.treatment<>'operation' OR NEW.approval_required IS DISTINCT FROM true
   OR NEW.quantity<=0 OR NEW.quantity>work.quantity_ordered-work.quantity_scrapped
   OR NEW.quantity IS DISTINCT FROM (change.before_state->>'quantity')::numeric OR NEW.frozen_value IS DISTINCT FROM (change.before_state->>'value')::numeric
   OR NEW.frozen_unit_cost IS DISTINCT FROM round(NEW.frozen_value/NEW.quantity,4)
   OR NEW.operation_id::text IS DISTINCT FROM change.payload->'input'->>'operationId' OR NEW.reason_id::text IS DISTINCT FROM change.payload->'input'->>'reasonId'
   OR (NEW.frozen_value=0) IS DISTINCT FROM (NEW.posted_entry_id IS NULL)
   OR change.approved_by IS NULL OR NOT(change.approved_by<>change.submitted_by OR public.financial_change_self_decision_authorized(change.org_id,change.id,change.submitted_by)) THEN
   RAISE EXCEPTION 'Loss evidence requires its exact approved work, quantity, value and independent decision.' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(line.amount),0) INTO balance FROM journal_lines line JOIN journal_entries entry ON entry.org_id=line.org_id AND entry.id=line.entry_id
   WHERE line.org_id=NEW.org_id AND line.account_id::text=change.before_state->>'wipAccountId' AND entry.origin='manufacturing'
     AND entry.custom->>'work_order_number'=work.number AND entry.status IN('posted','reversed') AND entry.id IS DISTINCT FROM NEW.posted_entry_id;
 IF balance IS DISTINCT FROM NEW.frozen_value THEN RAISE EXCEPTION 'Loss recognizes all actual remaining WIP, including consumed conversion.' USING ERRCODE='23514'; END IF;
 IF NEW.posted_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries entry WHERE entry.org_id=NEW.org_id AND entry.id=NEW.posted_entry_id AND entry.status='posted'
   AND entry.origin='manufacturing' AND entry.subsidiary_id=work.subsidiary_id AND entry.custom->>'loss_change_id'=change.id::text AND entry.custom->>'scrap_event_id'=NEW.id::text
   AND (SELECT coalesce(sum(amount),0) FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=entry.id AND account_id::text=change.before_state->>'wipAccountId')=-NEW.frozen_value
   AND (SELECT coalesce(sum(amount),0) FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=entry.id AND account_id::text=change.before_state->>'lossAccountId')=NEW.frozen_value
   AND (SELECT count(*) FROM journal_lines WHERE org_id=NEW.org_id AND entry_id=entry.id)=2) THEN
   RAISE EXCEPTION 'Loss requires its exact balanced native write-off journal.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_loss_event_guard BEFORE INSERT OR UPDATE OR DELETE ON public.mfg_scrap_events FOR EACH ROW EXECUTE FUNCTION public.manufacturing_loss_event_guard();
CREATE FUNCTION public.manufacturing_loss_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.loss_change_id IS NOT NULL THEN RAISE EXCEPTION 'A production order starts without a loss disposition.' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.loss_change_id IS NOT NULL THEN
  IF (NEW.status,NEW.quantity_completed,NEW.quantity_scrapped,NEW.loss_change_id,NEW.cancel_reason) IS DISTINCT FROM (OLD.status,OLD.quantity_completed,OLD.quantity_scrapped,OLD.loss_change_id,OLD.cancel_reason) THEN RAISE EXCEPTION 'A disposed order retains its terminal loss evidence.' USING ERRCODE='23514'; END IF;
 ELSIF NEW.loss_change_id IS NOT NULL THEN
  IF OLD.status<>'on_hold' OR NEW.status<>'cancelled' OR NEW.quantity_completed<>0 OR NOT EXISTS(SELECT 1 FROM financial_changes change JOIN mfg_scrap_events event ON event.org_id=change.org_id AND event.disposition_change_id=change.id
   WHERE change.org_id=NEW.org_id AND change.id=NEW.loss_change_id AND change.subject_id=NEW.id AND change.domain='manufacturing' AND change.operation='work_order_loss_disposition' AND change.status='approved'
   AND event.work_order_id=NEW.id AND event.quantity=NEW.quantity_scrapped-OLD.quantity_scrapped AND NEW.cancel_reason=change.reason) THEN
   RAISE EXCEPTION 'Closing as loss requires its approved actual scrap and WIP evidence.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_loss_order_guard BEFORE INSERT OR UPDATE ON public.mfg_work_orders FOR EACH ROW EXECUTE FUNCTION public.manufacturing_loss_order_guard();

CREATE FUNCTION public.manufacturing_loss_completion_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE event mfg_scrap_events; change financial_changes; work mfg_work_orders; balance numeric;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO event FROM mfg_scrap_events WHERE org_id=NEW.org_id AND id=NEW.id;
 IF event.disposition_change_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO change FROM financial_changes WHERE org_id=event.org_id AND id=event.disposition_change_id;
 SELECT * INTO work FROM mfg_work_orders WHERE org_id=event.org_id AND id=event.work_order_id;
 SELECT coalesce(sum(line.amount),0) INTO balance FROM journal_lines line JOIN journal_entries entry ON entry.org_id=line.org_id AND entry.id=line.entry_id WHERE line.org_id=event.org_id AND line.account_id::text=change.before_state->>'wipAccountId' AND entry.origin='manufacturing' AND entry.custom->>'work_order_number'=work.number AND entry.status IN('posted','reversed');
 IF change.status IS DISTINCT FROM 'applied' OR change.result->>'eventId' IS DISTINCT FROM event.id::text OR change.result->>'entryId' IS DISTINCT FROM event.posted_entry_id::text OR work.loss_change_id IS DISTINCT FROM change.id OR work.status<>'cancelled' OR work.quantity_completed<>0 OR balance<>0 THEN
  RAISE EXCEPTION 'Loss disposition must finish its governed order, exact journal and zero remaining WIP atomically.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manufacturing_loss_completion_guard AFTER INSERT OR UPDATE ON public.mfg_scrap_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_loss_completion_guard();
CREATE FUNCTION public.manufacturing_loss_journal_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status='posted' AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS(SELECT 1 FROM mfg_work_orders work WHERE work.org_id=OLD.org_id AND work.number=OLD.custom->>'work_order_number' AND work.loss_change_id IS NOT NULL) THEN
  RAISE EXCEPTION 'A disposed production loss retains its journal. Record an approved adjusting journal for a financial correction; discarded stock and work cannot be recreated by reversal.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW.reverses_entry_id IS NOT NULL AND EXISTS(SELECT 1 FROM journal_entries source JOIN mfg_work_orders work ON work.org_id=source.org_id AND work.number=source.custom->>'work_order_number' WHERE source.org_id=NEW.org_id AND source.id=NEW.reverses_entry_id AND work.loss_change_id IS NOT NULL) THEN
  RAISE EXCEPTION 'A disposed production loss requires an adjusting journal rather than a reversal that would recreate WIP.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_loss_journal_guard BEFORE INSERT OR UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.manufacturing_loss_journal_guard();

-- Receipt repairs retain the failed-stock identity and reuse native release, conversion and completion postings.
ALTER TABLE public.mfg_work_orders ADD COLUMN receipt_rework_inspection_id uuid;
ALTER TABLE public.mfg_work_orders ADD COLUMN receipt_rework_sequence integer;
ALTER TABLE public.inventory_inspections ADD COLUMN rework_work_order_id uuid;
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_receipt_rework_source_fk FOREIGN KEY(org_id,receipt_rework_inspection_id) REFERENCES public.inventory_inspections(org_id,id);
ALTER TABLE public.inventory_inspections ADD CONSTRAINT inspection_rework_work_fk FOREIGN KEY(org_id,rework_work_order_id) REFERENCES public.mfg_work_orders(org_id,id);
ALTER TABLE public.mfg_work_orders ADD CONSTRAINT mfg_receipt_rework_pair CHECK((receipt_rework_inspection_id IS NULL AND receipt_rework_sequence IS NULL) OR (receipt_rework_inspection_id IS NOT NULL AND receipt_rework_sequence>0));
CREATE UNIQUE INDEX mfg_one_receipt_rework ON public.mfg_work_orders(org_id,receipt_rework_inspection_id) WHERE receipt_rework_inspection_id IS NOT NULL;
CREATE UNIQUE INDEX inspection_one_receipt_rework_work ON public.inventory_inspections(org_id,rework_work_order_id) WHERE rework_work_order_id IS NOT NULL;
CREATE FUNCTION public.manufacturing_receipt_rework_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE failed inventory_inspections;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.receipt_rework_inspection_id IS NOT NULL AND
  (NEW.receipt_rework_inspection_id,NEW.receipt_rework_sequence,NEW.produced_item_id,NEW.subsidiary_id,NEW.quantity_ordered,NEW.issue_location_id) IS DISTINCT FROM
  (OLD.receipt_rework_inspection_id,OLD.receipt_rework_sequence,OLD.produced_item_id,OLD.subsidiary_id,OLD.quantity_ordered,OLD.issue_location_id) THEN
  RAISE EXCEPTION 'A repair retains its inspected item, entity, source location, quantity and operation.' USING ERRCODE='23514';
 END IF;
 IF NEW.receipt_rework_inspection_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO failed FROM inventory_inspections WHERE org_id=NEW.org_id AND id=NEW.receipt_rework_inspection_id FOR SHARE;
 IF failed.id IS NULL OR failed.status<>'fail' OR failed.receipt_movement_id IS NULL OR failed.item_id<>NEW.produced_item_id OR failed.subsidiary_id<>NEW.subsidiary_id OR failed.stock_location_id<>NEW.issue_location_id OR failed.quantity<>NEW.quantity_ordered THEN
  RAISE EXCEPTION 'A repair requires its exact failed receipt and original stock identity.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='cancelled' AND NEW.loss_change_id IS NULL THEN RAISE EXCEPTION 'Resolve a received-stock repair through completion or approved loss; its original stock remains held.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_receipt_rework_order_guard BEFORE INSERT OR UPDATE ON public.mfg_work_orders FOR EACH ROW EXECUTE FUNCTION public.manufacturing_receipt_rework_order_guard();
CREATE FUNCTION public.manufacturing_receipt_rework_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE work mfg_work_orders; failed inventory_inspections;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO work FROM mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.id;
 IF work.receipt_rework_inspection_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO failed FROM inventory_inspections WHERE org_id=work.org_id AND id=work.receipt_rework_inspection_id;
 IF failed.disposition IS DISTINCT FROM 'rework' OR failed.rework_work_order_id IS DISTINCT FROM work.id OR failed.disposition_result->>'workOrderId' IS DISTINCT FROM work.id::text THEN
  RAISE EXCEPTION 'A receipt repair and its failed-stock disposition must be linked atomically.' USING ERRCODE='23514';
 END IF;
 IF work.status NOT IN('draft','cancelled') AND (SELECT count(*) FROM mfg_wo_operations operation WHERE operation.org_id=work.org_id AND operation.work_order_id=work.id AND operation.sequence=work.receipt_rework_sequence AND operation.backflush_at='none' AND operation.inspection_plan_snapshot=failed.plan_snapshot||jsonb_build_object('point','operation','operationSequence',work.receipt_rework_sequence))<>1 THEN
  RAISE EXCEPTION 'A released repair requires its selected operation, original frozen acceptance plan and manual stock issue.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manufacturing_receipt_rework_link_guard AFTER INSERT OR UPDATE ON public.mfg_work_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_receipt_rework_link_guard();
CREATE FUNCTION public.manufacturing_receipt_rework_movement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE movement inventory_movements; work mfg_work_orders; failed inventory_inspections;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO movement FROM inventory_movements WHERE org_id=NEW.org_id AND id=NEW.id;
 IF movement.kind NOT IN('assembly_consume','assembly_build') THEN RETURN NULL; END IF;
 SELECT order_row.* INTO work FROM mfg_work_orders order_row JOIN journal_entries entry ON entry.org_id=order_row.org_id AND entry.custom->>'work_order_number'=order_row.number WHERE entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id AND entry.origin='manufacturing' AND order_row.receipt_rework_inspection_id IS NOT NULL;
 IF work.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO failed FROM inventory_inspections WHERE org_id=work.org_id AND id=work.receipt_rework_inspection_id;
 IF movement.item_id<>failed.item_id OR movement.subsidiary_id<>failed.subsidiary_id OR movement.lot_id IS DISTINCT FROM failed.lot_id OR movement.serial_id IS DISTINCT FROM failed.serial_id OR abs(movement.quantity)<>failed.quantity OR movement.status<>'posted' THEN
  RAISE EXCEPTION 'Repair movements retain the original inspected item, entity, identifier and full quantity.' USING ERRCODE='23514';
 END IF;
 IF movement.kind='assembly_consume' AND (movement.stock_location_id<>failed.stock_location_id OR
   (SELECT coalesce(sum(consumption.quantity),0) FROM cost_layer_consumptions consumption JOIN cost_layers layer ON layer.org_id=consumption.org_id AND layer.id=consumption.cost_layer_id WHERE consumption.org_id=movement.org_id AND consumption.issue_movement_id=movement.id AND layer.source_movement_id=failed.receipt_movement_id)<>failed.quantity OR
   EXISTS(SELECT 1 FROM cost_layer_consumptions consumption JOIN cost_layers layer ON layer.org_id=consumption.org_id AND layer.id=consumption.cost_layer_id WHERE consumption.org_id=movement.org_id AND consumption.issue_movement_id=movement.id AND layer.source_movement_id IS DISTINCT FROM failed.receipt_movement_id)) THEN
  RAISE EXCEPTION 'Repair consumption requires the exact original receipt cost layers.' USING ERRCODE='23514';
 END IF;
 IF movement.kind='assembly_build' AND (movement.stock_location_id<>work.receipt_location_id OR NOT EXISTS(
   SELECT 1 FROM mfg_wo_operations operation JOIN inventory_inspections accepted ON accepted.org_id=operation.org_id AND accepted.operation_id=operation.id WHERE operation.org_id=work.org_id AND operation.work_order_id=work.id AND operation.sequence=work.receipt_rework_sequence AND operation.status='done' AND operation.quantity_done>=failed.quantity AND accepted.status='pass' AND accepted.quantity>=failed.quantity AND accepted.lot_id IS NOT DISTINCT FROM failed.lot_id AND accepted.serial_id IS NOT DISTINCT FROM failed.serial_id)) THEN
  RAISE EXCEPTION 'Repair output requires its passed frozen inspection and original stock identity.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manufacturing_receipt_rework_movement_guard AFTER INSERT ON public.inventory_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_receipt_rework_movement_guard();

-- Required operation inspections cover the actual identifiers and cumulative live output.
CREATE FUNCTION public.manufacturing_inspected_output_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE movement inventory_movements; work mfg_work_orders; operation mfg_wo_operations; accepted inventory_inspections; total_goods numeric; identifier_goods numeric;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO movement FROM inventory_movements WHERE org_id=NEW.org_id AND id=NEW.id;
 IF movement.kind<>'assembly_build' OR movement.quantity<=0 OR movement.status<>'posted' OR movement.reverses_movement_id IS NOT NULL THEN RETURN NULL; END IF;
 SELECT order_row.* INTO work FROM mfg_work_orders order_row JOIN journal_entries entry
   ON entry.org_id=order_row.org_id AND entry.custom->>'work_order_number'=order_row.number
   WHERE entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id AND entry.origin='manufacturing'
     AND entry.status='posted' AND entry.reverses_entry_id IS NULL AND order_row.produced_item_id=movement.item_id;
 IF work.id IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(sum(receipt.quantity),0),coalesce(sum(receipt.quantity) FILTER(WHERE receipt.lot_id IS NOT DISTINCT FROM movement.lot_id AND receipt.serial_id IS NOT DISTINCT FROM movement.serial_id),0)
   INTO total_goods,identifier_goods FROM inventory_movements receipt JOIN journal_entries entry ON entry.org_id=receipt.org_id AND entry.id=receipt.journal_entry_id
   WHERE receipt.org_id=work.org_id AND receipt.item_id=work.produced_item_id AND receipt.kind='assembly_build' AND receipt.quantity>0
     AND receipt.status='posted' AND receipt.reverses_movement_id IS NULL AND entry.origin='manufacturing' AND entry.status='posted'
     AND entry.reverses_entry_id IS NULL AND entry.custom->>'work_order_number'=work.number;
 FOR operation IN SELECT * FROM mfg_wo_operations WHERE org_id=work.org_id AND work_order_id=work.id AND inspection_plan_snapshot IS NOT NULL LOOP
  IF operation.status<>'done' OR total_goods>operation.quantity_done OR EXISTS(SELECT 1 FROM inventory_inspections inspection
    WHERE inspection.org_id=work.org_id AND inspection.operation_id=operation.id AND (inspection.status='pending'
      OR inspection.status='fail' AND (inspection.disposition IS NULL OR inspection.disposition='rework' AND inspection.rework_completed_at IS NULL))) THEN
   RAISE EXCEPTION 'Finished output requires completed operations and resolved inspections covering its quantity.' USING ERRCODE='23514';
  END IF;
  SELECT * INTO accepted FROM inventory_inspections inspection WHERE inspection.org_id=work.org_id AND inspection.operation_id=operation.id
    AND inspection.lot_id IS NOT DISTINCT FROM movement.lot_id AND inspection.serial_id IS NOT DISTINCT FROM movement.serial_id
    ORDER BY inspection.inspection_sequence DESC LIMIT 1;
  IF accepted.id IS NULL OR identifier_goods>accepted.quantity OR NOT coalesce(accepted.status='pass' OR accepted.disposition='use_as_is' OR accepted.disposition='rework' AND accepted.rework_completed_at IS NOT NULL,false) THEN
   RAISE EXCEPTION 'Finished output identifiers and quantity must match accepted operation inspections.' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER manufacturing_inspected_output_guard AFTER INSERT ON public.inventory_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_inspected_output_guard();

-- Execution updates counters and timestamps, never the released definition.
CREATE FUNCTION public.manufacturing_snapshot_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE mutable_fields text[];
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Released production snapshots cannot be deleted.' USING ERRCODE='23514'; END IF;
 mutable_fields:=CASE TG_TABLE_NAME
  WHEN 'mfg_wo_operations' THEN ARRAY['status','quantity_done','quantity_scrapped_here','measured_qty','actual_setup_minutes','actual_run_minutes','actual_labor_minutes','operator_user_id','started_at','completed_at','pause_reason','updated_at','updated_by']
  WHEN 'mfg_wo_materials' THEN ARRAY['issued_qty','backflush_qty','waived_at','waived_by','waive_reason','updated_at','updated_by']
  ELSE ARRAY['updated_at','updated_by'] END;
 IF (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
  RAISE EXCEPTION 'Released operations keep their labor, material, output and revision configuration.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_snapshot_configuration_guard BEFORE UPDATE OR DELETE ON public.mfg_wo_operations FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_configuration_guard();
CREATE TRIGGER manufacturing_snapshot_configuration_guard BEFORE UPDATE OR DELETE ON public.mfg_wo_materials FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_configuration_guard();
CREATE TRIGGER manufacturing_snapshot_configuration_guard BEFORE UPDATE OR DELETE ON public.mfg_wo_byproducts FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_configuration_guard();

CREATE FUNCTION public.manufacturing_snapshot_addition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE work mfg_work_orders;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO work FROM mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.work_order_id;
 IF work.id IS NULL OR work.released_at IS NULL OR work.released_at>=transaction_timestamp() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='mfg_wo_operations' AND EXISTS(SELECT 1 FROM inventory_inspections failed
   JOIN mfg_wo_operations operation ON operation.org_id=failed.org_id AND operation.id=failed.rework_operation_id
   JOIN mfg_wo_operations original ON original.org_id=failed.org_id AND original.id=failed.operation_id
   WHERE failed.org_id=NEW.org_id AND failed.work_order_id=NEW.work_order_id AND failed.status='fail' AND failed.disposition='rework'
     AND operation.id=NEW.id AND operation.work_order_id=work.id AND operation.quantity_planned=failed.quantity
     AND operation.work_center_id=original.work_center_id AND operation.inspection_plan_snapshot=failed.plan_snapshot
     AND operation.backflush_at='none' AND operation.labor_time_source=original.labor_time_source
     AND (to_jsonb(operation)-ARRAY['id','sequence','name','quantity_planned','backflush_at','status','quantity_done','quantity_scrapped_here','measured_qty','actual_setup_minutes','actual_run_minutes','actual_labor_minutes','operator_user_id','started_at','completed_at','pause_reason','created_at','created_by','updated_at','updated_by'])
       =(to_jsonb(original)-ARRAY['id','sequence','name','quantity_planned','backflush_at','status','quantity_done','quantity_scrapped_here','measured_qty','actual_setup_minutes','actual_run_minutes','actual_labor_minutes','operator_user_id','started_at','completed_at','pause_reason','created_at','created_by','updated_at','updated_by'])) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'A released production definition accepts new operations only through its recorded inspection rework disposition.' USING ERRCODE='23514';
END $$;
CREATE CONSTRAINT TRIGGER manufacturing_snapshot_addition_guard AFTER INSERT ON public.mfg_wo_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_addition_guard();
CREATE CONSTRAINT TRIGGER manufacturing_snapshot_addition_guard AFTER INSERT ON public.mfg_wo_materials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_addition_guard();
CREATE CONSTRAINT TRIGGER manufacturing_snapshot_addition_guard AFTER INSERT ON public.mfg_wo_byproducts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.manufacturing_snapshot_addition_guard();

-- Rebased frozen documents receive the same canonical SHA-256 representation as native release snapshots.
CREATE FUNCTION public.production_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE result text;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(value)='object' THEN
  SELECT '{'||coalesce(string_agg(to_json(key)::text||':'||public.production_canonical_json(item),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) object(key,item);RETURN result;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT '['||coalesce(string_agg(public.production_canonical_json(item),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY array_item(item,ordinal);RETURN result;
 ELSIF jsonb_typeof(value)='number' AND position('.' IN value::text)>0 THEN
  RETURN trim(trailing '.' FROM trim(trailing '0' FROM value::text));
 END IF;
 RETURN value::text;
END $$;
CREATE FUNCTION public.production_clone_journal_evidence(value jsonb,seed uuid,target_org uuid,masked boolean) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE selected jsonb;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF NOT masked THEN RETURN public.production_clone_evidence(value,seed,'custom',target_org); END IF;
 -- Native accounting and trace links survive masking; arbitrary tenant fields and free text do not.
 SELECT coalesce(jsonb_object_agg(key,item),'{}'::jsonb) INTO selected FROM jsonb_each(value) object(key,item)
 WHERE key=ANY(ARRAY['work_order_number','bom_revision','routing_version','settlement_scope','operation_id','operation_sequence','conversion_labor_amount','conversion_overhead_amount','conversion_disposition','conversion','time_entry_id','time_entry_ids','labor_minutes_delta','labor_amount_delta','overhead_amount_delta','completion_quantity','completed_quantity','material_usage_variance_cumulative','material_usage_variance_delta_by_component','relieved_labor','relieved_overhead','labor_variance','overhead_variance','scrap_event_id','loss_change_id','loss_quantity','loss_value','subcontract_id','subcontract_consumption_key','subcontract_service_claim_id','subcontract_service_bill_id','subcontract_source_entry_id','subcontract_service_amount','subcontract_service_reversal_of','source_bill_entry_id','source_expenses','amends_time_entry_id','corrects_time_entry_id','byproductNrv','jointOutputCosts']);
 RETURN public.production_mask_evidence(public.production_clone_evidence(selected,seed,'custom',target_org));
END $$;

-- Frozen native documents keep operational structure while removing user-authored prose in masked copies.
CREATE FUNCTION public.production_mask_evidence(value jsonb,field_name text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE result jsonb; entry record;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(value)='string' AND field_name='intent' THEN
  BEGIN RETURN to_jsonb(public.production_canonical_json(public.production_mask_evidence((value#>>'{}')::jsonb))); EXCEPTION WHEN invalid_text_representation THEN RETURN to_jsonb('REDACTED'::text); END;
 END IF;
 IF jsonb_typeof(value)='string' AND field_name IN('requestKey','requestId') AND (value#>>'{}')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN to_jsonb('masked-'||md5(value#>>'{}')); END IF;
 IF jsonb_typeof(value)='string' AND lower(field_name)=ANY(ARRAY['reason','name','label','description','notes','memo','subjectlabel','finishreason','shortclosereason','singular','plural']) THEN RETURN to_jsonb('REDACTED'::text); END IF;
 IF jsonb_typeof(value)='object' THEN
  result:='{}'::jsonb;
  FOR entry IN SELECT key,item FROM jsonb_each(value) object(key,item) LOOP
   result:=result||jsonb_build_object(entry.key,CASE WHEN entry.key='custom' THEN '{}'::jsonb ELSE public.production_mask_evidence(entry.item,entry.key) END);
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(public.production_mask_evidence(item,field_name) ORDER BY ordinal),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) WITH ORDINALITY array_item(item,ordinal);RETURN result;
 END IF;
 RETURN value;
END $$;
CREATE FUNCTION public.production_clone_safe_evidence(value jsonb,seed uuid,field_name text,target_org uuid,masked boolean) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
DECLARE result jsonb;
BEGIN
 result:=public.production_clone_evidence(value,seed,field_name,target_org);
 RETURN CASE WHEN masked THEN public.production_mask_evidence(result) ELSE result END;
END $$;


-- A recipe already used by governed production changes only through its approved replacement.
CREATE FUNCTION public.production_bom_line_evidence(value jsonb,stored boolean) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_catalog AS $$
BEGIN
 IF stored THEN
  RETURN jsonb_build_object('componentItemId',value->>'component_item_id','quantityPer',(value->>'quantity_per')::numeric,'sortOrder',(value->>'sort_order')::integer,
   'effectiveFrom',value->>'effective_from','effectiveTo',value->>'effective_to','operationSeq',(value->>'operation_seq')::integer,'scrapPct',coalesce((value->>'scrap_pct')::numeric,0),
   'isByproduct',(value->>'is_byproduct')::boolean,'quantityBasis',value->>'quantity_basis','formulaOutputQuantity',(value->>'formula_output_quantity')::numeric,'outputCostWeight',(value->>'output_cost_weight')::numeric);
 END IF;
 RETURN jsonb_build_object('componentItemId',value->>'componentItemId','quantityPer',(value->>'quantityPer')::numeric,'sortOrder',(value->>'sortOrder')::integer,
  'effectiveFrom',value->>'effectiveFrom','effectiveTo',value->>'effectiveTo','operationSeq',(value->>'operationSeq')::integer,'scrapPct',coalesce((value->>'scrapPct')::numeric,0),
  'isByproduct',(value->>'isByproduct')::boolean,'quantityBasis',value->>'quantityBasis','formulaOutputQuantity',(value->>'formulaOutputQuantity')::numeric,'outputCostWeight',(value->>'outputCostWeight')::numeric);
END $$;
CREATE FUNCTION public.production_bom_revision_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
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
  RAISE EXCEPTION 'A recipe line cannot change its organization or assembly.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['updated_at','updated_by'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['updated_at','updated_by'] THEN RETURN NEW; END IF;
 governed:=EXISTS(SELECT 1 FROM public.mfg_work_orders WHERE org_id=subject_org AND produced_item_id=subject_item AND released_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.mfg_routings WHERE org_id=subject_org AND produced_item_id=subject_item AND activation_change_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.financial_changes WHERE org_id=subject_org AND subject_id=subject_item AND domain='manufacturing' AND operation='bom_revision_activation');
 IF NOT governed THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 change_key:=nullif(current_setting('openbooks.production_bom_changes',true),'')::jsonb->>(subject_org::text||':'||subject_item::text);
 IF change_key IS NULL OR change_key!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'This production recipe requires an approved revision; open its BOM editor and submit the revision for approval.' USING ERRCODE='23514';
 END IF;
 SELECT * INTO proposal FROM public.financial_changes WHERE org_id=subject_org AND id=change_key::uuid AND subject_id=subject_item
  AND domain='manufacturing' AND operation='bom_revision_activation' AND status='approved' FOR SHARE;
 IF NOT FOUND OR proposal.approved_by IS NULL OR (proposal.approved_by=proposal.submitted_by AND NOT public.financial_change_self_decision_authorized(proposal.org_id,proposal.id,proposal.submitted_by)) THEN
  RAISE EXCEPTION 'A current recipe requires its permitted approval decision.' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal.before_state->'lines') previous WHERE previous->>'id'=OLD.id::text
    AND public.production_bom_line_evidence(previous,false)=public.production_bom_line_evidence(to_jsonb(OLD),true)) THEN
   RAISE EXCEPTION 'The recipe changed after approval; propose its current revision again.' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal.payload->'components') component
   WHERE public.production_bom_line_evidence(component,false)=public.production_bom_line_evidence(to_jsonb(NEW),true)) THEN
  RAISE EXCEPTION 'Apply the exact approved recipe replacement; direct line changes are refused.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_bom_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bom_components FOR EACH ROW EXECUTE FUNCTION public.production_bom_revision_guard();
CREATE FUNCTION public.production_bom_revision_complete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE subject_org uuid;subject_item uuid;change_key text;proposal public.financial_changes%ROWTYPE;actual jsonb;expected jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN NULL; END IF;
  subject_org:=OLD.org_id;subject_item:=OLD.assembly_item_id;
 ELSE
  IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
  subject_org:=NEW.org_id;subject_item:=NEW.assembly_item_id;
 END IF;
 change_key:=nullif(current_setting('openbooks.production_bom_changes',true),'')::jsonb->>(subject_org::text||':'||subject_item::text);
 IF change_key IS NULL OR change_key='' THEN RETURN NULL; END IF;
 SELECT * INTO proposal FROM public.financial_changes WHERE org_id=subject_org AND id=change_key::uuid AND subject_id=subject_item
  AND domain='manufacturing' AND operation='bom_revision_activation' AND status='applied';
 IF NOT FOUND THEN RAISE EXCEPTION 'The approved recipe replacement must finish in its native accounting event transaction.' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(public.production_bom_line_evidence(to_jsonb(component),true) ORDER BY component.sort_order,component.component_item_id),'[]'::jsonb) INTO actual
  FROM public.bom_components component WHERE component.org_id=subject_org AND component.assembly_item_id=subject_item;
 SELECT coalesce(jsonb_agg(public.production_bom_line_evidence(component,false) ORDER BY (component->>'sortOrder')::integer,component->>'componentItemId'),'[]'::jsonb) INTO expected
  FROM jsonb_array_elements(proposal.payload->'components') component;
 IF actual IS DISTINCT FROM expected OR proposal.result->>'assemblyItemId' IS DISTINCT FROM subject_item::text THEN
  RAISE EXCEPTION 'The stored current recipe must equal its applied approved revision.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_bom_revision_complete_guard AFTER INSERT OR UPDATE OR DELETE ON public.bom_components DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.production_bom_revision_complete_guard();


-- A completed planning run retains its inputs and capacity claim when later runs refresh the cockpit.
CREATE FUNCTION public.production_mrp_run_evidence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
  IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Completed planning evidence is retained; supersede it with a new run.' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.org_id,NEW.id) IS DISTINCT FROM (OLD.org_id,OLD.id) THEN RAISE EXCEPTION 'A planning run retains its organization and identity.' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'draft' AND ((NEW.number,NEW.horizon_start,NEW.horizon_end,NEW.parameters,NEW.run_by,NEW.ran_at) IS DISTINCT FROM (OLD.number,OLD.horizon_start,OLD.horizon_end,OLD.parameters,OLD.run_by,OLD.ran_at) OR NEW.status NOT IN('complete','superseded') OR OLD.status='superseded' AND NEW.status<>'superseded') THEN
  RAISE EXCEPTION 'Completed planning inputs and capacity evidence are immutable.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_mrp_run_evidence_guard BEFORE UPDATE OR DELETE ON public.mfg_mrp_runs FOR EACH ROW EXECUTE FUNCTION public.production_mrp_run_evidence_guard();


-- A received-stock repair may discard its original stock only through a complete native loss disposition.
CREATE FUNCTION public.production_receipt_rework_loss_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE repair public.mfg_work_orders%ROWTYPE;failed public.inventory_inspections%ROWTYPE;issued numeric;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 SELECT * INTO repair FROM public.mfg_work_orders WHERE org_id=NEW.org_id AND id=NEW.id;
 IF NOT FOUND OR repair.receipt_rework_inspection_id IS NULL OR repair.loss_change_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO failed FROM public.inventory_inspections WHERE org_id=repair.org_id AND id=repair.receipt_rework_inspection_id;
 SELECT coalesce(sum(-movement.quantity),0) INTO issued FROM public.inventory_movements movement JOIN public.journal_entries entry ON entry.org_id=movement.org_id AND entry.id=movement.journal_entry_id
  WHERE movement.org_id=repair.org_id AND entry.origin='manufacturing' AND entry.custom->>'work_order_number'=repair.number AND entry.status='posted' AND entry.reverses_entry_id IS NULL AND movement.kind='assembly_consume' AND movement.item_id=failed.item_id AND movement.lot_id IS NOT DISTINCT FROM failed.lot_id AND movement.serial_id IS NOT DISTINCT FROM failed.serial_id;
 IF failed.id IS NULL OR failed.rework_work_order_id IS DISTINCT FROM repair.id OR repair.status<>'cancelled' OR repair.quantity_completed<>0 OR repair.quantity_scrapped IS DISTINCT FROM failed.quantity OR issued IS DISTINCT FROM failed.quantity THEN
  RAISE EXCEPTION 'A received-stock repair loss must dispose its complete original inspected stock through a native issue and approved loss.' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER production_receipt_rework_loss_guard AFTER UPDATE ON public.mfg_work_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.production_receipt_rework_loss_guard();

CREATE FUNCTION public.manufacturing_run_profile_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.production_mode<>'order' AND NOT EXISTS(SELECT 1 FROM operating_profile_versions profile WHERE profile.org_id=NEW.org_id AND profile.id=NEW.operating_profile_version_id AND profile.family='production' AND profile.definition->>'physicalModel'='process') THEN
  RAISE EXCEPTION 'Batch and continuous runs require their pinned process workflow.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER manufacturing_run_profile_guard BEFORE INSERT OR UPDATE ON public.mfg_work_orders FOR EACH ROW EXECUTE FUNCTION public.manufacturing_run_profile_guard();
