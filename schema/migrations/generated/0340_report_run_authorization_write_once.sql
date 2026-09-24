-- OpenBooks forward migration 0340_report_run_authorization_write_once.
--
-- RENDER-STAMP (release-blocking): 3d8c61a78 records the content-derived
-- requiredPermissions on report_runs.authorization_snapshot at render
-- time, but 0086's protect_report_run_authorization() refuses ANY change
-- to that column — so every scheduled or close render whose snapshot
-- predates recording failed with 'report run authorization_snapshot
-- evidence is immutable'. The evidence stays immutable except for one
-- write-once transition: OLD carries no requiredPermissions key and NEW
-- is OLD plus exactly that key holding an array, every other key
-- identical. Changing an already-recorded requiredPermissions, or any
-- other key, still raises. 0086 itself is never edited; this replaces
-- only the trigger function body (the trigger keeps its name).
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.protect_report_run_authorization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.authorization_snapshot IS NOT DISTINCT FROM OLD.authorization_snapshot THEN
    RETURN NEW;
  END IF;
  -- A missing snapshot behaves like an empty object for the one allowed
  -- transition below, but it may gain nothing beyond that single key.
  IF OLD.authorization_snapshot IS NULL THEN
    IF jsonb_typeof(NEW.authorization_snapshot) = 'object'
       AND NEW.authorization_snapshot
           = jsonb_build_object('requiredPermissions', NEW.authorization_snapshot->'requiredPermissions')
       AND jsonb_typeof(NEW.authorization_snapshot->'requiredPermissions') = 'array' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  IF jsonb_typeof(OLD.authorization_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  -- An already-recorded requiredPermissions is evidence: it never moves.
  IF OLD.authorization_snapshot ? 'requiredPermissions' THEN
    RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
  END IF;
  -- Otherwise NEW must be OLD plus exactly the recorded key (jsonb
  -- equality: every other key identical, the new key an array).
  IF jsonb_typeof(NEW.authorization_snapshot->'requiredPermissions') = 'array'
     AND (OLD.authorization_snapshot
          || jsonb_build_object('requiredPermissions', NEW.authorization_snapshot->'requiredPermissions')
         ) = NEW.authorization_snapshot THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'report run authorization_snapshot evidence is immutable';
END;
$$;
