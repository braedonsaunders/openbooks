-- Preserve immutable sales history while allowing authorized sandbox teardown.
-- The exemption permits DELETE only in a privileged maintenance transaction
-- against an actual sandbox and its recorded source organization.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.sales_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.openbooks_sandbox_wipe_allowed(OLD.org_id)
     AND current_setting('openbooks.migration', true) = 'on'
     AND current_setting('openbooks.amend', true) = 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = current_user AND rolbypassrls)
     AND EXISTS (SELECT 1 FROM public.orgs target
                  JOIN public.sandboxes sandbox
                    ON sandbox.org_id = target.id
                   AND sandbox.production_org_id = target.sandbox_of
                  JOIN public.orgs source ON source.id = target.sandbox_of
                 WHERE target.id = OLD.org_id AND target.env_kind = 'sandbox') THEN
    RETURN OLD;
  END IF;
  IF public.app_bypass_rls_active()
     AND current_setting('openbooks.amend', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Sales evidence is immutable; correct the source through its controlled reversal workflow.'
    USING ERRCODE = '23514';
END;
$function$;
