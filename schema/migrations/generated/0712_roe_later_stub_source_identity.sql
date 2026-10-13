-- Bind later-service source resolution to its exact tenant, event and retained stub arguments.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

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
     to_jsonb(a) AS attribution,l.amount,l.hours,
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
     OR m.hours IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) OR m.amount<0 OR m.hours<0 OR m.earned_from IS NULL OR m.earned_to IS NULL
     OR m.earned_from>m.earned_to OR m.earned_from<starts.first_day
     OR starts.last_day IS NOT NULL AND m.earned_to>starts.last_day)
 ORDER BY starts.first_day,starts.proof::text LIMIT 1
$$;
