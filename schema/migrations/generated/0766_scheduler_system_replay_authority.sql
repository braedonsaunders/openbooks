-- System scheduler replay requires an explicit transaction-scoped system pin
-- under native cross-tenant authority. Tenant replay retains its exact org pin.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.openbooks_scheduler_outbox_replay_allowed(p_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    CASE WHEN p_org_id IS NULL THEN
      public.app_bypass_rls_active()
      AND current_setting('openbooks.scheduler_outbox_replay_org', true) = '__system__'
    ELSE
      current_setting('openbooks.scheduler_outbox_replay_org', true) = p_org_id::text
    END,
    false
  )
$$;

COMMENT ON FUNCTION public.openbooks_scheduler_outbox_replay_allowed(uuid) IS
  'Replay is limited to the transaction-pinned organization; system scans additionally require native cross-tenant authority and an explicit system scope.';
