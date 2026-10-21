-- Source-retired time remains evidence and cannot enter another downstream transaction.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.source_retired_time_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF OLD.custom->'sourceRetirement' IS NULL THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
   IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Source-retired time is retained as audit evidence.' USING ERRCODE='23514';
 END IF;
 IF NEW.custom->'sourceRetirement' IS DISTINCT FROM OLD.custom->'sourceRetirement'
   OR NEW.org_id IS DISTINCT FROM OLD.org_id
   OR NEW.custom->>(OLD.custom->'sourceRetirement'->>'refKey') IS DISTINCT FROM OLD.custom->'sourceRetirement'->>'sourceRef'
   OR (to_jsonb(NEW)-ARRAY['custom','updated_at','updated_by','invoiced_by_line_id','cost_journal_entry_id','overhead_journal_entry_id','payroll_batch_ref','billing_status'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['custom','updated_at','updated_by','invoiced_by_line_id','cost_journal_entry_id','overhead_journal_entry_id','payroll_batch_ref','billing_status'])
   OR (OLD.invoiced_by_line_id IS NULL AND NEW.invoiced_by_line_id IS NOT NULL)
   OR (OLD.cost_journal_entry_id IS NULL AND NEW.cost_journal_entry_id IS NOT NULL)
   OR (OLD.overhead_journal_entry_id IS NULL AND NEW.overhead_journal_entry_id IS NOT NULL)
   OR (OLD.payroll_batch_ref IS NULL AND NEW.payroll_batch_ref IS NOT NULL)
   OR (OLD.field_ticket_id IS NULL AND NEW.field_ticket_id IS NOT NULL)
   OR (OLD.production_consumed_operation_id IS NULL AND NEW.production_consumed_operation_id IS NOT NULL)
   OR (OLD.billing_status='unbilled' AND NEW.billing_status='billed')
   OR (OLD.status<>'approved' AND NEW.status IN ('draft','submitted','approved')) THEN
   RAISE EXCEPTION 'This time entry was deleted in its authoritative source and cannot be consumed again. Create new time for new work.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER source_retired_time_evidence BEFORE UPDATE OR DELETE ON public.time_entries
 FOR EACH ROW EXECUTE FUNCTION public.source_retired_time_guard();
