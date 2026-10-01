-- Native employee sales identities, dated operational records, and immutable sales evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.employee_roles ADD COLUMN is_sales_rep boolean NOT NULL DEFAULT false;
ALTER TABLE public.employee_roles ADD COLUMN sales_rep_since date;
CREATE UNIQUE INDEX employee_roles_org_party_sales ON public.employee_roles (org_id, party_id);

ALTER TABLE public.crm_sales_teams ADD COLUMN manager_employee_id uuid;
ALTER TABLE public.crm_sales_teams ADD COLUMN subsidiary_id uuid;
ALTER TABLE public.crm_sales_teams ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.crm_sales_team_members ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.crm_sales_team_members ADD COLUMN employee_id uuid;
ALTER TABLE public.crm_sales_team_members ADD COLUMN valid_from date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE public.crm_sales_team_members ADD COLUMN valid_to date;
ALTER TABLE public.crm_sales_territories ADD COLUMN manager_employee_id uuid;
ALTER TABLE public.crm_sales_territories ADD COLUMN default_employee_id uuid;
ALTER TABLE public.crm_sales_territories ADD COLUMN sales_team_id uuid;
ALTER TABLE public.crm_sales_territories ADD COLUMN subsidiary_id uuid;
ALTER TABLE public.crm_sales_territories ADD COLUMN geography jsonb NOT NULL DEFAULT '{"version":1,"includes":[],"excludes":[],"polygons":[]}'::jsonb;
ALTER TABLE public.crm_sales_territories ADD COLUMN effective_from date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE public.crm_sales_territories ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('draft','active','archived'));
ALTER TABLE public.crm_sales_territories ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.crm_sales_quotas ADD COLUMN employee_id uuid;
ALTER TABLE public.crm_sales_quotas ADD COLUMN subsidiary_id uuid;
ALTER TABLE public.crm_sales_quotas ADD COLUMN parent_quota_id uuid;
ALTER TABLE public.crm_sales_quotas ADD COLUMN supersedes_id uuid;
ALTER TABLE public.crm_sales_quotas ADD COLUMN name text;
ALTER TABLE public.crm_sales_quotas ADD COLUMN metric text NOT NULL DEFAULT 'closed_won' CHECK (metric IN ('closed_won','net_invoiced'));
ALTER TABLE public.crm_sales_quotas ADD COLUMN lifecycle text NOT NULL DEFAULT 'approved' CHECK (lifecycle IN ('draft','pending_approval','approved','superseded','closed'));
ALTER TABLE public.crm_sales_quotas ADD COLUMN approved_by uuid;
ALTER TABLE public.crm_sales_quotas ADD COLUMN approved_at timestamptz;
ALTER TABLE public.crm_sales_quotas ADD COLUMN reason text;
ALTER TABLE public.crm_sales_quotas ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.crm_opportunities ADD COLUMN sales_rep_id uuid;
ALTER TABLE public.crm_account_profiles ADD COLUMN sales_rep_id uuid;
ALTER TABLE public.crm_opportunity_team_members ADD COLUMN employee_id uuid;
ALTER TABLE public.crm_opportunity_team_members ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.crm_account_assignment_events ADD COLUMN from_employee_id uuid;
ALTER TABLE public.crm_account_assignment_events ADD COLUMN to_employee_id uuid;
ALTER TABLE public.documents ADD COLUMN sales_rep_id uuid;
ALTER TABLE public.documents ADD COLUMN sales_team_id uuid;
ALTER TABLE public.addresses ADD COLUMN longitude numeric(10,7);
ALTER TABLE public.addresses ADD COLUMN latitude numeric(10,7);
ALTER TABLE public.addresses ADD COLUMN location_verified_at timestamptz;
ALTER TABLE public.addresses ADD COLUMN location_verified_by uuid;
ALTER TABLE public.addresses ADD CONSTRAINT address_geographic_coordinates CHECK (
 (longitude IS NULL)=(latitude IS NULL) AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
 AND (latitude IS NULL OR latitude BETWEEN -90 AND 90));

-- Only explicit login-to-employee links are converted. Unlinked identities
-- are refused by the upgrade preflight instead of being guessed by name/email.
UPDATE public.crm_sales_teams t SET manager_employee_id=u.party_id FROM public.users u
 WHERE u.id=t.manager_user_id AND u.org_id=t.org_id;
UPDATE public.crm_sales_team_members m SET employee_id=u.party_id, valid_from=m.created_at::date FROM public.users u
 WHERE u.id=m.user_id AND u.org_id=m.org_id;
UPDATE public.crm_sales_territories t SET manager_employee_id=u.party_id FROM public.users u
 WHERE u.id=t.manager_user_id AND u.org_id=t.org_id;
UPDATE public.crm_sales_territories t SET default_employee_id=u.party_id FROM public.users u
 WHERE u.id=t.default_owner_user_id AND u.org_id=t.org_id;
UPDATE public.crm_sales_quotas q SET employee_id=u.party_id FROM public.users u
 WHERE u.id=q.owner_user_id AND u.org_id=q.org_id;
UPDATE public.crm_opportunities o SET sales_rep_id=u.party_id FROM public.users u
 JOIN public.employee_roles e ON e.party_id=u.party_id AND e.org_id=u.org_id
 WHERE u.id=o.owner_user_id AND u.org_id=o.org_id;
UPDATE public.crm_opportunity_team_members m SET employee_id=u.party_id FROM public.users u WHERE u.id=m.user_id AND u.org_id=m.org_id;
UPDATE public.crm_account_profiles cp SET sales_rep_id=c.sales_rep_id FROM public.customer_roles c WHERE c.org_id=cp.org_id AND c.party_id=cp.party_id;
UPDATE public.employee_roles e SET is_sales_rep=true, sales_rep_since=COALESCE(e.hired_on,e.created_at::date)
 WHERE EXISTS (SELECT 1 FROM public.customer_roles c WHERE c.org_id=e.org_id AND c.sales_rep_id=e.party_id)
    OR EXISTS (SELECT 1 FROM public.crm_sales_team_members m WHERE m.org_id=e.org_id AND m.employee_id=e.party_id)
    OR EXISTS (SELECT 1 FROM public.crm_sales_teams t WHERE t.org_id=e.org_id AND t.manager_employee_id=e.party_id)
    OR EXISTS (SELECT 1 FROM public.crm_sales_territories t WHERE t.org_id=e.org_id AND (t.manager_employee_id=e.party_id OR t.default_employee_id=e.party_id))
    OR EXISTS (SELECT 1 FROM public.crm_sales_quotas q WHERE q.org_id=e.org_id AND q.employee_id=e.party_id)
    OR EXISTS (SELECT 1 FROM public.crm_opportunity_team_members m WHERE m.org_id=e.org_id AND m.employee_id=e.party_id)
    OR EXISTS (SELECT 1 FROM public.crm_opportunities o WHERE o.org_id=e.org_id AND o.sales_rep_id=e.party_id);

-- A legal entity is derived only when the native employee record names it.
-- Historical organization-wide targets retain their existing scope.
UPDATE public.crm_sales_teams t SET subsidiary_id=p.subsidiary_id FROM public.parties p
 WHERE p.org_id=t.org_id AND p.id=t.manager_employee_id;
UPDATE public.crm_sales_quotas q SET subsidiary_id=p.subsidiary_id FROM public.parties p
 WHERE p.org_id=q.org_id AND p.id=q.employee_id;
UPDATE public.crm_sales_quotas q SET subsidiary_id=t.subsidiary_id FROM public.crm_sales_teams t
 WHERE t.org_id=q.org_id AND t.id=q.sales_team_id;
UPDATE public.crm_sales_territories t SET subsidiary_id=p.subsidiary_id FROM public.parties p
 WHERE p.org_id=t.org_id AND p.id=t.default_employee_id;
UPDATE public.crm_sales_quotas SET name='Sales quota', approved_at=created_at;
ALTER TABLE public.crm_sales_quotas ALTER COLUMN lifecycle SET DEFAULT 'draft';
UPDATE public.crm_sales_territories SET lifecycle='archived' WHERE NOT is_active;

ALTER TABLE public.crm_opportunity_team_members ALTER COLUMN employee_id SET NOT NULL;
CREATE UNIQUE INDEX opportunity_employee_member ON public.crm_opportunity_team_members(org_id,opportunity_id,employee_id);
ALTER TABLE public.crm_opportunity_team_members ADD CONSTRAINT opportunity_member_employee_fk FOREIGN KEY(org_id,employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_account_profiles ADD CONSTRAINT account_sales_employee_fk FOREIGN KEY(org_id,sales_rep_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_account_assignment_events ADD CONSTRAINT account_from_sales_employee_fk FOREIGN KEY(org_id,from_employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_account_assignment_events ADD CONSTRAINT account_to_sales_employee_fk FOREIGN KEY(org_id,to_employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_team_members ALTER COLUMN employee_id SET NOT NULL;
ALTER TABLE public.crm_sales_team_members ADD CONSTRAINT sales_member_dates CHECK (valid_to IS NULL OR valid_to>=valid_from);
CREATE UNIQUE INDEX sales_member_employee_active ON public.crm_sales_team_members (org_id,team_id,employee_id) WHERE is_active;
CREATE UNIQUE INDEX crm_sales_teams_org_id_sales ON public.crm_sales_teams (org_id,id);
CREATE UNIQUE INDEX crm_sales_quotas_org_id_sales ON public.crm_sales_quotas (org_id,id);
ALTER TABLE public.crm_sales_quotas DROP CONSTRAINT crm_sales_quota_target;
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT crm_sales_quota_employee_target CHECK (num_nonnulls(employee_id,sales_team_id)=1);
ALTER TABLE public.crm_sales_teams ADD CONSTRAINT sales_manager_employee_fk FOREIGN KEY (org_id,manager_employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_team_members ADD CONSTRAINT sales_member_employee_fk FOREIGN KEY (org_id,employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_team_members ADD CONSTRAINT sales_member_team_scope_fk FOREIGN KEY (org_id,team_id) REFERENCES public.crm_sales_teams(org_id,id);
ALTER TABLE public.crm_sales_territories ADD CONSTRAINT territory_manager_employee_fk FOREIGN KEY (org_id,manager_employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_territories ADD CONSTRAINT territory_owner_employee_fk FOREIGN KEY (org_id,default_employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_territories ADD CONSTRAINT territory_team_scope_fk FOREIGN KEY (org_id,sales_team_id) REFERENCES public.crm_sales_teams(org_id,id);
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT quota_employee_fk FOREIGN KEY (org_id,employee_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT quota_team_scope_fk FOREIGN KEY (org_id,sales_team_id) REFERENCES public.crm_sales_teams(org_id,id);
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT quota_parent_scope_fk FOREIGN KEY (org_id,parent_quota_id) REFERENCES public.crm_sales_quotas(org_id,id);
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT quota_supersedes_scope_fk FOREIGN KEY (org_id,supersedes_id) REFERENCES public.crm_sales_quotas(org_id,id);
ALTER TABLE public.crm_opportunities ADD CONSTRAINT opportunity_sales_employee_fk FOREIGN KEY (org_id,sales_rep_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.documents ADD CONSTRAINT document_sales_employee_fk FOREIGN KEY (org_id,sales_rep_id) REFERENCES public.employee_roles(org_id,party_id);
ALTER TABLE public.documents ADD CONSTRAINT document_sales_team_fk FOREIGN KEY (org_id,sales_team_id) REFERENCES public.crm_sales_teams(org_id,id);
ALTER TABLE public.crm_sales_teams ADD CONSTRAINT sales_team_subsidiary_fk FOREIGN KEY (org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id);
ALTER TABLE public.crm_sales_territories ADD CONSTRAINT sales_territory_subsidiary_fk FOREIGN KEY (org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id);
ALTER TABLE public.crm_sales_quotas ADD CONSTRAINT sales_quota_subsidiary_fk FOREIGN KEY (org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id);

CREATE TABLE public.crm_sales_evidence (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 source_kind text NOT NULL CHECK (source_kind IN ('opportunity','document')), source_id uuid NOT NULL,
 source_number text NOT NULL, source_revision bigint NOT NULL DEFAULT 0, event_kind text NOT NULL CHECK (event_kind IN ('credit','reversal')),
 metric text NOT NULL CHECK (metric IN ('closed_won','net_invoiced')), employee_id uuid, sales_team_id uuid,
 subsidiary_id uuid, currency text NOT NULL REFERENCES public.currencies(code), amount numeric(19,4) NOT NULL,
 effective_date date, reverses_id uuid, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 FOREIGN KEY (org_id,employee_id) REFERENCES public.employee_roles(org_id,party_id),
 FOREIGN KEY (org_id,sales_team_id) REFERENCES public.crm_sales_teams(org_id,id),
 FOREIGN KEY (org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 UNIQUE (org_id,id), FOREIGN KEY (org_id,reverses_id) REFERENCES public.crm_sales_evidence(org_id,id),
 UNIQUE (org_id,reverses_id),
 CHECK ((event_kind='reversal')=(reverses_id IS NOT NULL))
);
CREATE UNIQUE INDEX sales_evidence_source_credit ON public.crm_sales_evidence(org_id,source_kind,source_id,source_revision) WHERE event_kind='credit';
CREATE INDEX sales_evidence_target_period ON public.crm_sales_evidence(org_id,employee_id,sales_team_id,metric,effective_date);
ALTER TABLE public.crm_sales_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_sales_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.crm_sales_evidence
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.crm_sales_evidence IS 'openbooks:org_isolation:v1';

CREATE UNIQUE INDEX crm_sales_territories_org_id_sales ON public.crm_sales_territories(org_id,id);
CREATE TABLE public.crm_sales_territory_versions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 territory_id uuid NOT NULL,revision integer NOT NULL,
 FOREIGN KEY(org_id,territory_id) REFERENCES public.crm_sales_territories(org_id,id),
 effective_from date NOT NULL,definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,
 UNIQUE(org_id,territory_id,revision)
);
ALTER TABLE public.crm_sales_territory_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_sales_territory_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.crm_sales_territory_versions
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.crm_sales_territory_versions IS 'openbooks:org_isolation:v1';
INSERT INTO public.crm_sales_territory_versions(org_id,territory_id,revision,effective_from,definition,created_by)
 SELECT org_id,id,revision,created_at::date,to_jsonb(t),created_by FROM public.crm_sales_territories t WHERE is_active;

CREATE FUNCTION public.sales_employee_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE field_name text; employee uuid; before_value jsonb; after_value jsonb;
BEGIN
 after_value:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN before_value:=to_jsonb(OLD); ELSE before_value:='{}'::jsonb; END IF;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  employee:=NULLIF(after_value->>field_name,'')::uuid;
  IF employee IS NOT NULL AND (TG_OP='INSERT' OR before_value->field_name IS DISTINCT FROM after_value->field_name) THEN
   PERFORM 1 FROM public.employee_roles e JOIN public.parties p ON p.org_id=e.org_id AND p.id=e.party_id
    WHERE e.org_id=NEW.org_id AND e.party_id=employee AND e.is_active AND e.is_sales_rep AND p.is_active
    AND (e.sales_rep_since IS NULL OR e.sales_rep_since<=COALESCE((after_value->>'period_start')::date,(after_value->>'valid_from')::date,(after_value->>'effective_from')::date,CURRENT_DATE)) FOR SHARE OF e,p;
   IF NOT FOUND THEN RAISE EXCEPTION 'Select an active employee designated as a sales representative in Sales → Representatives.' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_team_employee_guard BEFORE INSERT OR UPDATE ON public.crm_sales_teams FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('manager_employee_id');
CREATE TRIGGER sales_member_employee_guard BEFORE INSERT OR UPDATE ON public.crm_sales_team_members FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('employee_id');
CREATE TRIGGER sales_territory_employee_guard BEFORE INSERT OR UPDATE ON public.crm_sales_territories FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('manager_employee_id','default_employee_id');
CREATE TRIGGER sales_quota_employee_guard BEFORE INSERT OR UPDATE ON public.crm_sales_quotas FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('employee_id');
CREATE TRIGGER account_sales_employee_guard BEFORE INSERT OR UPDATE ON public.crm_account_profiles FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('sales_rep_id');
CREATE TRIGGER customer_sales_employee_guard BEFORE INSERT OR UPDATE ON public.customer_roles FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('sales_rep_id');
CREATE TRIGGER opportunity_member_employee_guard BEFORE INSERT OR UPDATE ON public.crm_opportunity_team_members FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('employee_id');
CREATE TRIGGER opportunity_sales_employee_guard BEFORE INSERT OR UPDATE ON public.crm_opportunities FOR EACH ROW EXECUTE FUNCTION public.sales_employee_guard('sales_rep_id');

-- Login references are retained only as upgrade evidence. New operational
-- configuration uses the employee foreign keys exclusively.
CREATE FUNCTION public.sales_legacy_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE field_name text; before_value jsonb; after_value jsonb;
BEGIN
 after_value:=to_jsonb(NEW);before_value:=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 FOREACH field_name IN ARRAY TG_ARGV LOOP
  IF after_value->>field_name IS NOT NULL AND (TG_OP='INSERT' OR before_value->field_name IS DISTINCT FROM after_value->field_name) THEN
   RAISE EXCEPTION 'Sales responsibility must reference a native employee. Manage assignments in Sales.' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_team_legacy_guard BEFORE INSERT OR UPDATE ON public.crm_sales_teams FOR EACH ROW EXECUTE FUNCTION public.sales_legacy_identity_guard('manager_user_id');
CREATE TRIGGER sales_member_legacy_guard BEFORE INSERT OR UPDATE ON public.crm_sales_team_members FOR EACH ROW EXECUTE FUNCTION public.sales_legacy_identity_guard('user_id');
CREATE TRIGGER sales_territory_legacy_guard BEFORE INSERT OR UPDATE ON public.crm_sales_territories FOR EACH ROW EXECUTE FUNCTION public.sales_legacy_identity_guard('manager_user_id','default_owner_user_id');
CREATE TRIGGER sales_quota_legacy_guard BEFORE INSERT OR UPDATE ON public.crm_sales_quotas FOR EACH ROW EXECUTE FUNCTION public.sales_legacy_identity_guard('owner_user_id');
CREATE TRIGGER opportunity_member_legacy_guard BEFORE INSERT OR UPDATE ON public.crm_opportunity_team_members FOR EACH ROW EXECUTE FUNCTION public.sales_legacy_identity_guard('user_id');

CREATE FUNCTION public.sales_customer_assignment() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE account public.crm_account_profiles;
BEGIN
 IF TG_OP='UPDATE' AND OLD.sales_rep_id IS NOT DISTINCT FROM NEW.sales_rep_id THEN RETURN NEW; END IF;
 SELECT * INTO account FROM public.crm_account_profiles WHERE org_id=NEW.org_id AND party_id=NEW.party_id FOR UPDATE;
 IF NOT FOUND OR account.sales_rep_id IS NOT DISTINCT FROM NEW.sales_rep_id THEN RETURN NEW; END IF;
 UPDATE public.crm_account_profiles SET sales_rep_id=NEW.sales_rep_id,updated_at=clock_timestamp(),updated_by=NEW.updated_by WHERE org_id=NEW.org_id AND id=account.id;
 INSERT INTO public.crm_account_assignment_events(org_id,account_profile_id,from_employee_id,to_employee_id,from_owner_user_id,to_owner_user_id,from_territory_id,to_territory_id,source,reason,created_by,updated_by)
 VALUES(NEW.org_id,account.id,account.sales_rep_id,NEW.sales_rep_id,account.owner_user_id,account.owner_user_id,account.territory_id,account.territory_id,'manual','Customer sales representative changed',NEW.updated_by,NEW.updated_by);
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_customer_assignment AFTER INSERT OR UPDATE ON public.customer_roles FOR EACH ROW EXECUTE FUNCTION public.sales_customer_assignment();

CREATE FUNCTION public.sales_employee_retirement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF (OLD.is_sales_rep AND NOT NEW.is_sales_rep) OR (OLD.is_active AND NOT NEW.is_active) THEN
  IF EXISTS(SELECT 1 FROM public.customer_roles WHERE org_id=OLD.org_id AND sales_rep_id=OLD.party_id AND is_active)
   OR EXISTS(SELECT 1 FROM public.crm_sales_team_members WHERE org_id=OLD.org_id AND employee_id=OLD.party_id AND is_active)
   OR EXISTS(SELECT 1 FROM public.crm_sales_teams WHERE org_id=OLD.org_id AND manager_employee_id=OLD.party_id AND is_active)
   OR EXISTS(SELECT 1 FROM public.crm_sales_territories WHERE org_id=OLD.org_id AND (default_employee_id=OLD.party_id OR manager_employee_id=OLD.party_id) AND lifecycle<>'archived')
   OR EXISTS(SELECT 1 FROM public.crm_sales_quotas WHERE org_id=OLD.org_id AND employee_id=OLD.party_id AND lifecycle IN ('draft','pending_approval','approved') AND period_end>=CURRENT_DATE)
   OR EXISTS(SELECT 1 FROM public.crm_opportunities o JOIN public.crm_opportunity_statuses st ON st.org_id=o.org_id AND st.id=o.status_id WHERE o.org_id=OLD.org_id AND o.sales_rep_id=OLD.party_id AND o.is_active AND NOT st.is_closed) THEN
    RAISE EXCEPTION 'Reassign the employee’s active customers, teams, territories and open opportunities, and close or revise open quotas in Sales before removing sales eligibility.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_employee_retirement_guard BEFORE UPDATE ON public.employee_roles FOR EACH ROW EXECUTE FUNCTION public.sales_employee_retirement_guard();

CREATE FUNCTION public.sales_evidence_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF public.app_bypass_rls_active() AND current_setting('openbooks.amend',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Sales evidence is immutable; correct the source through its controlled reversal workflow.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER sales_evidence_immutable BEFORE UPDATE OR DELETE ON public.crm_sales_evidence FOR EACH ROW EXECUTE FUNCTION public.sales_evidence_immutable();
CREATE TRIGGER sales_territory_version_immutable BEFORE UPDATE OR DELETE ON public.crm_sales_territory_versions FOR EACH ROW EXECUTE FUNCTION public.sales_evidence_immutable();

CREATE FUNCTION public.sales_address_location_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF ROW(OLD.line1,OLD.line2,OLD.city,OLD.region,OLD.postal_code,OLD.country) IS DISTINCT FROM ROW(NEW.line1,NEW.line2,NEW.city,NEW.region,NEW.postal_code,NEW.country) THEN
  NEW.longitude:=NULL; NEW.latitude:=NULL; NEW.location_verified_at:=NULL; NEW.location_verified_by:=NULL;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_address_location_guard BEFORE UPDATE ON public.addresses FOR EACH ROW EXECUTE FUNCTION public.sales_address_location_guard();

CREATE FUNCTION public.sales_quota_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.app_bypass_rls_active() AND current_setting('openbooks.amend',true)='on' THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Quota history cannot be deleted; close the quota instead.' USING ERRCODE='23514'; END IF;
 IF OLD.lifecycle IN ('approved','superseded','closed') AND
  (to_jsonb(NEW)-ARRAY['lifecycle','updated_at','updated_by','revision']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['lifecycle','updated_at','updated_by','revision']) THEN
  RAISE EXCEPTION 'Approved quotas are immutable; create a revised quota with a reason and approval.' USING ERRCODE='23514';
 END IF;
 IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (
  (OLD.lifecycle='draft' AND NEW.lifecycle='pending_approval') OR
  (OLD.lifecycle='pending_approval' AND NEW.lifecycle IN ('draft','approved')) OR
  (OLD.lifecycle='approved' AND NEW.lifecycle IN ('superseded','closed'))) THEN
  RAISE EXCEPTION 'Invalid quota lifecycle transition.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_quota_version_guard BEFORE UPDATE OR DELETE ON public.crm_sales_quotas FOR EACH ROW EXECUTE FUNCTION public.sales_quota_version_guard();

-- Posted invoice attribution is frozen at the posting event. Historical
-- invoices are not attributed from today's customer record.
CREATE FUNCTION public.sales_document_attribution() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='UPDATE' AND OLD.status IN ('posted','voided') AND (OLD.sales_rep_id IS DISTINCT FROM NEW.sales_rep_id OR OLD.sales_team_id IS DISTINCT FROM NEW.sales_team_id) THEN
  RAISE EXCEPTION 'Posted sales attribution is immutable.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted') AND NEW.kind IN ('customer_invoice','customer_credit') AND NEW.sales_rep_id IS NULL THEN
  SELECT c.sales_rep_id INTO NEW.sales_rep_id FROM public.customer_roles c WHERE c.org_id=NEW.org_id AND c.party_id=NEW.party_id;
  IF NEW.sales_team_id IS NULL THEN
   SELECT (v.definition->>'sales_team_id')::uuid INTO NEW.sales_team_id FROM public.crm_account_profiles cp
    JOIN LATERAL(SELECT definition FROM public.crm_sales_territory_versions v WHERE v.org_id=cp.org_id AND v.territory_id=cp.territory_id AND v.effective_from<=COALESCE(NEW.posting_date,NEW.document_date) ORDER BY effective_from DESC,revision DESC LIMIT 1)v ON true
    WHERE cp.org_id=NEW.org_id AND cp.party_id=NEW.party_id AND cp.sales_rep_id=NEW.sales_rep_id;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_document_attribution BEFORE INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.sales_document_attribution();

CREATE FUNCTION public.sales_capture_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE is_credit boolean:=false; is_reversal boolean:=false; old_won boolean:=false; new_won boolean:=false; prior public.crm_sales_evidence; metric_name text; source_name text; source_number_value text; value numeric; event_date date;
BEGIN
 IF TG_TABLE_NAME='documents' THEN
  IF NEW.kind NOT IN ('customer_invoice','customer_credit') THEN RETURN NEW; END IF;
  metric_name:='net_invoiced'; source_name:='document'; source_number_value:=NEW.document_number;
  is_credit:=NEW.status='posted' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'posted');
  is_reversal:=TG_OP='UPDATE' AND OLD.status='posted' AND NEW.status='voided';
  value:=CASE WHEN NEW.kind='customer_credit' THEN -NEW.subtotal ELSE NEW.subtotal END;
  event_date:=COALESCE(NEW.posting_date,NEW.document_date);
  IF is_reversal THEN event_date:=NEW.void_reversal_date; END IF;
 ELSE
  metric_name:='closed_won'; source_name:='opportunity'; source_number_value:=NEW.opportunity_number;
  SELECT is_won INTO new_won FROM public.crm_opportunity_statuses WHERE org_id=NEW.org_id AND id=NEW.status_id;
  IF TG_OP='UPDATE' THEN SELECT is_won INTO old_won FROM public.crm_opportunity_statuses WHERE org_id=OLD.org_id AND id=OLD.status_id; END IF;
  is_credit:=COALESCE(new_won,false) AND NOT COALESCE(old_won,false);
  is_reversal:=COALESCE(old_won,false) AND NOT COALESCE(new_won,false);
  IF TG_OP='UPDATE' AND old_won AND new_won AND
    (OLD.sales_rep_id IS DISTINCT FROM NEW.sales_rep_id OR OLD.sales_team_id IS DISTINCT FROM NEW.sales_team_id OR OLD.projected_amount IS DISTINCT FROM NEW.projected_amount OR OLD.currency IS DISTINCT FROM NEW.currency) THEN
   RAISE EXCEPTION 'Closed-won sales evidence is immutable; reopen the opportunity with a reason before adjusting it.' USING ERRCODE='23514';
  END IF;
  value:=NEW.projected_amount; event_date:=(NEW.closed_at AT TIME ZONE COALESCE((SELECT NULLIF(settings->>'timeZone','') FROM public.orgs WHERE id=NEW.org_id),'UTC'))::date;
  IF is_reversal AND NULLIF(trim(NEW.win_loss_reason),'') IS NULL THEN RAISE EXCEPTION 'Enter the reason for reopening this opportunity.' USING ERRCODE='23514'; END IF;
 END IF;
 IF is_credit THEN
  IF event_date IS NULL THEN RAISE EXCEPTION 'Sales evidence requires an effective date.' USING ERRCODE='23514'; END IF;
  INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,created_by)
   VALUES(NEW.org_id,source_name,NEW.id,source_number_value,NEW.revision_seq,'credit',metric_name,NEW.sales_rep_id,NEW.sales_team_id,NEW.subsidiary_id,NEW.currency,value,event_date,NEW.updated_by);
 ELSIF is_reversal THEN
  SELECT e.* INTO prior FROM public.crm_sales_evidence e WHERE e.org_id=NEW.org_id AND e.source_kind=source_name AND e.source_id=NEW.id AND e.event_kind='credit' AND NOT EXISTS (SELECT 1 FROM public.crm_sales_evidence r WHERE r.org_id=e.org_id AND r.reverses_id=e.id) ORDER BY e.created_at DESC LIMIT 1;
  IF FOUND THEN
   IF source_name='opportunity' THEN event_date:=(NEW.updated_at AT TIME ZONE COALESCE((SELECT NULLIF(settings->>'timeZone','') FROM public.orgs WHERE id=NEW.org_id),'UTC'))::date; END IF;
   IF event_date IS NULL THEN RAISE EXCEPTION 'A sales reversal requires its controlled effective date.' USING ERRCODE='23514'; END IF;
   INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,reverses_id,created_by)
    VALUES(prior.org_id,prior.source_kind,prior.source_id,prior.source_number,NEW.revision_seq,'reversal',prior.metric,prior.employee_id,prior.sales_team_id,prior.subsidiary_id,prior.currency,-prior.amount,event_date,prior.id,NEW.updated_by);
  END IF;
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER sales_capture_document_evidence AFTER INSERT OR UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.sales_capture_evidence();
CREATE TRIGGER sales_capture_opportunity_evidence AFTER INSERT OR UPDATE ON public.crm_opportunities FOR EACH ROW EXECUTE FUNCTION public.sales_capture_evidence();

-- Existing closed opportunities retain explicit linked employee ownership.
-- Existing invoices remain visibly unattributed; historical ownership cannot
-- be reconstructed from a mutable customer master.
INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,created_by)
 SELECT o.org_id,'opportunity',o.id,o.opportunity_number,o.revision_seq,'credit','closed_won',o.sales_rep_id,o.sales_team_id,o.subsidiary_id,o.currency,o.projected_amount,(o.closed_at AT TIME ZONE COALESCE((SELECT NULLIF(settings->>'timeZone','') FROM public.orgs WHERE id=o.org_id),'UTC'))::date,o.created_by
 FROM public.crm_opportunities o JOIN public.crm_opportunity_statuses s ON s.org_id=o.org_id AND s.id=o.status_id WHERE s.is_won;
INSERT INTO public.crm_sales_evidence(org_id,source_kind,source_id,source_number,source_revision,event_kind,metric,employee_id,sales_team_id,subsidiary_id,currency,amount,effective_date,created_by)
 SELECT org_id,'document',id,document_number,revision_seq,'credit','net_invoiced',NULL,NULL,subsidiary_id,currency,CASE WHEN kind='customer_credit' THEN -subtotal ELSE subtotal END,COALESCE(posting_date,document_date),created_by
 FROM public.documents WHERE status='posted' AND kind IN ('customer_invoice','customer_credit');

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES ('crm_sales_evidence','0470'),('crm_sales_territory_versions','0470');
SELECT public.openbooks_refresh_query_catalog();
