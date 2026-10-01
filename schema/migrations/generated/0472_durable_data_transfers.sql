-- Durable source evidence, bounded staging and atomic import checkpoints.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE public.data_transfer_jobs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL,
 actor_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('import','export')),
 resource_key text NOT NULL, format text NOT NULL CHECK (format IN ('csv','xlsx','json')),
 file_name text NOT NULL, state text NOT NULL CHECK (state IN ('uploading','parsing','mapping','previewing','ready','committing','exporting','completed','failed','cancelled')),
 revision integer NOT NULL DEFAULT 1, byte_count bigint NOT NULL DEFAULT 0 CHECK (byte_count >= 0),
 uploaded_bytes bigint NOT NULL DEFAULT 0 CHECK (uploaded_bytes >= 0),
 total_rows bigint NOT NULL DEFAULT 0 CHECK (total_rows >= 0), processed_rows bigint NOT NULL DEFAULT 0 CHECK (processed_rows >= 0),
 scope jsonb NOT NULL, options jsonb NOT NULL DEFAULT '{}', headers jsonb NOT NULL DEFAULT '[]',
 fields jsonb NOT NULL DEFAULT '[]', sample jsonb NOT NULL DEFAULT '[]',
 outcome jsonb NOT NULL DEFAULT '{"created":0,"updated":0,"failed":0,"errors":[]}',
 preview jsonb NOT NULL DEFAULT '{"created":0,"updated":0,"failed":0,"errors":[]}',
 approval_hash text, schema_hash text, source_hash text,
 cancel_requested boolean NOT NULL DEFAULT false, error text, failed_phase text,
 claim_token uuid, claim_until timestamptz,
 request_key uuid NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (org_id,id), UNIQUE (org_id,actor_id,request_key)
);
CREATE INDEX data_transfer_jobs_dispatch ON public.data_transfer_jobs (state,claim_until,updated_at) WHERE state IN ('parsing','previewing','committing','exporting');
CREATE INDEX data_transfer_jobs_org_history ON public.data_transfer_jobs (org_id,actor_id,created_at DESC,id);

CREATE TABLE public.data_transfer_chunks (
 org_id uuid NOT NULL, job_id uuid NOT NULL, direction text NOT NULL CHECK (direction IN ('source','output')),
 part_no integer NOT NULL CHECK (part_no >= 0), data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 4194304),
 sha256 text NOT NULL CHECK (length(sha256)=64),
 PRIMARY KEY (org_id,job_id,direction,part_no),
 FOREIGN KEY (org_id,job_id) REFERENCES public.data_transfer_jobs (org_id,id) ON DELETE CASCADE
);
CREATE TABLE public.data_transfer_rows (
 org_id uuid NOT NULL, job_id uuid NOT NULL, row_no bigint NOT NULL CHECK (row_no > 0),
 data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'), keys jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY (org_id,job_id,row_no),
 FOREIGN KEY (org_id,job_id) REFERENCES public.data_transfer_jobs (org_id,id) ON DELETE CASCADE
);
CREATE TABLE public.data_transfer_keys (
 org_id uuid NOT NULL, job_id uuid NOT NULL, key_hash text NOT NULL, row_no bigint NOT NULL,
 PRIMARY KEY (org_id,job_id,key_hash,row_no),
 FOREIGN KEY (org_id,job_id,row_no) REFERENCES public.data_transfer_rows (org_id,job_id,row_no) ON DELETE CASCADE
);
-- Tenant teardown must locate a source row's keys without scanning every key.
CREATE INDEX data_transfer_keys_source_row ON public.data_transfer_keys (org_id,job_id,row_no);
CREATE TABLE public.data_transfer_issues (
 org_id uuid NOT NULL, job_id uuid NOT NULL, phase text NOT NULL CHECK (phase IN ('preview','commit')),
 row_no bigint NOT NULL, severity text NOT NULL CHECK (severity IN ('error','warning')), message text NOT NULL, field text,
 FOREIGN KEY (org_id,job_id) REFERENCES public.data_transfer_jobs (org_id,id) ON DELETE CASCADE
);
CREATE INDEX data_transfer_issues_page ON public.data_transfer_issues (org_id,job_id,phase,row_no);
CREATE TABLE public.data_transfer_events (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL, job_id uuid NOT NULL,
 actor_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 action text NOT NULL, before_state text, after_state text NOT NULL, revision integer NOT NULL,
 evidence jsonb NOT NULL DEFAULT '{}',
 FOREIGN KEY (org_id,job_id) REFERENCES public.data_transfer_jobs (org_id,id) ON DELETE CASCADE
);
CREATE INDEX data_transfer_events_job ON public.data_transfer_events (org_id,job_id,occurred_at,id);

-- Original source and lifecycle evidence cannot be rewritten by an operator.
-- Controlled tenant teardown uses the same privileged amendment boundary as
-- other immutable financial evidence. Unpublished export parts may be retried.
CREATE FUNCTION public.data_transfer_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF public.app_bypass_rls_active() AND current_setting('openbooks.amend',true)='on' THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='data_transfer_chunks' THEN
  IF TG_OP='DELETE' AND OLD.direction='output'
     AND EXISTS (SELECT 1 FROM public.data_transfer_jobs WHERE org_id=OLD.org_id AND id=OLD.job_id AND state='exporting') THEN
   RETURN OLD;
  END IF;
 ELSIF TG_TABLE_NAME='data_transfer_rows' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.org_id,NEW.job_id,NEW.row_no,NEW.data) IS NOT DISTINCT FROM ROW(OLD.org_id,OLD.job_id,OLD.row_no,OLD.data) THEN
   RETURN NEW;
  END IF;
 END IF;
 RAISE EXCEPTION 'Transfer source and lifecycle evidence are immutable; create a new transfer for corrected source data.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER data_transfer_chunks_evidence_guard BEFORE UPDATE OR DELETE ON public.data_transfer_chunks FOR EACH ROW EXECUTE FUNCTION public.data_transfer_evidence_guard();
CREATE TRIGGER data_transfer_rows_evidence_guard BEFORE UPDATE OR DELETE ON public.data_transfer_rows FOR EACH ROW EXECUTE FUNCTION public.data_transfer_evidence_guard();
CREATE TRIGGER data_transfer_events_evidence_guard BEFORE UPDATE OR DELETE ON public.data_transfer_events FOR EACH ROW EXECUTE FUNCTION public.data_transfer_evidence_guard();

ALTER TABLE public.data_transfer_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_jobs
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_jobs IS 'openbooks:org_isolation:v1';

ALTER TABLE public.data_transfer_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_chunks
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_chunks IS 'openbooks:org_isolation:v1';

ALTER TABLE public.data_transfer_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_rows
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_rows IS 'openbooks:org_isolation:v1';

ALTER TABLE public.data_transfer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_keys
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_keys IS 'openbooks:org_isolation:v1';

ALTER TABLE public.data_transfer_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_issues
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_issues IS 'openbooks:org_isolation:v1';

ALTER TABLE public.data_transfer_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_transfer_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.data_transfer_events
 USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.data_transfer_events IS 'openbooks:org_isolation:v1';
