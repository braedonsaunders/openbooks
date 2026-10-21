-- Audit period-opening revisions without rewriting their qualified annual source.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.payroll_period_opening_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 INSERT INTO public.audit_log(org_id,table_name,row_id,action,actor_id,changes)
 VALUES(NEW.org_id,'payroll_period_openings',NEW.id,lower(TG_OP),CASE WHEN public.openbooks_clone_authority() THEN NULL ELSE NEW.updated_by END,
 jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,'after',to_jsonb(NEW),
   'reason',CASE WHEN public.openbooks_clone_authority() THEN 'Preserve period opening evidence during controlled sandbox cloning.' ELSE NEW.reason END,'sourceReference',NEW.source_reference));
 -- Period evidence has its own revision. The qualified annual source remains immutable.
 RETURN NEW;
END $function$;
