-- OpenBooks forward migration 0043_sandbox_wip_prebill_wipe_guard.
--
-- WIP pre-bill events are permanent accounting evidence in ordinary operation.
-- The prerelease guard read the obsolete `app.sandbox_wipe` GUC, while the
-- sandbox lifecycle sets `openbooks.sandbox_wipe`. Migration 0019 aligned that
-- name, but its direct GUC check admitted both UPDATE and DELETE for any org.
-- Route the exemption through the canonical helper so it applies only to a
-- DELETE from an org that is actually marked as a sandbox.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.wip_prebill_event_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;
