-- Version-bound schedule reports and native resource contacts support reviewed email issuance.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);
ALTER TABLE public.schedule_boards ADD COLUMN show_hours_column boolean NOT NULL DEFAULT true;
ALTER TABLE public.schedule_boards ADD COLUMN distribution_visibility text NOT NULL DEFAULT 'personal' CHECK(distribution_visibility IN('personal','board'));
ALTER TABLE public.schedule_boards ADD CONSTRAINT schedule_boards_distribution_entity CHECK(distribution_visibility <> 'board' OR subsidiary_id IS NOT NULL);
COMMENT ON COLUMN public.schedule_boards.distribution_visibility IS 'Explicit audience policy for personal or whole-board schedule email reports; never grants general organization access.';
COMMENT ON COLUMN public.schedule_boards.show_hours_column IS 'Display booked-hour sums separately from daily footer totals; date-only observations retain unknown hours.';
CREATE TABLE public.schedule_resource_recipients (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),
 board_id uuid NOT NULL,equipment_unit_id uuid,resource_location_id uuid,party_id uuid NOT NULL,subsidiary_id uuid,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),is_active boolean NOT NULL DEFAULT true,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),CHECK(num_nonnulls(equipment_unit_id,resource_location_id)=1),
 FOREIGN KEY(org_id,board_id) REFERENCES public.schedule_boards(org_id,id),
 FOREIGN KEY(org_id,equipment_unit_id) REFERENCES public.equipment_units(org_id,id),
 FOREIGN KEY(org_id,resource_location_id) REFERENCES public.locations(org_id,id),
 FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);
CREATE UNIQUE INDEX schedule_resource_recipients_equipment ON public.schedule_resource_recipients(org_id,board_id,equipment_unit_id) WHERE is_active AND equipment_unit_id IS NOT NULL;
CREATE UNIQUE INDEX schedule_resource_recipients_location ON public.schedule_resource_recipients(org_id,board_id,resource_location_id) WHERE is_active AND resource_location_id IS NOT NULL;
CREATE TABLE public.schedule_distributions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),board_id uuid NOT NULL,subsidiary_id uuid,
 from_date date NOT NULL,through_date date NOT NULL,version text NOT NULL CHECK(version ~ '^[0-9a-f]{64}$'),audience jsonb NOT NULL CHECK(jsonb_typeof(audience)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),replay_key text NOT NULL CHECK(length(replay_key) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'previewed' CHECK(status IN('previewed','queued')),flow_run_id uuid,queued_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,replay_key),CHECK(through_date>=from_date AND through_date-from_date<42),
 CHECK((status='queued')=(flow_run_id IS NOT NULL AND queued_at IS NOT NULL)),
 FOREIGN KEY(org_id,board_id) REFERENCES public.schedule_boards(org_id,id),FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,flow_run_id) REFERENCES public.flow_runs(org_id,id),FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);
-- Unsent reviews can be superseded by another reviewed intent; one queued version owns delivery.
CREATE UNIQUE INDEX schedule_distributions_version_key ON public.schedule_distributions(org_id,board_id,version) WHERE status='queued';
CREATE TABLE public.schedule_distribution_recipients (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),distribution_id uuid NOT NULL,party_id uuid NOT NULL,
 worker_party_id uuid,equipment_unit_id uuid,resource_location_id uuid,email text,report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(org_id,id),CHECK(num_nonnulls(worker_party_id,equipment_unit_id,resource_location_id)=1),
 FOREIGN KEY(org_id,distribution_id) REFERENCES public.schedule_distributions(org_id,id),FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,worker_party_id) REFERENCES public.parties(org_id,id),FOREIGN KEY(org_id,equipment_unit_id) REFERENCES public.equipment_units(org_id,id),
 FOREIGN KEY(org_id,resource_location_id) REFERENCES public.locations(org_id,id)
);
CREATE FUNCTION public.schedule_distribution_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='schedule_distributions' AND TG_OP='UPDATE' THEN
  IF OLD.status='previewed' AND NEW.status='queued' AND (to_jsonb(OLD)-ARRAY['status','flow_run_id','queued_at'])=(to_jsonb(NEW)-ARRAY['status','flow_run_id','queued_at'])
   AND EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.flow_run_id AND r.subject_kind='schedule_distribution' AND r.subject_id=NEW.id AND r.created_by=NEW.created_by) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Reviewed schedule snapshots are immutable; create a new review to change the report or audience.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER schedule_distributions_snapshot_guard BEFORE UPDATE OR DELETE ON public.schedule_distributions FOR EACH ROW EXECUTE FUNCTION public.schedule_distribution_snapshot_guard();
CREATE TRIGGER schedule_distribution_recipients_snapshot_guard BEFORE UPDATE OR DELETE ON public.schedule_distribution_recipients FOR EACH ROW EXECUTE FUNCTION public.schedule_distribution_snapshot_guard();
CREATE FUNCTION public.schedule_resource_recipients_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE b public.schedule_boards;p public.parties;owner uuid;
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN
  IF (OLD.org_id,OLD.board_id,OLD.equipment_unit_id,OLD.resource_location_id,OLD.subsidiary_id,OLD.created_by,OLD.created_at) IS DISTINCT FROM (NEW.org_id,NEW.board_id,NEW.equipment_unit_id,NEW.resource_location_id,NEW.subsidiary_id,NEW.created_by,NEW.created_at) OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'Resource recipient identity is immutable and edits need the next native revision.' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT * INTO b FROM public.schedule_boards WHERE org_id=NEW.org_id AND id=NEW.board_id FOR SHARE;
 SELECT * INTO p FROM public.parties WHERE org_id=NEW.org_id AND id=NEW.party_id FOR SHARE;
 IF b.row_kind IS DISTINCT FROM 'resources' OR (NEW.is_active AND NOT p.is_active) OR p.id IS NULL OR p.kind <> 'person' THEN RAISE EXCEPTION 'Choose a resource board and an active native person/contact.' USING ERRCODE='23514'; END IF;
 IF NEW.equipment_unit_id IS NOT NULL AND b.resource_kind='equipment' THEN SELECT subsidiary_id INTO owner FROM public.equipment_units WHERE org_id=NEW.org_id AND id=NEW.equipment_unit_id FOR SHARE;
 ELSIF NEW.resource_location_id IS NOT NULL AND b.resource_kind='location' THEN SELECT subsidiary_id INTO owner FROM public.locations WHERE org_id=NEW.org_id AND id=NEW.resource_location_id FOR SHARE;
 ELSE RAISE EXCEPTION 'The recipient resource must match the board resource kind.' USING ERRCODE='23514'; END IF;
 IF NOT FOUND OR owner IS DISTINCT FROM NEW.subsidiary_id OR (b.subsidiary_id IS NOT NULL AND owner IS DISTINCT FROM b.subsidiary_id) OR p.subsidiary_id IS DISTINCT FROM owner THEN RAISE EXCEPTION 'The resource, contact and board must share their authorized legal entity.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_resource_recipients_guard BEFORE INSERT OR UPDATE ON public.schedule_resource_recipients FOR EACH ROW EXECUTE FUNCTION public.schedule_resource_recipients_guard();
ALTER TABLE public.schedule_resource_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_resource_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.schedule_resource_recipients USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.schedule_resource_recipients IS 'openbooks:org_isolation:v1';
ALTER TABLE public.schedule_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_distributions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.schedule_distributions USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.schedule_distributions IS 'openbooks:org_isolation:v1';
ALTER TABLE public.schedule_distribution_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_distribution_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.schedule_distribution_recipients USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.schedule_distribution_recipients IS 'openbooks:org_isolation:v1';
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES('schedule_resource_recipients','0597_schedule_distribution_and_display'),('schedule_distributions','0597_schedule_distribution_and_display'),('schedule_distribution_recipients','0597_schedule_distribution_and_display') ON CONFLICT(relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
