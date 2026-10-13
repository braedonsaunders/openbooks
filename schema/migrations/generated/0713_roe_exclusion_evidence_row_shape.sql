-- Preserve exact event-transition admission across event and earning-line evidence trigger row shapes.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.payroll_roe_used_exclusion_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE tenant uuid; employee uuid; identity uuid;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
   OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 tenant:=CASE WHEN TG_OP='INSERT' THEN NEW.org_id ELSE OLD.org_id END;
 employee:=CASE WHEN TG_OP='INSERT' THEN NEW.employee_party_id ELSE OLD.employee_party_id END;
 identity:=CASE WHEN TG_OP='INSERT' THEN NEW.id ELSE OLD.id END;
 IF TG_TABLE_NAME='payroll_roe_separation_events' AND TG_OP='UPDATE'
   AND to_jsonb(NEW)->>'status'='issued' AND to_jsonb(OLD)->>'status'='confirmed'
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
