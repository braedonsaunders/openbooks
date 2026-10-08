-- Immutable source scheduling evidence retains date-only history without
-- manufacturing working spans, employee status or financial transactions.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.schedule_boards ADD COLUMN day_policy_known boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.schedule_boards.day_policy_known IS
 'Whether the configured working-day clock times and break are authoritative. Date-only source history remains readable when false; normal whole-day booking refuses until working hours are configured.';
CREATE FUNCTION public.schedule_entries_known_day_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NEW.span_mode='day' AND NEW.status <> 'cancelled'
  AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status
    OR ROW(OLD.board_id,OLD.span_mode,OLD.starts_at,OLD.ends_at,OLD.break_minutes,OLD.time_zone)
     IS DISTINCT FROM ROW(NEW.board_id,NEW.span_mode,NEW.starts_at,NEW.ends_at,NEW.break_minutes,NEW.time_zone))
  AND EXISTS(SELECT 1 FROM public.schedule_boards WHERE org_id=NEW.org_id AND id=NEW.board_id AND NOT day_policy_known) THEN
  RAISE EXCEPTION 'The board has no authoritative working-day hours; configure its start, end and break in Board Settings before booking a whole day.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_entries_known_day_guard BEFORE INSERT OR UPDATE ON public.schedule_entries
 FOR EACH ROW EXECUTE FUNCTION public.schedule_entries_known_day_guard();

CREATE TABLE public.schedule_source_records (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 source_system text NOT NULL CHECK (length(source_system) BETWEEN 1 AND 200),
 source_dataset text NOT NULL CHECK (length(source_dataset) BETWEEN 1 AND 200),
 source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),
 source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
 assessment_hash text NOT NULL CHECK (assessment_hash ~ '^[0-9a-f]{64}$'),
 capture_hash text NOT NULL CHECK (capture_hash ~ '^[0-9a-f]{64}$'),
 source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object'),
 disposition text NOT NULL CHECK (disposition IN ('recorded','linked','exception')),
 board_id uuid,
 worker_party_id uuid,
 subsidiary_id uuid,
 on_date date,
 label text CHECK (label IS NULL OR length(label) <= 1000),
 source_result text CHECK (source_result IS NULL OR length(source_result) <= 1000),
 source_notes text CHECK (source_notes IS NULL OR length(source_notes) <= 2000),
 visible_in_source boolean NOT NULL,
 linked_entry_id uuid,
 supersedes_id uuid,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 UNIQUE (org_id,id),
 UNIQUE (org_id,supersedes_id),
 FOREIGN KEY (org_id,board_id) REFERENCES public.schedule_boards(org_id,id),
 FOREIGN KEY (org_id,worker_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY (org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY (org_id,linked_entry_id) REFERENCES public.schedule_entries(org_id,id),
 FOREIGN KEY (org_id,supersedes_id) REFERENCES public.schedule_source_records(org_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY (org_id,created_by) REFERENCES public.users(org_id,id),
 CHECK (disposition = 'exception' OR (board_id IS NOT NULL AND worker_party_id IS NOT NULL AND on_date IS NOT NULL)),
 CHECK ((disposition = 'linked') = (linked_entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX schedule_source_records_first ON public.schedule_source_records(org_id,source_system,source_dataset,source_key)
 WHERE supersedes_id IS NULL;
CREATE INDEX schedule_source_records_board_date ON public.schedule_source_records(org_id,board_id,on_date);
CREATE INDEX schedule_source_records_worker_date ON public.schedule_source_records(org_id,worker_party_id,on_date);

COMMENT ON TABLE public.schedule_source_records IS
 'Reviewed immutable source-row evidence. Recorded rows preserve source scheduling dates and literal labels, not worked hours or employee lifecycle. Linked rows identify governed native bookings. Exceptions retain unresolved facts with an explicit review reason.';

CREATE FUNCTION public.schedule_source_records_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE prior public.schedule_source_records; board public.schedule_boards; person public.parties;
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Source scheduling evidence is immutable; record a reviewed successor instead.' USING ERRCODE='23514';
 END IF;
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by AND is_active) THEN
  RAISE EXCEPTION 'Source evidence must identify an active organization actor.' USING ERRCODE='23514';
 END IF;
 IF NEW.supersedes_id IS NOT NULL THEN
  SELECT * INTO prior FROM public.schedule_source_records WHERE org_id=NEW.org_id AND id=NEW.supersedes_id FOR UPDATE;
  IF NOT FOUND OR ROW(prior.source_system,prior.source_dataset,prior.source_key)
   IS DISTINCT FROM ROW(NEW.source_system,NEW.source_dataset,NEW.source_key) THEN
   RAISE EXCEPTION 'The source successor must name the same source identity.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.board_id IS NOT NULL THEN
  SELECT * INTO board FROM public.schedule_boards WHERE org_id=NEW.org_id AND id=NEW.board_id FOR SHARE;
  IF NOT FOUND OR board.row_kind <> 'people' THEN
   RAISE EXCEPTION 'Source people scheduling belongs to a native people board.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.worker_party_id IS NOT NULL THEN
  SELECT * INTO person FROM public.parties WHERE org_id=NEW.org_id AND id=NEW.worker_party_id FOR SHARE;
  IF NOT FOUND OR person.kind <> 'person'
   OR NOT EXISTS(SELECT 1 FROM public.employee_roles er WHERE er.org_id=NEW.org_id AND er.party_id=NEW.worker_party_id)
   OR person.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
   OR (NEW.board_id IS NOT NULL AND board.subsidiary_id IS NOT NULL AND board.subsidiary_id IS DISTINCT FROM person.subsidiary_id) THEN
   RAISE EXCEPTION 'The source person and board must belong to the same authorized legal entity.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.disposition='linked' AND NOT EXISTS (SELECT 1 FROM public.schedule_entries e
   WHERE e.org_id=NEW.org_id AND e.id=NEW.linked_entry_id AND e.board_id=NEW.board_id
    AND e.worker_party_id=NEW.worker_party_id AND e.starts_on=NEW.on_date) THEN
  RAISE EXCEPTION 'The native booking does not match this source person, board and date.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_source_records_guard BEFORE INSERT OR UPDATE OR DELETE ON public.schedule_source_records
 FOR EACH ROW EXECUTE FUNCTION public.schedule_source_records_guard();

CREATE FUNCTION public.schedule_source_records_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
 VALUES(NEW.org_id,'schedule_source_records',NEW.id,'insert',
  jsonb_build_object('after',to_jsonb(NEW),'reason',NEW.reason),NEW.created_by);
 RETURN NEW;
END $function$;
CREATE TRIGGER schedule_source_records_audit AFTER INSERT ON public.schedule_source_records
 FOR EACH ROW EXECUTE FUNCTION public.schedule_source_records_audit();

ALTER TABLE public.schedule_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_source_records FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.schedule_source_records
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.schedule_source_records IS 'openbooks:org_isolation:v1';
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in)
 VALUES('schedule_source_records','0595_schedule_source_history')
 ON CONFLICT(relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
