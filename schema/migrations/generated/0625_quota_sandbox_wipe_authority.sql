-- Native sandbox deletion retains ordinary quota lifecycle and immutability.
-- Its delete exception requires the exact sandbox and a maintenance login.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.sales_quota_version_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id)
    AND current_setting('openbooks.migration',true)='on'
    AND current_setting('openbooks.amend',true)='on'
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=SESSION_USER AND (rolsuper OR rolbypassrls))
 THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Quota history cannot be deleted; close the quota instead.' USING ERRCODE='23514'; END IF;
 IF OLD.lifecycle IN ('approved','superseded','closed') AND
  (to_jsonb(NEW)-ARRAY['lifecycle','updated_at','updated_by','revision']) IS DISTINCT FROM
  (to_jsonb(OLD)-ARRAY['lifecycle','updated_at','updated_by','revision']) THEN
  RAISE EXCEPTION 'Approved quotas are immutable; create a revised quota with a reason and approval.' USING ERRCODE='23514';
 END IF;
 IF NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NOT (
  (OLD.lifecycle='draft' AND NEW.lifecycle='pending_approval') OR
  (OLD.lifecycle='pending_approval' AND NEW.lifecycle IN ('draft','approved')) OR
  (OLD.lifecycle='approved' AND NEW.lifecycle IN ('superseded','closed'))) THEN
  RAISE EXCEPTION 'Invalid quota lifecycle transition.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
