-- Let a deterministic organization clone copy temporary differences of finalized provision runs.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

-- Temporary differences may change only while their provision run is a
-- draft. A clone copies posted history verbatim, including differences of
-- discarded or posted runs, in whichever order its tables are copied, so the
-- guard admits inserts made under the clone transaction's authority, as the
-- other posted-history guards do. Every other write keeps its checks.
CREATE OR REPLACE FUNCTION public.protect_temporary_difference_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_org_id uuid;
  target_run_id uuid;
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;

  target_org_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  IF TG_OP = 'DELETE'
     AND openbooks_sandbox_wipe_allowed(target_org_id) THEN
    RETURN OLD;
  END IF;

  target_run_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;
  SELECT status
    INTO target_status
    FROM tax_provision_runs
   WHERE id = target_run_id
     AND org_id = target_org_id;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'temporary difference must reference a tenant-owned provision run';
  END IF;
  IF target_status <> 'draft' THEN
    RAISE EXCEPTION
      'temporary differences are immutable after provision finalization (run %, status %)',
      target_run_id, target_status;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
