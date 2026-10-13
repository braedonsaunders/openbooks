-- Immutable event-specific source ownership for issued Canadian Records of Employment.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.payroll_roe_issued_event_sources (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL,
 event_id uuid NOT NULL, employee_party_id uuid NOT NULL, issued_slip_id uuid NOT NULL,
 historical_period_ids uuid[] NOT NULL DEFAULT '{}', line_evidence_ids uuid[] NOT NULL DEFAULT '{}',
 source_snapshot jsonb NOT NULL, source_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 CONSTRAINT payroll_roe_issued_event_sources_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT payroll_roe_issued_event_sources_event_unique UNIQUE(org_id,event_id),
 CONSTRAINT payroll_roe_issued_event_sources_slip_unique UNIQUE(org_id,issued_slip_id),
 CONSTRAINT payroll_roe_issued_event_sources_event_fkey FOREIGN KEY(org_id,event_id) REFERENCES public.payroll_roe_separation_events(org_id,id),
 CONSTRAINT payroll_roe_issued_event_sources_employee_fkey FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
 CONSTRAINT payroll_roe_issued_event_sources_slip_fkey FOREIGN KEY(issued_slip_id) REFERENCES public.payroll_filing_submission_slips(id),
 CONSTRAINT payroll_roe_issued_event_sources_digest CHECK(source_sha256~'^[a-f0-9]{64}$'),
 CONSTRAINT payroll_roe_issued_event_sources_snapshot CHECK(jsonb_typeof(source_snapshot)='object'),
 CONSTRAINT payroll_roe_issued_event_sources_period_ids CHECK(array_position(historical_period_ids,NULL) IS NULL),
 CONSTRAINT payroll_roe_issued_event_sources_line_ids CHECK(array_position(line_evidence_ids,NULL) IS NULL)
);
CREATE INDEX payroll_roe_issued_event_sources_employee ON public.payroll_roe_issued_event_sources(org_id,employee_party_id);
ALTER TABLE public.payroll_roe_issued_event_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_issued_event_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_roe_issued_event_sources
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_roe_issued_event_sources IS 'openbooks:org_isolation:v1';

CREATE FUNCTION public.payroll_roe_has_unbound_issued_source(tenant uuid,employee uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_filing_submission_slips sl
 JOIN public.payroll_filing_submissions f ON f.org_id=sl.org_id AND f.id=sl.submission_id
 WHERE sl.org_id=tenant AND f.country='CA' AND f.filing_key='roe'
   AND (sl.row_id=employee::text OR split_part(sl.row_id,'~',1)=employee::text)
   AND NOT EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b WHERE b.org_id=sl.org_id AND b.issued_slip_id=sl.id))
$$;

CREATE FUNCTION public.payroll_roe_issued_source_snapshot(tenant uuid,event uuid,period_ids uuid[],line_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('event',to_jsonb(e),
  'historicalPeriods',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payroll_roe_historical_periods p
    WHERE p.org_id=tenant AND p.employee_party_id=e.employee_party_id AND p.employment_id=e.employment_id
      AND p.subsidiary_id=e.subsidiary_id AND p.id=ANY(period_ids)),'[]'::jsonb),
  'lineEvidence',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.payroll_roe_line_evidence l
    WHERE l.org_id=tenant AND l.employee_party_id=e.employee_party_id AND l.employment_id=e.employment_id
      AND l.subsidiary_id=e.subsidiary_id AND l.id=ANY(line_ids)),'[]'::jsonb))
 FROM public.payroll_roe_separation_events e WHERE e.org_id=tenant AND e.id=event
$$;

CREATE FUNCTION public.payroll_roe_issued_event_source_guard() RETURNS trigger
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
   OR cardinality(NEW.line_evidence_ids)<>(SELECT count(DISTINCT l) FROM unnest(NEW.line_evidence_ids) l) THEN
   RAISE EXCEPTION 'Issued ROE source identities must be unique' USING ERRCODE='23514';
 END IF;
 snapshot:=public.payroll_roe_issued_source_snapshot(NEW.org_id,NEW.event_id,NEW.historical_period_ids,NEW.line_evidence_ids);
 IF snapshot IS NULL OR snapshot IS DISTINCT FROM NEW.source_snapshot
   OR jsonb_array_length(snapshot->'historicalPeriods')<>cardinality(NEW.historical_period_ids)
   OR jsonb_array_length(snapshot->'lineEvidence')<>cardinality(NEW.line_evidence_ids)
   OR encode(public.digest(snapshot::text,'sha256'),'hex')<>NEW.source_sha256 THEN
   RAISE EXCEPTION 'Issued ROE binding must retain the exact selected event and used reporting evidence snapshot' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_issued_event_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_issued_event_sources
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_issued_event_source_guard();

CREATE OR REPLACE FUNCTION public.payroll_roe_separation_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE recorded boolean;
BEGIN
  IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b
      WHERE b.org_id=OLD.org_id AND b.event_id=OLD.id)
      OR public.payroll_roe_has_unbound_issued_source(OLD.org_id,OLD.employee_party_id) INTO recorded;
    IF OLD.status='issued' OR recorded THEN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Issued Record of Employment separation facts must be retained; use the Service Canada correction workflow'
          USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_issued';
      END IF;
      IF ROW(NEW.org_id,NEW.employee_party_id,NEW.employment_id,NEW.subsidiary_id,NEW.first_day_worked,
          NEW.interruption_on,NEW.last_insurable_earnings_on,NEW.salary_continuance_end_on,NEW.source_reference,NEW.change_reason)
        IS DISTINCT FROM ROW(OLD.org_id,OLD.employee_party_id,OLD.employment_id,OLD.subsidiary_id,OLD.first_day_worked,
          OLD.interruption_on,OLD.last_insurable_earnings_on,OLD.salary_continuance_end_on,OLD.source_reference,OLD.change_reason)
        OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'issued') THEN
        RAISE EXCEPTION 'Issued Record of Employment separation facts are immutable; use the Service Canada correction workflow'
          USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_issued';
      END IF;
    END IF;
  END IF;
  IF TG_OP='INSERT' AND public.payroll_roe_has_unbound_issued_source(NEW.org_id,NEW.employee_party_id) THEN
    RAISE EXCEPTION 'A legacy issued ROE has no qualified event source binding; preserve its artifact and resolve the original event evidence'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||NEW.org_id::text||':'||NEW.employee_party_id::text,0));
  IF NEW.status='issued' AND NOT EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b WHERE b.org_id=NEW.org_id AND b.event_id=NEW.id)
    AND NOT(TG_OP='UPDATE' AND OLD.status='issued') THEN
    RAISE EXCEPTION 'Record the exact native issued event source binding before marking ROE facts issued' USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('confirmed','issued') AND NEW.first_day_worked IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.payroll_roe_separation_events e WHERE e.org_id=NEW.org_id
      AND e.employee_party_id=NEW.employee_party_id AND e.employment_id=NEW.employment_id
      AND e.id<>NEW.id AND e.status IN ('confirmed','issued')
      AND e.first_day_worked<=coalesce(NEW.salary_continuance_end_on,NEW.last_insurable_earnings_on)
      AND coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on)>=NEW.first_day_worked) THEN
    RAISE EXCEPTION 'Employment-spell dates overlap another confirmed separation event; reconcile the original spell evidence' USING ERRCODE='23514';
  END IF;

  IF NEW.employment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.worker_employments e
    WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
      AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id
  ) THEN
    RAISE EXCEPTION 'Record of Employment facts must identify the selected employee, native employment and legal employer'
      USING ERRCODE='23514',CONSTRAINT='payroll_roe_separation_facts_identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.payroll_roe_reporting_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE snapshot jsonb; employee uuid; tenant uuid;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 employee:=CASE WHEN TG_OP='DELETE' THEN OLD.employee_party_id ELSE NEW.employee_party_id END;
 tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||tenant::text||':'||employee::text,0));
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.employee_party_id,NEW.employment_id,NEW.subsidiary_id)
   IS DISTINCT FROM (OLD.org_id,OLD.employee_party_id,OLD.employment_id,OLD.subsidiary_id) THEN
   RAISE EXCEPTION 'ROE reporting evidence cannot change its employee, employment or legal employer' USING ERRCODE='23514';
 END IF;
 IF public.payroll_roe_has_unbound_issued_source(tenant,employee) OR
   (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b
     WHERE b.org_id=tenant AND ((TG_TABLE_NAME='payroll_roe_historical_periods' AND OLD.id=ANY(b.historical_period_ids))
       OR (TG_TABLE_NAME='payroll_roe_line_evidence' AND OLD.id=ANY(b.line_evidence_ids))))) THEN
   RAISE EXCEPTION 'Issued ROE reporting evidence must be retained; its used source cannot be changed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.worker_employments e WHERE e.org_id=NEW.org_id AND e.id=NEW.employment_id
   AND e.worker_party_id=NEW.employee_party_id AND e.employer_subsidiary_id=NEW.subsidiary_id) THEN
   RAISE EXCEPTION 'ROE reporting evidence must identify the native employee, employment and employer' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.files f JOIN public.file_versions v ON v.file_id=f.id
   WHERE f.org_id=NEW.org_id AND f.id=NEW.source_file_id AND v.id=NEW.source_version_id AND v.content_hash=NEW.source_sha256) THEN
   RAISE EXCEPTION 'ROE reporting evidence needs the exact retained native file version and content hash' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='payroll_roe_historical_periods' THEN
   IF NOT EXISTS(SELECT 1 FROM public.pay_schedules s WHERE s.org_id=NEW.org_id AND s.id=NEW.pay_schedule_id AND s.frequency=NEW.frequency AND (s.subsidiary_id IS NULL OR s.subsidiary_id=NEW.subsidiary_id))
     OR (NEW.frequency='weekly' AND NEW.period_end-NEW.period_start<>6)
     OR (NEW.frequency='biweekly' AND NEW.period_end-NEW.period_start<>13) THEN
     RAISE EXCEPTION 'Historical ROE periods need their native schedule and complete reporting interval' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM public.payroll_filing_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.filing_account_id
     AND a.subsidiary_id=NEW.subsidiary_id AND a.country='CA' AND a.program_type='ca_rp') THEN
     RAISE EXCEPTION 'The historical ROE period needs its native Canadian payroll filing account' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM public.payroll_roe_historical_periods p WHERE p.org_id=NEW.org_id AND p.employment_id=NEW.employment_id
     AND p.id<>NEW.id AND p.period_start<=NEW.period_end AND p.period_end>=NEW.period_start) THEN
     RAISE EXCEPTION 'Historical ROE reporting periods cannot overlap' USING ERRCODE='23514';
   END IF;
   IF EXISTS(SELECT 1 FROM public.pay_runs r JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
     WHERE r.org_id=NEW.org_id AND d.subsidiary_id=NEW.subsidiary_id AND r.pay_schedule_id=NEW.pay_schedule_id
       AND r.run_status='committed' AND r.period_start<=NEW.period_end AND r.period_end>=NEW.period_start
       AND (r.run_type='regular' OR EXISTS(SELECT 1 FROM public.pay_stubs s WHERE s.org_id=r.org_id
         AND s.pay_run_document_id=r.document_id AND s.employee_party_id=NEW.employee_party_id))) THEN
     RAISE EXCEPTION 'Historical ROE evidence cannot replace or duplicate retained committed payroll periods' USING ERRCODE='23514';
   END IF;
 ELSE
   IF TG_OP='UPDATE' AND NEW.pay_stub_line_id IS DISTINCT FROM OLD.pay_stub_line_id THEN
     RAISE EXCEPTION 'ROE reporting evidence cannot be moved to a different committed earning line' USING ERRCODE='23514';
   END IF;
   snapshot:=public.payroll_roe_reporting_line_snapshot(NEW.pay_stub_line_id,NEW.org_id);
   IF snapshot IS NULL OR snapshot IS DISTINCT FROM NEW.line_snapshot
     OR snapshot->>'employmentId' IS DISTINCT FROM NEW.employment_id::text
     OR snapshot->>'subsidiaryId' IS DISTINCT FROM NEW.subsidiary_id::text
     OR snapshot->>'currency'<>'CAD'
     OR NOT EXISTS(SELECT 1 FROM public.pay_stubs s JOIN public.pay_stub_lines l ON l.org_id=s.org_id AND l.stub_id=s.id
       WHERE l.org_id=NEW.org_id AND l.id=NEW.pay_stub_line_id AND s.employee_party_id=NEW.employee_party_id) THEN
     RAISE EXCEPTION 'ROE line evidence must match the exact committed Canadian payroll source' USING ERRCODE='23514';
   END IF;
   IF (snapshot->>'earnedFrom' IS NOT NULL AND NEW.earned_from<(snapshot->>'earnedFrom')::date)
     OR (snapshot->>'earnedTo' IS NOT NULL AND NEW.earned_to>(snapshot->>'earnedTo')::date) THEN
     RAISE EXCEPTION 'Qualified earned evidence cannot expand the retained payroll span; correct its native source first' USING ERRCODE='23514';
   END IF;
   IF NEW.is_insurable AND snapshot->>'hours' IS NOT NULL AND (snapshot->>'hours')::numeric<>NEW.insurable_hours THEN
     RAISE EXCEPTION 'Qualified insurable hours must preserve the retained paid-hour source' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;

