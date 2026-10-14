-- Bind insurable separation payments to their statutory final reporting period without changing service or payment facts.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.payroll_roe_separation_payments
 ADD COLUMN source_line_id uuid,
 ADD COLUMN generated_from_line boolean NOT NULL DEFAULT false,
 ADD COLUMN reporting_block text,
 ADD COLUMN reporting_category_code text,
 ADD CONSTRAINT payroll_roe_separation_payments_source_line_fkey FOREIGN KEY(org_id,source_line_id) REFERENCES public.pay_stub_lines(org_id,id),
 ADD CONSTRAINT payroll_roe_separation_payments_reporting_category CHECK(
   (reporting_block IS NULL AND reporting_category_code IS NULL AND source_line_id IS NULL AND NOT generated_from_line)
   OR (source_line_id IS NOT NULL AND reporting_block IS NOT NULL AND reporting_category_code IS NOT NULL AND payment_status='paid' AND
     ((reporting_block='17A' AND reporting_category_code='2') OR (reporting_block='17C' AND reporting_category_code~'^[A-Z][0-9]{2}$')))),
 ADD CONSTRAINT payroll_roe_separation_payments_org_id_unique UNIQUE(org_id,id);
CREATE UNIQUE INDEX payroll_roe_separation_payments_source_line_unique
 ON public.payroll_roe_separation_payments(org_id,source_line_id) WHERE source_line_id IS NOT NULL;
ALTER TABLE public.payroll_roe_line_evidence
 ADD COLUMN reporting_basis text NOT NULL DEFAULT 'service',
 ADD COLUMN separation_event_id uuid,
 ADD COLUMN separation_payment_id uuid,
 ADD COLUMN separation_basis_snapshot jsonb,
 ALTER COLUMN earned_from DROP NOT NULL,
 ALTER COLUMN earned_to DROP NOT NULL,
 ADD CONSTRAINT payroll_roe_line_evidence_separation_event_fkey FOREIGN KEY(org_id,separation_event_id)
   REFERENCES public.payroll_roe_separation_events(org_id,id),
 ADD CONSTRAINT payroll_roe_line_evidence_separation_payment_fkey FOREIGN KEY(org_id,separation_payment_id)
   REFERENCES public.payroll_roe_separation_payments(org_id,id),
 ADD CONSTRAINT payroll_roe_line_evidence_reporting_basis CHECK(
   (reporting_basis='service' AND separation_event_id IS NULL AND separation_payment_id IS NULL
     AND separation_basis_snapshot IS NULL AND earned_from IS NOT NULL AND earned_to IS NOT NULL)
   OR (reporting_basis='separation_payment' AND separation_event_id IS NOT NULL AND separation_payment_id IS NOT NULL
     AND separation_basis_snapshot IS NOT NULL AND jsonb_typeof(separation_basis_snapshot)='object' AND is_insurable AND insurable_hours=0));
CREATE UNIQUE INDEX payroll_roe_line_evidence_separation_payment_unique
 ON public.payroll_roe_line_evidence(org_id,separation_payment_id) WHERE separation_payment_id IS NOT NULL;

CREATE FUNCTION public.payroll_roe_separation_reporting_basis(tenant uuid,event uuid,line_id uuid,payment_id uuid,report_start date,report_end date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT jsonb_build_object('event',to_jsonb(e)-ARRAY['status','updated_at','updated_by'],'payment',to_jsonb(p),'classification',jsonb_build_object('block',p.reporting_block,'categoryCode',p.reporting_category_code),
   'retainedLine',public.payroll_roe_reporting_line_snapshot(l.id,l.org_id),'reportPeriodStart',$5,'reportPeriodEnd',$6)
 FROM public.payroll_roe_separation_events e
 JOIN public.payroll_roe_separation_payments p ON p.org_id=e.org_id AND p.separation_event_id=e.id AND p.id=$4
 JOIN public.pay_stub_lines l ON l.org_id=e.org_id AND l.id=$3 AND l.component_id=p.pay_component_id AND p.source_line_id=l.id
 JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id AND s.employee_party_id=e.employee_party_id AND s.employment_id=e.employment_id
 JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id AND r.run_status='committed'
 JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id AND d.subsidiary_id=e.subsidiary_id AND d.status<>'voided'

 WHERE e.org_id=$1 AND e.id=$2 AND e.status IN ('confirmed','issued') AND e.first_day_worked IS NOT NULL
   AND l.kind='earning' AND l.amount>0 AND l.amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND (l.hours IS NULL OR l.hours=0) AND s.currency_code='CAD'
   AND p.payment_status='paid' AND p.amount=l.amount AND p.expected_payment_on=s.pay_date
   AND ((p.reporting_block='17A' AND p.reporting_category_code='2') OR (p.reporting_block='17C' AND p.reporting_category_code IS NOT NULL))
   AND $5<=coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on)
   AND $6>=coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on)
   AND EXISTS(
     SELECT 1 FROM public.pay_runs calendar JOIN public.documents cd ON cd.org_id=calendar.org_id AND cd.id=calendar.document_id
       WHERE calendar.org_id=e.org_id AND cd.subsidiary_id=e.subsidiary_id AND cd.status<>'voided' AND calendar.pay_schedule_id=r.pay_schedule_id
         AND calendar.run_status='committed' AND calendar.run_type IN ('regular','termination') AND calendar.period_start=$5 AND calendar.period_end=$6
     UNION ALL
     SELECT 1 FROM public.payroll_roe_historical_periods h WHERE h.org_id=e.org_id AND h.employee_party_id=e.employee_party_id
       AND h.employment_id=e.employment_id AND h.subsidiary_id=e.subsidiary_id AND h.pay_schedule_id=r.pay_schedule_id
       AND h.filing_account_id=s.filing_account_id AND h.period_start=$5 AND h.period_end=$6)
$$;

CREATE FUNCTION public.payroll_roe_separation_basis_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE proof jsonb; retained jsonb;
BEGIN
 IF NEW.reporting_basis='service' THEN RETURN NEW; END IF;
 -- Lock every mutable referenced declaration before taking its protected proof.
 PERFORM 1 FROM public.payroll_roe_separation_events WHERE org_id=NEW.org_id AND id=NEW.separation_event_id FOR SHARE;
 PERFORM 1 FROM public.payroll_roe_separation_payments WHERE org_id=NEW.org_id AND id=NEW.separation_payment_id FOR SHARE;

 proof:=public.payroll_roe_separation_reporting_basis(NEW.org_id,NEW.separation_event_id,NEW.pay_stub_line_id,NEW.separation_payment_id,NEW.report_period_start,NEW.report_period_end);
 retained:=public.payroll_roe_reporting_line_snapshot(NEW.pay_stub_line_id,NEW.org_id);
 IF proof IS NULL OR proof IS DISTINCT FROM NEW.separation_basis_snapshot OR retained IS DISTINCT FROM NEW.line_snapshot
   OR proof->'event'->>'employee_party_id' IS DISTINCT FROM NEW.employee_party_id::text
   OR proof->'event'->>'employment_id' IS DISTINCT FROM NEW.employment_id::text
   OR proof->'event'->>'subsidiary_id' IS DISTINCT FROM NEW.subsidiary_id::text
   OR NEW.earned_from IS DISTINCT FROM (retained->>'earnedFrom')::date
   OR NEW.earned_to IS DISTINCT FROM (retained->>'earnedTo')::date THEN
   RAISE EXCEPTION 'Separation reporting needs the exact paid line, selected event, effective category and final period; retain its true earned and payment dates' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_line_evidence_separation_basis_guard BEFORE INSERT OR UPDATE ON public.payroll_roe_line_evidence
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_separation_basis_guard();

CREATE FUNCTION public.payroll_roe_separation_basis_reference_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE subject jsonb; event_id uuid; tenant uuid;
BEGIN
 subject:=CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
 tenant:=(subject->>'org_id')::uuid;event_id:=(subject->>'separation_event_id')::uuid;
 IF TG_OP='UPDATE' AND (NEW.org_id,NEW.id,NEW.separation_event_id) IS DISTINCT FROM (OLD.org_id,OLD.id,OLD.separation_event_id) THEN
   RAISE EXCEPTION 'A separation payment declaration retains its organization, identity and selected event' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,subject)
   OR public.openbooks_sandbox_wipe_allowed(tenant)) THEN RETURN OLD; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-run-ytd:'||tenant::text||':'||
   (SELECT employee_party_id::text FROM public.payroll_roe_separation_events WHERE org_id=tenant AND id=event_id),0));
 IF EXISTS(SELECT 1 FROM public.payroll_roe_separation_events e WHERE e.org_id=tenant AND e.id=event_id AND e.status='issued')
   OR EXISTS(SELECT 1 FROM public.payroll_roe_issued_event_sources b WHERE b.org_id=tenant AND b.event_id=event_id) THEN
   RAISE EXCEPTION 'Issued ROE separation payment declarations are immutable; retain the original statutory source' USING ERRCODE='23514';
 END IF;
 IF TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM public.payroll_roe_line_evidence evidence
   WHERE evidence.org_id=tenant AND evidence.reporting_basis='separation_payment' AND evidence.separation_payment_id=OLD.id) THEN
   RAISE EXCEPTION 'Qualified ROE separation reporting retains this payment; withdraw unissued attribution before correcting its declaration' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.source_line_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
   JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id AND r.run_status='committed'
   JOIN public.documents d ON d.org_id=r.org_id AND d.id=r.document_id
   JOIN public.payroll_roe_separation_events e ON e.org_id=s.org_id AND e.id=NEW.separation_event_id
   WHERE l.org_id=NEW.org_id AND l.id=NEW.source_line_id AND l.kind='earning' AND l.component_id=NEW.pay_component_id
     AND l.amount=NEW.amount AND l.amount>0 AND l.amount NOT IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) AND (l.hours IS NULL OR l.hours=0) AND s.pay_date=NEW.expected_payment_on
     AND s.employee_party_id=e.employee_party_id AND s.employment_id=e.employment_id AND d.subsidiary_id=e.subsidiary_id AND d.status<>'voided'
     AND s.currency_code='CAD' AND NEW.payment_status='paid') THEN
   RAISE EXCEPTION 'A paid separation declaration must retain its exact committed employee line and payment facts' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER payroll_roe_separation_payment_basis_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_roe_separation_payments
 FOR EACH ROW EXECUTE FUNCTION public.payroll_roe_separation_basis_reference_guard();

-- A separation payment is not evidence of later physical service; only its own later event may exclude it.
CREATE OR REPLACE FUNCTION public.payroll_roe_later_stub_source(tenant uuid, event uuid, stub_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 WITH subject AS (
   SELECT e.*,coalesce(e.salary_continuance_end_on,e.last_insurable_earnings_on) AS cutoff
   FROM public.payroll_roe_separation_events e WHERE e.org_id=$1 AND e.id=$2
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
     to_jsonb(a) AS attribution,l.amount,l.hours,coalesce(a.reporting_basis,'service') AS reporting_basis,a.separation_event_id,
     (a.separation_basis_snapshot=public.payroll_roe_separation_reporting_basis(a.org_id,a.separation_event_id,l.id,a.separation_payment_id,a.report_period_start,a.report_period_end)) AS separation_basis_matches,
     (a.id IS NULL OR a.line_snapshot=public.payroll_roe_reporting_line_snapshot(l.id,l.org_id)) AS snapshot_matches,coalesce(a.earned_from,l.earned_from) AS earned_from,
     coalesce(a.earned_to,l.earned_to) AS earned_to
   FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id=l.org_id AND s.id=l.stub_id
   JOIN public.documents d ON d.org_id=s.org_id AND d.id=s.pay_run_document_id
   JOIN public.pay_runs r ON r.org_id=s.org_id AND r.document_id=s.pay_run_document_id
   JOIN subject e ON e.org_id=s.org_id AND e.employee_party_id=s.employee_party_id
     AND e.employment_id=s.employment_id AND e.subsidiary_id=d.subsidiary_id
   LEFT JOIN public.payroll_roe_line_evidence a ON a.org_id=l.org_id AND a.pay_stub_line_id=l.id
   WHERE s.org_id=$1 AND s.id=$3 AND s.currency_code='CAD' AND r.run_status='committed'
     AND l.kind='earning' AND (l.amount<>0 OR l.hours<>0)
 )
 SELECT starts.proof||jsonb_build_object('stubId',$3,'stub',
   (SELECT to_jsonb(s) FROM public.pay_stubs s WHERE s.org_id=$1 AND s.id=$3),'lines',
   (SELECT jsonb_agg(jsonb_build_object('retained',m.retained,'attribution',m.attribution) ORDER BY m.id) FROM material m))
 FROM starts WHERE EXISTS(SELECT 1 FROM material) AND NOT EXISTS(
   SELECT 1 FROM material m WHERE NOT m.snapshot_matches OR m.amount IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
     OR m.hours IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR m.amount<0 OR m.hours<0
     OR (m.reporting_basis='separation_payment' AND (m.separation_basis_matches IS DISTINCT FROM true
       OR m.separation_event_id::text IS DISTINCT FROM starts.proof->'laterEvent'->>'id'))
     OR (m.reporting_basis<>'separation_payment' AND (m.earned_from IS NULL OR m.earned_to IS NULL
       OR m.earned_from>m.earned_to OR m.earned_from<starts.first_day
       OR starts.last_day IS NOT NULL AND m.earned_to>starts.last_day)))
 ORDER BY starts.first_day,starts.proof::text LIMIT 1
$$;
