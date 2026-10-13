-- Source-qualified returns to service and immutable issued ROE exclusion evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.payroll_roe_subsequent_service_sources (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL,
 preceding_event_id uuid NOT NULL, employee_party_id uuid NOT NULL,
 employment_id uuid NOT NULL, subsidiary_id uuid NOT NULL, first_day_worked date NOT NULL,
 source_file_id uuid NOT NULL, source_version_id uuid NOT NULL, source_sha256 text NOT NULL,
 source_reference text NOT NULL, change_reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
 CONSTRAINT payroll_roe_subsequent_service_sources_org_unique UNIQUE(org_id,id),
 CONSTRAINT payroll_roe_subsequent_service_sources_event_unique UNIQUE(org_id,preceding_event_id),
 CONSTRAINT payroll_roe_subsequent_service_sources_event_fkey FOREIGN KEY(org_id,preceding_event_id)
   REFERENCES public.payroll_roe_separation_events(org_id,id),
 CONSTRAINT payroll_roe_subsequent_service_sources_file_fkey FOREIGN KEY(source_file_id,source_version_id)
   REFERENCES public.file_versions(file_id,id),
 CONSTRAINT payroll_roe_subsequent_service_sources_date CHECK(first_day_worked BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 CONSTRAINT payroll_roe_subsequent_service_sources_source CHECK(source_sha256~'^[a-f0-9]{64}$'
   AND length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000)
);
ALTER TABLE public.payroll_roe_subsequent_service_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_subsequent_service_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_roe_subsequent_service_sources
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_roe_subsequent_service_sources IS 'openbooks:org_isolation:v1';

CREATE FUNCTION public.payroll_roe_subsequent_service_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Retain return-to-service certificates and their audit history; correct unused evidence through the native command' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.org_id,NEW.preceding_event_id,NEW.employee_party_id,NEW.employment_id,NEW.subsidiary_id,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.preceding_event_id,OLD.employee_party_id,OLD.employment_id,OLD.subsidiary_id,OLD.created_by,OLD.created_at) THEN
   RAISE EXCEPTION 'Return-to-service evidence cannot change its original event or subject identity' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id::text||':'||NEW.employee_party_id::text,0));
 IF public.payroll_roe_has_unbound_issued_source(NEW.org_id,NEW.employee_party_id) OR EXISTS(
   SELECT 1 FROM public.payroll_roe_issued_event_sources b WHERE b.org_id=NEW.org_id AND b.event_id=NEW.preceding_event_id) THEN
   RAISE EXCEPTION 'An issued ROE retains its service scope; preserve its source and use the statutory correction workflow' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_roe_separation_events e
   JOIN public.worker_employments w ON w.org_id=e.org_id AND w.id=e.employment_id
   WHERE e.org_id=NEW.org_id AND e.id=NEW.preceding_event_id AND e.status='confirmed'
     AND e.employee_party_id=NEW.employee_party_id AND e.employment_id=NEW.employment_id
     AND e.subsidiary_id=NEW.subsidiary_id AND w.worker_party_id=NEW.employee_party_id
     AND w.employer_subsidiary_id=NEW.subsidiary_id AND e.first_day_worked IS NOT NULL
     AND NEW.first_day_worked>e.interruption_on
     AND NEW.first_day_worked>coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on)) THEN
   RAISE EXCEPTION 'Return-to-service evidence needs the exact earlier confirmed event, native employment and employer, and a later first day worked'
     USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
   WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id
     AND v.content_hash=NEW.source_sha256 AND v.created_by=NEW.updated_by) THEN
   RAISE EXCEPTION 'Return-to-service evidence needs the importing operator retained source file version and content hash' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_subsequent_service_source_guard BEFORE INSERT OR UPDATE OR DELETE
 ON public.payroll_roe_subsequent_service_sources FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_subsequent_service_source_guard();

-- One resolver supplies both reporting admission and the issued source snapshot.
CREATE FUNCTION public.payroll_roe_later_stub_source(tenant uuid, event uuid, stub_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 WITH subject AS (
   SELECT e.*,coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on) AS cutoff
   FROM public.payroll_roe_separation_events e WHERE e.org_id=tenant AND e.id=event
 ), starts AS (
   SELECT c.first_day_worked AS first_day,NULL::date AS last_day,
     jsonb_build_object('returnCertificate',to_jsonb(c)) AS proof
   FROM public.payroll_roe_subsequent_service_sources c JOIN subject e ON c.org_id=e.org_id AND c.preceding_event_id=e.id
     AND c.employee_party_id=e.employee_party_id AND c.employment_id=e.employment_id AND c.subsidiary_id=e.subsidiary_id
   WHERE c.first_day_worked>e.cutoff AND c.first_day_worked>e.interruption_on
   UNION ALL
   SELECT later.first_day_worked,coalesce(later.salary_continuance_end_on,later.last_insurable_earnings_on),
     jsonb_build_object('laterEvent',to_jsonb(later))
   FROM public.payroll_roe_separation_events later JOIN subject e ON later.org_id=e.org_id
     AND later.employee_party_id=e.employee_party_id AND later.employment_id=e.employment_id
     AND later.subsidiary_id=e.subsidiary_id AND later.id<>e.id
   WHERE later.status IN ('confirmed','issued') AND later.first_day_worked>e.cutoff
     AND length(btrim(later.source_reference))>0
 ), material AS (
   SELECT l.id,public.payroll_roe_reporting_line_snapshot(l.id,l.org_id) AS retained,
     to_jsonb(a) AS attribution,l.amount,l.hours,
     (a.id IS NULL OR a.line_snapshot=public.payroll_roe_reporting_line_snapshot(l.id,l.org_id)) AS snapshot_matches,coalesce(a.earned_from,l.earned_from) AS earned_from,
     coalesce(a.earned_to,l.earned_to) AS earned_to
   FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
   JOIN public.documents d ON d.org_id=s.org_id AND d.id=s.pay_run_document_id
   JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
   JOIN subject e ON e.org_id=s.org_id AND e.employee_party_id=s.employee_party_id
     AND e.employment_id=s.employment_id AND e.subsidiary_id=d.subsidiary_id
   LEFT JOIN public.payroll_roe_line_evidence a ON a.org_id=l.org_id AND a.pay_stub_line_id=l.id
   WHERE s.org_id=tenant AND s.id=stub_id AND s.currency_code='CAD' AND r.run_status='committed'
     AND l.kind='earning' AND (l.amount<>0 OR l.hours<>0)
 )
 SELECT starts.proof||jsonb_build_object('stubId',stub_id,'stub',
   (SELECT to_jsonb(s) FROM public.pay_stubs s WHERE s.org_id=tenant AND s.id=stub_id),'lines',
   (SELECT jsonb_agg(jsonb_build_object('retained',m.retained,'attribution',m.attribution) ORDER BY m.id) FROM material m))
 FROM starts WHERE EXISTS(SELECT 1 FROM material) AND NOT EXISTS(
   SELECT 1 FROM material m WHERE NOT m.snapshot_matches OR m.amount IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
     OR m.hours IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR m.amount<0 OR m.hours<0 OR m.earned_from IS NULL OR m.earned_to IS NULL
     OR m.earned_from>m.earned_to OR m.earned_from<starts.first_day
     OR starts.last_day IS NOT NULL AND m.earned_to>starts.last_day)
 ORDER BY starts.first_day,starts.proof::text LIMIT 1
$$;

ALTER TABLE public.payroll_roe_issued_event_sources ADD COLUMN excluded_stub_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.payroll_roe_issued_event_sources ADD CONSTRAINT payroll_roe_issued_event_sources_excluded_ids
 CHECK(array_position(excluded_stub_ids,NULL) IS NULL AND cardinality(excluded_stub_ids)<=5000);

CREATE FUNCTION public.payroll_roe_issued_source_snapshot_with_returns(tenant uuid,event uuid,period_ids uuid[],line_ids uuid[],excluded_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE body jsonb; excluded jsonb; line_count bigint;
BEGIN
 IF cardinality(excluded_ids)>5000 THEN RAISE EXCEPTION 'ROE service evidence exceeds the bounded retained-stub window' USING ERRCODE='23514'; END IF;
 body:=public.payroll_roe_issued_source_snapshot(tenant,event,period_ids,line_ids);
 SELECT count(*) INTO line_count FROM (
   SELECT l.id FROM public.pay_stub_lines l WHERE l.org_id=tenant AND l.stub_id=ANY(excluded_ids)
     AND l.kind='earning' AND (l.amount<>0 OR l.hours<>0) LIMIT 50001
 ) bounded;
 IF line_count>50000 THEN RAISE EXCEPTION 'ROE service evidence exceeds the bounded retained-line window' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(q.proof ORDER BY q.stub_id) INTO excluded FROM (
   SELECT s.id AS stub_id,public.payroll_roe_later_stub_source(tenant,event,s.id) AS proof
   FROM public.pay_stubs s WHERE s.org_id=tenant AND s.id=ANY(excluded_ids)
 ) q WHERE q.proof IS NOT NULL;
 IF jsonb_array_length(coalesce(excluded,'[]'::jsonb))<>cardinality(excluded_ids) THEN
   RAISE EXCEPTION 'Issued ROE exclusions need every exact source-qualified later stub identity' USING ERRCODE='23514';
 END IF;
 IF excluded IS NOT NULL THEN body:=body||jsonb_build_object('excludedLaterService',excluded); END IF;
 RETURN body;
END;
$$;

CREATE OR REPLACE FUNCTION public.payroll_roe_issued_event_source_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE snapshot jsonb;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Issued ROE event source bindings and snapshots are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id::text||':'||NEW.employee_party_id::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.payroll_roe_separation_events e
   JOIN public.payroll_filing_submission_slips sl ON sl.id=NEW.issued_slip_id AND sl.org_id=e.org_id
   JOIN public.payroll_filing_submissions f ON f.org_id=sl.org_id AND f.id=sl.submission_id
   WHERE e.org_id=NEW.org_id AND e.id=NEW.event_id AND e.employee_party_id=NEW.employee_party_id
     AND e.status='confirmed' AND e.first_day_worked IS NOT NULL AND e.employment_id IS NOT NULL AND e.subsidiary_id IS NOT NULL
     AND sl.row_id=e.employee_party_id::text||'~'||e.id::text AND f.country='CA' AND f.filing_key='roe') THEN
   RAISE EXCEPTION 'Issued ROE binding requires the exact confirmed employee event and native issued slip' USING ERRCODE='23514';
 END IF;
 IF cardinality(NEW.historical_period_ids)<>(SELECT count(DISTINCT p) FROM unnest(NEW.historical_period_ids) p)
   OR cardinality(NEW.line_evidence_ids)<>(SELECT count(DISTINCT l) FROM unnest(NEW.line_evidence_ids) l)
   OR cardinality(NEW.excluded_stub_ids)<>(SELECT count(DISTINCT s) FROM unnest(NEW.excluded_stub_ids) s) THEN
   RAISE EXCEPTION 'Issued ROE source identities must be unique' USING ERRCODE='23514';
 END IF;
 snapshot:=public.payroll_roe_issued_source_snapshot_with_returns(NEW.org_id,NEW.event_id,NEW.historical_period_ids,NEW.line_evidence_ids,NEW.excluded_stub_ids);
 IF snapshot IS NULL OR snapshot IS DISTINCT FROM NEW.source_snapshot
   OR jsonb_array_length(snapshot->'historicalPeriods')<>cardinality(NEW.historical_period_ids)
   OR jsonb_array_length(snapshot->'lineEvidence')<>cardinality(NEW.line_evidence_ids)
   OR encode(public.digest(snapshot::text,'sha256'),'hex')<>NEW.source_sha256 THEN
   RAISE EXCEPTION 'Issued ROE binding must retain the exact selected event and used reporting evidence snapshot' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;

-- A source used to exclude later service is also part of the statutory artifact.
CREATE FUNCTION public.payroll_roe_used_exclusion_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE tenant uuid; employee uuid; identity uuid;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 tenant:=CASE WHEN TG_OP='INSERT' THEN NEW.org_id ELSE OLD.org_id END;
 employee:=CASE WHEN TG_OP='INSERT' THEN NEW.employee_party_id ELSE OLD.employee_party_id END;
 identity:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
 IF TG_TABLE_NAME='payroll_roe_separation_events' AND TG_OP='UPDATE'
   AND NEW.status='issued' AND OLD.status='confirmed'
   AND (to_jsonb(NEW)-ARRAY['status','updated_at','updated_by'])=(to_jsonb(OLD)-ARRAY['status','updated_at','updated_by']) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||tenant::text||':'||employee::text,0));
 IF EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b,
   LATERAL jsonb_array_elements(coalesce(b.source_snapshot->'excludedLaterService','[]'::jsonb)) proof
   WHERE b.org_id=tenant AND b.employee_party_id=employee AND (
     TG_TABLE_NAME='payroll_roe_separation_events' AND proof->'laterEvent'->>'id'=identity::text
     OR TG_TABLE_NAME='payroll_roe_line_evidence' AND EXISTS(
       SELECT 1 FROM jsonb_array_elements(proof->'lines') line WHERE line->'attribution'->>'id'=identity::text
         OR TG_OP='INSERT' AND line->'retained'->>'lineId'=to_jsonb(NEW)->>'pay_stub_line_id'))) THEN
   RAISE EXCEPTION 'Issued ROE used exclusion evidence cannot be changed; retain the original and use the statutory correction workflow'
     USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_used_event_exclusion_guard BEFORE UPDATE OR DELETE ON public.payroll_roe_separation_events
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_used_exclusion_guard();
CREATE TRIGGER payroll_roe_used_line_exclusion_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_line_evidence
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_used_exclusion_guard();
