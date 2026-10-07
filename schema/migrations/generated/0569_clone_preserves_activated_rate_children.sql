-- OpenBooks forward migration 0569_clone_preserves_activated_rate_children.
-- Preserve approved rate terms when copying a populated sandbox. Parent
-- ownership is still checked, and ordinary writes remain immutable.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.rate_version_child_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
DECLARE
  v_status text;
  v_org_id uuid;
BEGIN
  SELECT status, org_id
    INTO v_status, v_org_id
    FROM public.item_rate_versions
   WHERE id = coalesce(NEW.version_id, OLD.version_id);
  IF v_status IS NULL
     OR v_org_id IS DISTINCT FROM coalesce(NEW.org_id, OLD.org_id) THEN
    RAISE EXCEPTION 'rate-version child must reference a tenant-owned version'
      USING ERRCODE = '23514';
  END IF;
  IF v_status <> 'draft' THEN
    -- The native clone copies the immutable source snapshot into a sandbox.
    -- Its privileged, transaction-local authority permits INSERT only.
    IF TG_OP = 'INSERT' AND public.openbooks_clone_authority()
       AND EXISTS (SELECT 1 FROM public.orgs
                    WHERE id = NEW.org_id AND env_kind = 'sandbox'
                      AND sandbox_of IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE'
       AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'children of an activated or retired rate version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$func$;
