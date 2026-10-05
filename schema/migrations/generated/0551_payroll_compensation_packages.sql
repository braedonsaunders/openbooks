-- Approved employer compensation versions and employment assignments preserve
-- the exact definition and calculation evidence without creating wage or benefit policy.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.payroll_compensation_configuration (
 org_id uuid PRIMARY KEY REFERENCES public.orgs(id) ON DELETE CASCADE, revision bigint NOT NULL DEFAULT 1 CHECK(revision>0)
);
INSERT INTO public.payroll_compensation_configuration(org_id) SELECT id FROM public.orgs;
CREATE FUNCTION public.initialize_payroll_compensation_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE previous_org text;
BEGIN
 -- Organization creation is authorized by its own policy; initialize the new
 -- tenant's derived counter under that tenant without weakening table isolation.
 previous_org := current_setting('app.current_org',true);
 PERFORM set_config('app.current_org',NEW.id::text,true);
 INSERT INTO public.payroll_compensation_configuration(org_id) VALUES(NEW.id);
 PERFORM set_config('app.current_org',coalesce(previous_org,''),true);
 RETURN NEW;
END $function$;
CREATE TRIGGER initialize_payroll_compensation_configuration AFTER INSERT ON public.orgs
 FOR EACH ROW EXECUTE FUNCTION public.initialize_payroll_compensation_configuration();

CREATE TABLE public.payroll_compensation_packages (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 subsidiary_id uuid NOT NULL, code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code=trim(code)),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160), description text,
 country char(2) NOT NULL CHECK(country ~ '^[A-Z]{2}$'), currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,subsidiary_id,code),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);
CREATE TABLE public.payroll_compensation_versions (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id), package_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'), effective_to date CHECK(effective_to>=effective_from AND effective_to<=DATE '9999-12-31'),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'), definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
 submitted_by uuid, submitted_at timestamptz, decided_by uuid, decided_at timestamptz,
 authorship jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(authorship)='array'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,package_id,id), UNIQUE(org_id,package_id,version),
 FOREIGN KEY(org_id,package_id) REFERENCES public.payroll_compensation_packages(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,submitted_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 CHECK((status='draft' AND submitted_by IS NULL AND submitted_at IS NULL AND decided_by IS NULL AND decided_at IS NULL)
  OR (status='submitted' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND decided_by IS NULL AND decided_at IS NULL)
  OR (status IN ('approved','rejected') AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE TABLE public.payroll_compensation_assignments (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id), package_id uuid NOT NULL, version_id uuid NOT NULL,
 employment_id uuid NOT NULL, employee_party_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'), effective_to date CHECK(effective_to>=effective_from AND effective_to<=DATE '9999-12-31'),
 inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','active','rejected','ended','cancelled')),
 submitted_by uuid, submitted_at timestamptz, decided_by uuid, decided_at timestamptz,
 authorship jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(authorship)='array'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), FOREIGN KEY(org_id,package_id,version_id) REFERENCES public.payroll_compensation_versions(org_id,package_id,id),
 FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id), FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,submitted_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 CHECK((status IN ('draft','cancelled') AND submitted_by IS NULL AND submitted_at IS NULL AND decided_by IS NULL AND decided_at IS NULL)
  OR (status='submitted' AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND decided_by IS NULL AND decided_at IS NULL)
  OR (status IN ('active','rejected','ended') AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
 CHECK(status<>'ended' OR effective_to IS NOT NULL),
 EXCLUDE USING gist(org_id WITH =,employment_id WITH =,daterange(effective_from,effective_to,'[]') WITH &&) WHERE(status IN ('active','ended'))
);
CREATE INDEX payroll_compensation_assignment_window ON public.payroll_compensation_assignments(org_id,employment_id,effective_from) WHERE(status IN ('active','ended'));
CREATE TABLE public.payroll_compensation_calculations (
 id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.orgs(id),
 pay_run_document_id uuid NOT NULL, assignment_id uuid NOT NULL, employment_id uuid NOT NULL,
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'), result_snapshot jsonb NOT NULL CHECK(jsonb_typeof(result_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,pay_run_document_id,assignment_id),
 FOREIGN KEY(org_id,pay_run_document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,assignment_id) REFERENCES public.payroll_compensation_assignments(org_id,id),
 FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id), FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);

CREATE FUNCTION public.payroll_compensation_configuration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE approver_party uuid; submitter_party uuid; author_party uuid; subject_party uuid; v_org uuid;
BEGIN
 v_org := CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(v_org) THEN
  UPDATE public.payroll_compensation_configuration SET revision=revision+1 WHERE org_id=v_org;
  RETURN OLD;
 END IF;
 UPDATE public.payroll_compensation_configuration SET revision=revision+1 WHERE org_id=v_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Compensation configuration is missing; complete the database upgrade before saving.'; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 -- Only tenant-reference rebasing is admitted after the controlled bulk copy.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='payroll_compensation_versions' AND public.openbooks_clone_authority()
  AND (to_jsonb(NEW)-ARRAY['definition','definition_hash','authorship'])=(to_jsonb(OLD)-ARRAY['definition','definition_hash','authorship']) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='payroll_compensation_assignments' AND public.openbooks_clone_authority()
  AND (to_jsonb(NEW)-'authorship')=(to_jsonb(OLD)-'authorship') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Compensation configuration preserves approval history; retire the package or cancel an unused draft instead.'; END IF;
 IF TG_OP='INSERT' AND TG_TABLE_NAME<>'payroll_compensation_packages' AND NEW.status<>'draft' THEN
  RAISE EXCEPTION 'Create a compensation draft before submitting it for independent approval.';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.org_id,NEW.id,NEW.created_at,NEW.created_by) IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.created_at,OLD.created_by) THEN
   RAISE EXCEPTION 'Compensation record ownership and creation evidence are immutable.';
  END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Compensation revision changed; reload the record before saving.'; END IF;
  IF TG_TABLE_NAME='payroll_compensation_packages' THEN
   IF ROW(NEW.subsidiary_id,NEW.code,NEW.country,NEW.currency) IS DISTINCT FROM ROW(OLD.subsidiary_id,OLD.code,OLD.country,OLD.currency) THEN
    RAISE EXCEPTION 'Package employer, code, country and currency are immutable; create a separate package.';
   END IF;
   IF OLD.status='retired' THEN RAISE EXCEPTION 'A retired compensation package is immutable; create a new package.'; END IF;
  ELSE
   IF NEW.package_id IS DISTINCT FROM OLD.package_id OR (TG_TABLE_NAME='payroll_compensation_versions' AND (to_jsonb(NEW)->'version') IS DISTINCT FROM (to_jsonb(OLD)->'version')) THEN
    RAISE EXCEPTION 'Compensation package ownership and version numbers are immutable; create a new draft.';
   END IF;
   IF OLD.status NOT IN ('draft','submitted') THEN
    IF TG_TABLE_NAME<>'payroll_compensation_assignments' OR OLD.status<>'active' OR NEW.status<>'ended' THEN
     RAISE EXCEPTION 'Approved compensation history is immutable; create an effective-dated successor.';
    END IF;
    IF (to_jsonb(NEW)-ARRAY['status','effective_to','revision','reason','updated_at','updated_by']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','effective_to','revision','reason','updated_at','updated_by'])
       OR NEW.effective_to IS NULL OR (OLD.effective_to IS NOT NULL AND NEW.effective_to>OLD.effective_to) THEN
     RAISE EXCEPTION 'Ending an assignment may only shorten its window; create an approved successor for changed terms.';
    END IF;
    IF EXISTS(SELECT 1 FROM public.payroll_compensation_calculations c JOIN public.pay_runs r ON r.org_id=c.org_id AND r.document_id=c.pay_run_document_id
      WHERE c.org_id=OLD.org_id AND c.assignment_id=OLD.id AND r.run_status IN ('committed','voided') AND r.period_end>NEW.effective_to) THEN
     RAISE EXCEPTION 'The assignment has payroll history after that end date; preserve the paid window and use a controlled payroll correction.';
    END IF;
   ELSIF OLD.status='submitted' THEN
    IF NEW.status NOT IN ('approved','active','rejected') OR
       (TG_TABLE_NAME='payroll_compensation_versions' AND NEW.status='active') OR
       (TG_TABLE_NAME='payroll_compensation_assignments' AND NEW.status='approved') OR
       (to_jsonb(NEW)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','decided_by','decided_at','revision','reason','updated_at','updated_by']) THEN
     RAISE EXCEPTION 'Submitted compensation terms are frozen; decide this proposal or create a new draft.';
    END IF;
   ELSIF NEW.status NOT IN ('draft','submitted','cancelled') OR (TG_TABLE_NAME='payroll_compensation_versions' AND NEW.status='cancelled') THEN
    RAISE EXCEPTION 'Submit the compensation draft before requesting independent approval.';
   END IF;
  END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='submitted' THEN
  IF NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN RAISE EXCEPTION 'The compensation decision must identify the actor making it.'; END IF;
  SELECT party_id INTO approver_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.decided_by AND is_active;
  SELECT party_id INTO submitter_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.submitted_by;
  SELECT party_id INTO author_party FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by;
  IF approver_party IS NULL OR NEW.decided_by IN (NEW.submitted_by,NEW.created_by) OR approver_party IS NOT DISTINCT FROM submitter_party OR approver_party IS NOT DISTINCT FROM author_party
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.authorship) a LEFT JOIN public.users u ON u.org_id=NEW.org_id AND u.id=(a->>'actorId')::uuid
    WHERE u.id IS NULL OR u.party_id IS NULL OR u.id=NEW.decided_by OR u.party_id=approver_party OR (a->>'partyId')::uuid=approver_party)
   OR EXISTS(SELECT 1 FROM public.audit_log a JOIN public.users u ON u.org_id=a.org_id AND u.id=a.actor_id
    WHERE a.org_id=NEW.org_id AND a.table_name=TG_TABLE_NAME AND a.row_id=NEW.id AND
     (u.id=NEW.decided_by OR u.party_id=approver_party OR (a.changes->>'actorPartyId')::uuid=approver_party)) THEN
   RAISE EXCEPTION 'Compensation approval needs an independently identified person; link the approver to their native person record and choose someone other than the author or submitter.';
  END IF;
  IF TG_TABLE_NAME='payroll_compensation_assignments' THEN
   subject_party := NEW.employee_party_id;
   IF approver_party=subject_party THEN RAISE EXCEPTION 'The affected employee cannot approve their own compensation assignment; choose an independent approver.'; END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME<>'payroll_compensation_packages' THEN
  IF TG_OP='INSERT' THEN
   NEW.authorship := jsonb_build_array(jsonb_build_object('actorId',NEW.created_by,'partyId',(SELECT party_id FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by)));
  ELSIF OLD.status='draft' THEN
   NEW.authorship := OLD.authorship;
   -- Submission records the submitting person's identity as well as draft authors.
   IF NEW.status IN ('draft','submitted') THEN
    SELECT jsonb_agg(value ORDER BY value->>'actorId',value->>'partyId') INTO NEW.authorship FROM
     (SELECT DISTINCT value FROM jsonb_array_elements(NEW.authorship || jsonb_build_array(jsonb_build_object('actorId',NEW.updated_by,'partyId',(SELECT party_id FROM public.users WHERE org_id=NEW.org_id AND id=NEW.updated_by))))) authors;
   END IF;
  END IF;
  IF jsonb_array_length(NEW.authorship)>128 THEN RAISE EXCEPTION 'A compensation draft has too many distinct authorship identities; create a new version for the next proposal.'; END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE FUNCTION public.payroll_compensation_assignment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND public.openbooks_clone_authority() AND (to_jsonb(NEW)-'authorship')=(to_jsonb(OLD)-'authorship') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.status IN ('rejected','cancelled') THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.worker_employments w JOIN public.payroll_compensation_packages p ON p.org_id=w.org_id AND p.id=NEW.package_id
  JOIN public.payroll_compensation_versions v ON v.org_id=p.org_id AND v.package_id=p.id AND v.id=NEW.version_id
  WHERE w.org_id=NEW.org_id AND w.id=NEW.employment_id AND w.worker_party_id=NEW.employee_party_id
   AND w.employer_subsidiary_id=NEW.subsidiary_id AND p.subsidiary_id=NEW.subsidiary_id
   AND v.status='approved' AND NEW.effective_from>=v.effective_from
   AND (v.effective_to IS NULL OR (NEW.effective_to IS NOT NULL AND NEW.effective_to<=v.effective_to))
   AND (SELECT range_agg(daterange(ev.effective_from,ev.effective_to,'[)')) FROM public.worker_employment_versions ev
    WHERE ev.org_id=w.org_id AND ev.employment_id=w.id AND ev.recorded_until IS NULL AND ev.status IN ('active','on_leave'))
    @> daterange(NEW.effective_from,NEW.effective_to,'[]')) THEN
  RAISE EXCEPTION 'Choose an approved package version and an assignment window covered by this employee''s employment and package employer.';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER payroll_compensation_assignment_subject BEFORE INSERT OR UPDATE ON public.payroll_compensation_assignments
 FOR EACH ROW EXECUTE FUNCTION public.payroll_compensation_assignment_guard();

CREATE FUNCTION public.payroll_compensation_calculation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE v_org uuid; v_run uuid; v_status text;
BEGIN
 v_org := CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 v_run := CASE WHEN TG_OP='DELETE' THEN OLD.pay_run_document_id ELSE NEW.pay_run_document_id END;
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(v_org) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 SELECT run_status INTO v_status FROM public.pay_runs WHERE org_id=v_org AND document_id=v_run FOR UPDATE;
 IF v_status IS NULL OR v_status IN ('committed','voided') THEN RAISE EXCEPTION 'Compensation calculation evidence belongs to an editable native pay run; preserve posted evidence and use a controlled correction.'; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Replace compensation calculation evidence only through native recalculation.'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.payroll_compensation_assignments WHERE org_id=NEW.org_id AND id=NEW.assignment_id AND employment_id=NEW.employment_id AND status IN ('active','ended')) THEN
  RAISE EXCEPTION 'Compensation evidence needs the active native employment assignment used by this calculation.';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
CREATE TRIGGER payroll_compensation_calculation_history BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_compensation_calculations
 FOR EACH ROW EXECUTE FUNCTION public.payroll_compensation_calculation_guard();

CREATE FUNCTION public.payroll_compensation_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,TG_TABLE_NAME,NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE NEW.updated_by END,
  jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'reason',CASE WHEN public.openbooks_clone_authority() THEN 'Rebase native compensation identities during controlled sandbox cloning.' ELSE NEW.reason END,
   'actorPartyId',CASE WHEN NOT public.openbooks_clone_authority() THEN (SELECT party_id FROM public.users WHERE org_id=NEW.org_id AND id=NEW.updated_by) END));
 RETURN NEW;
END $function$;
DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['payroll_compensation_packages','payroll_compensation_versions','payroll_compensation_assignments'] LOOP
  EXECUTE format('CREATE TRIGGER payroll_compensation_configuration BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_compensation_configuration_guard()',tbl);
  EXECUTE format('CREATE TRIGGER payroll_compensation_audit AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.payroll_compensation_audit()',tbl);
 END LOOP;
 FOREACH tbl IN ARRAY ARRAY['payroll_compensation_configuration','payroll_compensation_packages','payroll_compensation_versions','payroll_compensation_assignments','payroll_compensation_calculations'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
 END LOOP;
END $block$;
SELECT public.openbooks_refresh_query_catalog();

-- The controlled sandbox wipe deletes child tables before their parents.
-- Ordinary component classification deletion remains prohibited.
CREATE OR REPLACE FUNCTION public.pay_component_earning_classifications_prevent_orphan_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
BEGIN
 IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF EXISTS(SELECT 1 FROM public.pay_components WHERE org_id=OLD.org_id AND id=OLD.pay_component_id) THEN
  RAISE EXCEPTION 'Pay component classifications cannot be deleted independently; edit the native component classification instead.';
 END IF;
 RETURN OLD;
END $function$;
