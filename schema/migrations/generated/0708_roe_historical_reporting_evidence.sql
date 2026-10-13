-- Source-qualified prior reporting periods and retained payroll-line attribution for Canadian ROEs.
SET statement_timeout = 0;
SET search_path = public, pg_catalog;

CREATE TABLE public.payroll_roe_historical_periods (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL, employment_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
  filing_account_id uuid NOT NULL, pay_schedule_id uuid NOT NULL, frequency text NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL, pay_date date,
  earned_from date, earned_to date, currency text NOT NULL DEFAULT 'CAD',
  insurable_earnings numeric(19,4) NOT NULL, insurable_hours numeric(19,4) NOT NULL,
  nil_period boolean NOT NULL, source_file_id uuid NOT NULL, source_version_id uuid NOT NULL,
  source_sha256 text NOT NULL, source_reference text NOT NULL,
  insurance_reference text NOT NULL, hours_reference text NOT NULL, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT payroll_roe_historical_periods_org_id_unique UNIQUE(org_id,id),
  CONSTRAINT payroll_roe_historical_periods_employee_fkey FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
  CONSTRAINT payroll_roe_historical_periods_employment_fkey FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
  CONSTRAINT payroll_roe_historical_periods_employer_fkey FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
  CONSTRAINT payroll_roe_historical_periods_filing_fkey FOREIGN KEY(filing_account_id) REFERENCES public.payroll_filing_accounts(id),
  CONSTRAINT payroll_roe_historical_periods_schedule_fkey FOREIGN KEY(pay_schedule_id) REFERENCES public.pay_schedules(id),
  CONSTRAINT payroll_roe_historical_periods_source_fkey FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
  CONSTRAINT payroll_roe_historical_periods_unique UNIQUE(org_id,employment_id,period_start,period_end),
  CONSTRAINT payroll_roe_historical_periods_currency CHECK(currency='CAD'),
  CONSTRAINT payroll_roe_historical_periods_frequency CHECK(frequency IN ('weekly','biweekly','semi_monthly','monthly')),
  CONSTRAINT payroll_roe_historical_periods_dates CHECK(period_start<=period_end AND
    ((nil_period AND pay_date IS NULL AND earned_from IS NULL AND earned_to IS NULL AND insurable_earnings=0 AND insurable_hours=0)
      OR (NOT nil_period AND pay_date IS NOT NULL AND earned_from IS NOT NULL AND earned_to IS NOT NULL AND earned_from<=earned_to))),
  CONSTRAINT payroll_roe_historical_periods_amounts CHECK(insurable_earnings>=0 AND insurable_earnings<>'NaN'::numeric AND insurable_hours>=0 AND insurable_hours<>'NaN'::numeric),
  CONSTRAINT payroll_roe_historical_periods_source CHECK(source_sha256~'^[a-f0-9]{64}$' AND
    length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(insurance_reference)) BETWEEN 1 AND 2000
    AND length(btrim(hours_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000)
);
CREATE INDEX payroll_roe_historical_periods_employee_date ON public.payroll_roe_historical_periods(org_id,employee_party_id,period_end);

CREATE TABLE public.payroll_roe_line_evidence (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL, employment_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
  pay_stub_line_id uuid NOT NULL, line_snapshot jsonb NOT NULL,
  report_period_start date NOT NULL, report_period_end date NOT NULL,
  earned_from date NOT NULL, earned_to date NOT NULL,
  is_insurable boolean NOT NULL, insurable_hours numeric(19,4) NOT NULL,
  source_file_id uuid NOT NULL, source_version_id uuid NOT NULL, source_sha256 text NOT NULL,
  source_reference text NOT NULL, insurance_reference text NOT NULL, hours_reference text NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT payroll_roe_line_evidence_org_id_unique UNIQUE(org_id,id),
  CONSTRAINT payroll_roe_line_evidence_employee_fkey FOREIGN KEY(org_id,employee_party_id) REFERENCES public.parties(org_id,id),
  CONSTRAINT payroll_roe_line_evidence_employment_fkey FOREIGN KEY(org_id,employment_id) REFERENCES public.worker_employments(org_id,id),
  CONSTRAINT payroll_roe_line_evidence_employer_fkey FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
  CONSTRAINT payroll_roe_line_evidence_line_fkey FOREIGN KEY(pay_stub_line_id) REFERENCES public.pay_stub_lines(id),
  CONSTRAINT payroll_roe_line_evidence_source_fkey FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
  CONSTRAINT payroll_roe_line_evidence_unique UNIQUE(org_id,pay_stub_line_id),
  CONSTRAINT payroll_roe_line_evidence_dates CHECK(report_period_start<=report_period_end AND earned_from<=earned_to),
  CONSTRAINT payroll_roe_line_evidence_hours CHECK(insurable_hours>=0 AND insurable_hours<>'NaN'::numeric AND (is_insurable OR insurable_hours=0)),
  CONSTRAINT payroll_roe_line_evidence_snapshot CHECK(jsonb_typeof(line_snapshot)='object'),
  CONSTRAINT payroll_roe_line_evidence_source CHECK(source_sha256~'^[a-f0-9]{64}$' AND
    length(btrim(source_reference)) BETWEEN 1 AND 2000 AND length(btrim(insurance_reference)) BETWEEN 1 AND 2000
    AND length(btrim(hours_reference)) BETWEEN 1 AND 2000 AND length(btrim(change_reason)) BETWEEN 1 AND 2000)
);

CREATE INDEX payroll_roe_line_evidence_employee_date ON public.payroll_roe_line_evidence(org_id,employee_party_id,report_period_end);

CREATE FUNCTION public.payroll_roe_reporting_line_snapshot(line_id uuid, tenant_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('lineId',l.id,'stubId',s.id,'componentId',l.component_id,
   'amount',l.amount::text,'hours',l.hours::text,'earnedFrom',l.earned_from::text,'earnedTo',l.earned_to::text,
   'payDate',s.pay_date::text,'employmentId',s.employment_id,'subsidiaryId',d.subsidiary_id,
   'currency',s.currency_code,'periodStart',r.period_start::text,'periodEnd',r.period_end::text)
 FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
 JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
 JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
 WHERE l.org_id=tenant_id AND l.id=line_id AND l.kind='earning' AND r.run_status='committed'
$$;

CREATE FUNCTION public.payroll_roe_reporting_evidence_guard() RETURNS trigger
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
 IF EXISTS(SELECT 1 FROM public.payroll_filing_submission_slips sl
   JOIN public.payroll_filing_submissions f ON f.org_id=sl.org_id AND f.id=sl.submission_id
   WHERE sl.org_id=tenant AND sl.row_id=employee::text AND f.country='CA' AND f.filing_key='roe') THEN
   RAISE EXCEPTION 'An issued ROE retains this employee reporting evidence; its source cannot be changed' USING ERRCODE='23514';
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

CREATE TRIGGER payroll_roe_historical_periods_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_historical_periods
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_reporting_evidence_guard();
CREATE TRIGGER payroll_roe_line_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_line_evidence
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_reporting_evidence_guard();

ALTER TABLE public.payroll_roe_historical_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_historical_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_roe_historical_periods
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_roe_historical_periods IS 'openbooks:org_isolation:v1';
ALTER TABLE public.payroll_roe_line_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_line_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_roe_line_evidence
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.payroll_roe_line_evidence IS 'openbooks:org_isolation:v1';
