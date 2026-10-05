-- OpenBooks forward migration 0553_hrm_training_delivery.
-- Course policies, delivery sessions and participant outcomes retain their
-- approved definitions and link to the native qualification ledger.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.hrm_training_courses (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), subsidiary_id uuid NOT NULL,
 code text NOT NULL CHECK(length(code) BETWEEN 1 AND 64 AND code=btrim(code)), version integer NOT NULL CHECK(version>0),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160), description text,
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 effective_to date CHECK(effective_to>=effective_from AND effective_to<=DATE '9999-12-31'),
 qualification_type_id uuid, minimum_attendance_percent integer NOT NULL CHECK(minimum_attendance_percent BETWEEN 0 AND 100),
 qualification_validity_months integer CHECK(qualification_validity_months>0), qualification_requires_evidence boolean NOT NULL DEFAULT false,
 passing_score integer CHECK(passing_score BETWEEN 0 AND 100),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired','cancelled')),
 author_party_id uuid NOT NULL, decided_by uuid, decided_at timestamptz,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,subsidiary_id,code,version), UNIQUE(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,qualification_type_id) REFERENCES public.hrm_qualification_types(org_id,id),
 FOREIGN KEY(org_id,author_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 FOREIGN KEY(org_id,decided_by) REFERENCES public.users(org_id,id),
 CHECK((status IN ('draft','cancelled') AND decided_by IS NULL AND decided_at IS NULL)
  OR (status IN ('approved','retired') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
 CHECK(qualification_type_id IS NOT NULL OR (qualification_validity_months IS NULL AND NOT qualification_requires_evidence)),
 EXCLUDE USING gist(org_id WITH =,subsidiary_id WITH =,code WITH =,daterange(effective_from,effective_to,'[]') WITH &&) WHERE(status='approved')
);
CREATE TABLE public.hrm_training_sessions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), subsidiary_id uuid NOT NULL, course_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160), location text NOT NULL CHECK(length(btrim(location)) BETWEEN 1 AND 500),
 time_zone text NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 128), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 starts_on date NOT NULL, ends_on date NOT NULL, duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 1 AND 2678400),
 capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 10000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','in_progress','completed','cancelled')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,subsidiary_id,course_id) REFERENCES public.hrm_training_courses(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 CHECK(ends_at>starts_at AND extract(epoch FROM ends_at-starts_at)=duration_seconds),
 CHECK(starts_on BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND ends_on>=starts_on AND ends_on<=DATE '9999-12-31')
);
CREATE INDEX hrm_training_sessions_calendar ON public.hrm_training_sessions(org_id,subsidiary_id,starts_at);
CREATE UNIQUE INDEX hrm_worker_qualifications_training_subject ON public.hrm_worker_qualifications(org_id,employment_id,type_id,id);
CREATE TABLE public.hrm_training_participants (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), session_id uuid NOT NULL,
 employment_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','accepted','declined','completed','failed','voided','cancelled')),
 attendance_seconds integer CHECK(attendance_seconds>=0), score integer CHECK(score BETWEEN 0 AND 100),
 evidence_file_id uuid, notes text CHECK(length(notes)<=5000),
 qualification_type_id uuid, qualification_id uuid, qualification_created boolean NOT NULL DEFAULT false,
 completion_hash text CHECK(completion_hash ~ '^[0-9a-f]{64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,session_id,employment_id),
 FOREIGN KEY(org_id,subsidiary_id,session_id) REFERENCES public.hrm_training_sessions(org_id,subsidiary_id,id),
 FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
 FOREIGN KEY(org_id,evidence_file_id) REFERENCES public.files(org_id,id),
 FOREIGN KEY(org_id,employment_id,qualification_type_id,qualification_id) REFERENCES public.hrm_worker_qualifications(org_id,employment_id,type_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id), FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 CHECK((status IN ('completed','failed','voided'))=(completion_hash IS NOT NULL AND attendance_seconds IS NOT NULL)),
 CHECK(status IN ('completed','failed','voided') OR (attendance_seconds IS NULL AND score IS NULL AND evidence_file_id IS NULL AND notes IS NULL)),
 CHECK(qualification_id IS NULL OR (qualification_type_id IS NOT NULL AND status IN ('completed','voided'))),
 CHECK(NOT qualification_created OR qualification_id IS NOT NULL)
);
CREATE INDEX hrm_training_participants_employment ON public.hrm_training_participants(org_id,employment_id,session_id);
CREATE TABLE public.hrm_training_feedback (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), participant_id uuid NOT NULL,
 rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), comments text CHECK(length(comments)<=5000),
 supersedes_id uuid, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,participant_id,id), UNIQUE(org_id,supersedes_id),
 FOREIGN KEY(org_id,participant_id) REFERENCES public.hrm_training_participants(org_id,id),
 FOREIGN KEY(org_id,participant_id,supersedes_id) REFERENCES public.hrm_training_feedback(org_id,participant_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id)
);
CREATE UNIQUE INDEX hrm_training_feedback_first ON public.hrm_training_feedback(org_id,participant_id) WHERE supersedes_id IS NULL;

CREATE FUNCTION public.hrm_training_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE session_row public.hrm_training_sessions; course_row public.hrm_training_courses;
 author_person uuid; decision_person uuid; employer uuid; qualification_status text; passed boolean;
 validity integer; evidence_required boolean; qualification_issued date;
BEGIN
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
   IF NEW.status<>'draft' THEN RAISE EXCEPTION 'Create a course draft before independent approval.'; END IF;
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
    SELECT party_id INTO author_person FROM public.users WHERE org_id=NEW.org_id AND id=NEW.created_by;
    SELECT party_id INTO decision_person FROM public.users WHERE org_id=NEW.org_id AND id=NEW.updated_by AND is_active;
    IF author_person IS NULL OR decision_person IS NULL OR NEW.updated_by=NEW.created_by OR decision_person IN (author_person,NEW.author_party_id)
     OR NEW.decided_by IS DISTINCT FROM NEW.updated_by THEN
     RAISE EXCEPTION 'Course approval needs an independently identified person; link the approver to their person record and choose someone other than the author.';
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

CREATE FUNCTION public.hrm_training_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,TG_TABLE_NAME,NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE coalesce(to_jsonb(NEW)->>'updated_by',to_jsonb(NEW)->>'created_by')::uuid END,
  jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'reason',CASE WHEN public.openbooks_clone_authority() THEN 'Preserve training evidence during controlled sandbox cloning.' ELSE coalesce(to_jsonb(NEW)->>'reason','Participant training feedback.') END));
 RETURN NEW;
END $function$;
DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['hrm_training_courses','hrm_training_sessions','hrm_training_participants','hrm_training_feedback'] LOOP
  EXECUTE format('CREATE TRIGGER hrm_training_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hrm_training_guard()',tbl);
  EXECUTE format('CREATE TRIGGER hrm_training_audit AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.hrm_training_audit()',tbl);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
 END LOOP;
END $block$;
SELECT public.openbooks_refresh_query_catalog();
