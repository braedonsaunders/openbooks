-- Typed commercial-source policies extend the existing benefit award lifecycle.
-- Active program rules and dated recipient evidence remain immutable.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT hrm_benefit_programs_metric;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_metric CHECK(metric IS NULL OR metric IN ('revenue','gross_profit','net_profit','approved_hours','transactions'));
ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT hrm_benefit_programs_valuation;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_valuation CHECK(valuation IN ('fixed','percent','pool','per_unit'));
ALTER TABLE public.hrm_benefit_programs DROP CONSTRAINT hrm_benefit_programs_allocation;
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_allocation CHECK(allocation IN ('equal','hours','role','responsibility'));
ALTER TABLE public.hrm_benefit_programs ADD CONSTRAINT hrm_benefit_programs_transaction_shape CHECK(
 (coalesce(metric='transactions',false) AND valuation IN ('percent','per_unit') AND allocation='responsibility' AND metric_scope='company'
  AND family IN ('incentive','custom') AND delivery_method='payroll'
  AND cap_amount IS NULL AND threshold_amount IS NULL AND budget_amount IS NULL
  AND ((valuation='percent' AND percent_rate IS NOT NULL AND percent_rate>0) OR (valuation='per_unit' AND fixed_amount IS NOT NULL AND fixed_amount>0)))
 OR ((metric IS NULL OR metric<>'transactions') AND valuation<>'per_unit' AND allocation<>'responsibility'));

CREATE TABLE public.hrm_benefit_transaction_policies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), program_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,program_id) REFERENCES public.hrm_benefit_programs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 document_kind text NOT NULL CHECK(document_kind IN ('sales_order','customer_invoice','field_ticket','quote')),
 grouping_segment_id uuid,
 date_basis text NOT NULL CHECK(date_basis='document_date'),
 FOREIGN KEY(org_id,grouping_segment_id) REFERENCES public.segment_definitions(org_id,id),
 UNIQUE(org_id,program_id)
);
CREATE TABLE public.hrm_benefit_transaction_items (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), program_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,program_id) REFERENCES public.hrm_benefit_programs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 item_id uuid NOT NULL,
 FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),
 UNIQUE(org_id,program_id,item_id)
);
CREATE TABLE public.hrm_benefit_transaction_positions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), program_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,program_id) REFERENCES public.hrm_benefit_programs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 position_key text NOT NULL CHECK(length(btrim(position_key)) BETWEEN 1 AND 120),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 weight numeric(19,4) NOT NULL CHECK(weight>0),
 UNIQUE(org_id,program_id,position_key)
);
CREATE TABLE public.hrm_benefit_transaction_responsibilities (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), program_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,program_id) REFERENCES public.hrm_benefit_programs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 position_key text NOT NULL,
 group_id uuid NOT NULL,
 employment_id uuid NOT NULL,
 effective_from date NOT NULL, effective_to date,
 FOREIGN KEY(org_id,program_id,position_key) REFERENCES public.hrm_benefit_transaction_positions(org_id,program_id,position_key),
 FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 CHECK(effective_to IS NULL OR effective_to>=effective_from),
 EXCLUDE USING gist(org_id WITH =,program_id WITH =,position_key WITH =,group_id WITH =,
  daterange(effective_from,effective_to,'[]') WITH &&)
);
CREATE TABLE public.hrm_benefit_transaction_limits (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id), program_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,program_id) REFERENCES public.hrm_benefit_programs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 group_id uuid NOT NULL,
 limit_kind text NOT NULL CHECK(limit_kind IN ('none','amount')),
 amount numeric(19,4),
 CHECK((limit_kind='none' AND amount IS NULL) OR (limit_kind='amount' AND amount IS NOT NULL AND amount>=0)),
 UNIQUE(org_id,program_id,group_id)
);

ALTER TABLE public.hrm_benefit_transaction_items ADD FOREIGN KEY(org_id,program_id)
 REFERENCES public.hrm_benefit_transaction_policies(org_id,program_id);
ALTER TABLE public.hrm_benefit_transaction_positions ADD FOREIGN KEY(org_id,program_id)
 REFERENCES public.hrm_benefit_transaction_policies(org_id,program_id);
ALTER TABLE public.hrm_benefit_transaction_limits ADD FOREIGN KEY(org_id,program_id)
 REFERENCES public.hrm_benefit_transaction_policies(org_id,program_id);
ALTER TABLE public.hrm_benefit_transaction_responsibilities ADD FOREIGN KEY(org_id,program_id,group_id)
 REFERENCES public.hrm_benefit_transaction_limits(org_id,program_id,group_id);

CREATE FUNCTION public.benefit_transaction_rule_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE owner_org uuid; owner_program uuid; program_status text; employer uuid; segment record; group_table text; valid_group boolean; group_subsidiary uuid; include_children boolean;
BEGIN
 owner_org:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 owner_program:=CASE WHEN TG_OP='DELETE' THEN OLD.program_id ELSE NEW.program_id END;
 SELECT status,legal_entity_id INTO program_status,employer FROM public.hrm_benefit_programs
  WHERE org_id=owner_org AND id=owner_program FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose a benefit program in this organization before configuring its transaction rules.'; END IF;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(owner_org) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority()
  AND EXISTS(SELECT 1 FROM public.orgs WHERE id=owner_org AND env_kind='sandbox' AND sandbox_of IS NOT NULL) THEN RETURN NEW; END IF;
 IF program_status<>'draft' THEN
  RAISE EXCEPTION 'Active benefit transaction rules are immutable; close the program and create a replacement with new effective dates.';
 END IF;
 IF TG_OP<>'DELETE' AND TG_TABLE_NAME IN ('hrm_benefit_transaction_responsibilities','hrm_benefit_transaction_limits') THEN
  SELECT s.id,s.source_kind,s.storage_column INTO segment FROM public.hrm_benefit_transaction_policies p
   LEFT JOIN public.segment_definitions s ON s.org_id=p.org_id AND s.id=p.grouping_segment_id
   WHERE p.org_id=owner_org AND p.program_id=owner_program FOR SHARE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configure the program transaction source and grouping dimension before recording responsibilities or ceilings.'; END IF;
  IF segment.id IS NULL THEN
   valid_group:=NEW.group_id=employer;
  ELSIF segment.source_kind='custom' AND segment.storage_column IS NULL THEN
   SELECT EXISTS(SELECT 1 FROM public.segment_values WHERE org_id=owner_org AND segment_id=segment.id AND id=NEW.group_id) INTO valid_group;
  ELSE
   group_table:=CASE segment.storage_column WHEN 'subsidiary_id' THEN 'subsidiaries' WHEN 'department_id' THEN 'departments'
    WHEN 'project_id' THEN 'projects' WHEN 'location_id' THEN 'locations' WHEN 'class_id' THEN 'classes' END;
   IF group_table IS NULL THEN RAISE EXCEPTION 'Select a grouping dimension with a supported native storage mapping.'; END IF;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE org_id=$1 AND id=$2)',group_table) INTO valid_group USING owner_org,NEW.group_id;
   IF group_table='subsidiaries' THEN valid_group:=valid_group AND NEW.group_id=employer; END IF;
  END IF;
  IF valid_group IS DISTINCT FROM true THEN RAISE EXCEPTION 'The assigned group belongs to another organization or dimension; select a native group from the configured dimension.'; END IF;
  IF segment.id IS NOT NULL AND group_table IS DISTINCT FROM 'subsidiaries' THEN
   IF segment.source_kind='custom' THEN group_table:='segment_values'; END IF;
   EXECUTE format('SELECT subsidiary_id,subsidiary_include_children FROM public.%I WHERE org_id=$1 AND id=$2',group_table)
    INTO group_subsidiary,include_children USING owner_org,NEW.group_id;
   IF group_subsidiary IS NOT NULL AND group_subsidiary<>employer AND NOT (
    include_children AND EXISTS(WITH RECURSIVE descendants AS (
     SELECT id FROM public.subsidiaries WHERE org_id=owner_org AND id=group_subsidiary
     UNION ALL SELECT s.id FROM public.subsidiaries s JOIN descendants d ON s.parent_id=d.id WHERE s.org_id=owner_org
    ) SELECT 1 FROM descendants WHERE id=employer)) THEN
    RAISE EXCEPTION 'The assigned group is restricted to another legal employer; choose a group available to the program employer.';
   END IF;
  END IF;
  IF TG_TABLE_NAME='hrm_benefit_transaction_responsibilities' THEN
   IF NOT EXISTS(SELECT 1 FROM public.worker_employments WHERE org_id=owner_org AND id=NEW.employment_id AND employer_subsidiary_id=employer) THEN
    RAISE EXCEPTION 'Choose a recipient employment belonging to the program legal employer.';
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.org_id,NEW.program_id,NEW.created_at,NEW.created_by)
  IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.program_id,OLD.created_at,OLD.created_by) THEN
  RAISE EXCEPTION 'Transaction rule ownership and creation evidence are immutable.';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
CREATE FUNCTION public.benefit_transaction_rule_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE row_data jsonb; owner_org uuid; owner_program uuid;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 owner_org:=(row_data->>'org_id')::uuid; owner_program:=(row_data->>'program_id')::uuid;
 IF public.openbooks_clone_authority() OR public.openbooks_sandbox_wipe_allowed(owner_org) THEN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(owner_org,TG_TABLE_NAME,(row_data->>'id')::uuid,lower(TG_OP),(row_data->>'updated_by')::uuid,
  jsonb_build_object('before',CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
   'after',CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END,'reason',row_data->>'reason'));
 UPDATE public.hrm_benefit_programs SET revision=revision+1,updated_at=clock_timestamp(),updated_by=(row_data->>'updated_by')::uuid
  WHERE org_id=owner_org AND id=owner_program;
 IF NOT FOUND THEN RAISE EXCEPTION 'The program revision was not saved; reload its rules before continuing.'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
CREATE TRIGGER benefit_transaction_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_policies
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_guard();
CREATE TRIGGER benefit_transaction_rule_audit AFTER INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_policies
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_audit();
ALTER TABLE public.hrm_benefit_transaction_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_transaction_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_transaction_policies
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_transaction_policies IS 'openbooks:org_isolation:v1';
CREATE TRIGGER benefit_transaction_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_items
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_guard();
CREATE TRIGGER benefit_transaction_rule_audit AFTER INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_items
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_audit();
ALTER TABLE public.hrm_benefit_transaction_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_transaction_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_transaction_items
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_transaction_items IS 'openbooks:org_isolation:v1';
CREATE TRIGGER benefit_transaction_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_positions
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_guard();
CREATE TRIGGER benefit_transaction_rule_audit AFTER INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_positions
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_audit();
ALTER TABLE public.hrm_benefit_transaction_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_transaction_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_transaction_positions
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_transaction_positions IS 'openbooks:org_isolation:v1';
CREATE TRIGGER benefit_transaction_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_responsibilities
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_guard();
CREATE TRIGGER benefit_transaction_rule_audit AFTER INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_responsibilities
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_audit();
ALTER TABLE public.hrm_benefit_transaction_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_transaction_responsibilities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_transaction_responsibilities
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_transaction_responsibilities IS 'openbooks:org_isolation:v1';
CREATE TRIGGER benefit_transaction_rule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_limits
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_guard();
CREATE TRIGGER benefit_transaction_rule_audit AFTER INSERT OR UPDATE OR DELETE ON public.hrm_benefit_transaction_limits
 FOR EACH ROW EXECUTE FUNCTION public.benefit_transaction_rule_audit();
ALTER TABLE public.hrm_benefit_transaction_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_benefit_transaction_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_benefit_transaction_limits
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.hrm_benefit_transaction_limits IS 'openbooks:org_isolation:v1';
SELECT public.openbooks_refresh_query_catalog();
