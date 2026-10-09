-- Native timer delivery policies and deliberate occurrence identity preserve reviewed report snapshots.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);
ALTER TABLE public.schedule_boards ADD COLUMN automatic_delivery_policy jsonb CHECK(automatic_delivery_policy IS NULL OR jsonb_typeof(automatic_delivery_policy)='object');
COMMENT ON COLUMN public.schedule_boards.automatic_delivery_policy IS 'Native operator, audience, report window and format policy; activation and timer occurrences remain owned by Flows.';
DROP INDEX public.schedule_distributions_version_key;
-- Manual reviewed versions collapse once; different deliberate timer occurrences may issue unchanged reports.
CREATE UNIQUE INDEX schedule_distributions_version_key ON public.schedule_distributions(org_id,board_id,version) WHERE status='queued' AND replay_key NOT LIKE 'automatic:%';
-- An explicit whole-board contact is a recipient, not a manufactured worker/resource subject.
ALTER TABLE public.schedule_distribution_recipients DROP CONSTRAINT schedule_distribution_recipients_check;
ALTER TABLE public.schedule_distribution_recipients ADD CONSTRAINT schedule_distribution_recipients_subject_check CHECK(num_nonnulls(worker_party_id,equipment_unit_id,resource_location_id)<=1);
CREATE FUNCTION public.schedule_distribution_contact_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF public.openbooks_clone_authority() AND EXISTS(
  SELECT 1 FROM public.orgs target JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
   JOIN public.orgs source ON source.id=target.sandbox_of WHERE target.id=NEW.org_id AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
 ) THEN RETURN NEW; END IF;
 IF num_nonnulls(NEW.worker_party_id,NEW.equipment_unit_id,NEW.resource_location_id)=0 AND NOT EXISTS(
  SELECT 1 FROM public.schedule_distributions d JOIN public.parties p ON p.org_id=d.org_id AND p.id=NEW.party_id
  WHERE d.org_id=NEW.org_id AND d.id=NEW.distribution_id AND d.audience->>'visibility'='board' AND d.subsidiary_id IS NOT NULL
   AND p.subsidiary_id=d.subsidiary_id AND p.kind='person' AND p.is_active AND lower(btrim(p.email))=lower(btrim(NEW.email))
 ) THEN RAISE EXCEPTION 'Contacts-only delivery requires an active native contact and explicit whole-board entity sharing.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_distribution_contact_guard BEFORE INSERT ON public.schedule_distribution_recipients FOR EACH ROW EXECUTE FUNCTION public.schedule_distribution_contact_guard();

CREATE OR REPLACE FUNCTION public.schedule_distribution_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='schedule_distributions' AND TG_OP='UPDATE' THEN
  IF OLD.status='previewed' AND NEW.status='queued' AND (to_jsonb(OLD)-ARRAY['status','flow_run_id','queued_at'])=(to_jsonb(NEW)-ARRAY['status','flow_run_id','queued_at'])
   AND EXISTS(SELECT 1 FROM public.flow_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.flow_run_id AND r.created_by=NEW.created_by AND ((r.subject_kind='schedule_distribution' AND r.subject_id=NEW.id) OR (r.subject_kind='schedule_board' AND r.subject_id=NEW.board_id AND r.trigger='scheduled' AND NEW.replay_key LIKE 'automatic:%' AND NEW.reason='Automatic schedule occurrence '||r.occurrence_key))) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Reviewed schedule snapshots are immutable; create a new review to change the report or audience.' USING ERRCODE='23514';
END $function$;

CREATE FUNCTION public.schedule_delivery_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE operator uuid;
BEGIN
 IF NEW.automatic_delivery_policy IS NULL THEN RETURN NEW; END IF;
 IF NEW.row_kind NOT IN ('people','resources') THEN RAISE EXCEPTION 'Automatic schedule delivery requires a people or resource board.' USING ERRCODE='23514'; END IF;
 IF public.openbooks_clone_authority() THEN RAISE EXCEPTION 'Automatic delivery policies must be cleared when copying an environment.' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.automatic_delivery_policy IS NOT DISTINCT FROM NEW.automatic_delivery_policy THEN RETURN NEW; END IF;
 operator:=(NEW.automatic_delivery_policy->>'operatorId')::uuid;
 IF operator IS NULL OR operator IS DISTINCT FROM NEW.updated_by OR NOT EXISTS(SELECT 1 FROM public.users u WHERE u.org_id=NEW.org_id AND u.id=operator AND u.is_active) THEN
  RAISE EXCEPTION 'The active operator must configure their own automatic schedule delivery policy.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_delivery_policy_guard BEFORE INSERT OR UPDATE ON public.schedule_boards FOR EACH ROW EXECUTE FUNCTION public.schedule_delivery_policy_guard();
