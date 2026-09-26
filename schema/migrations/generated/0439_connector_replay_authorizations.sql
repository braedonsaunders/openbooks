-- OpenBooks forward migration 0439_connector_replay_authorizations.
--
-- Posting into a closed period through the connector historical-replay door
-- used to rest on a transaction-local flag alone: whoever could set three
-- GUCs beside an active sync run could mirror upstream history with no
-- durable record of who allowed it, for which connector, for which periods,
-- or why. One row here is that durable grant: the authorizing controller,
-- the moment it was given, the connector it covers, the covered period
-- range, the reason, and the moment it stops working. postEntry refuses a
-- closed-period replay with no live row covering the period, and every
-- admitted replay carries its authorization id into its audit_log row, so
-- the grant and each use of it stay joined in evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.connector_replay_authorizations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  authorized_by uuid NOT NULL,
  authorized_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  period_from_id uuid NOT NULL,
  period_to_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT connector_replay_authorizations_pkey PRIMARY KEY (id),
  CONSTRAINT connector_replay_authorizations_reason_check
    CHECK (char_length(reason) BETWEEN 10 AND 1000),
  CONSTRAINT connector_replay_authorizations_expiry_check
    CHECK (expires_at > authorized_at)
);

ALTER TABLE public.connector_replay_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_replay_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.connector_replay_authorizations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX IF NOT EXISTS connector_replay_authorizations_org_connection
  ON public.connector_replay_authorizations (org_id, connection_id);

COMMENT ON TABLE public.connector_replay_authorizations IS
  'Durable controller grants for connector historical replay into closed periods: who allowed which connector to mirror which period range, why, and until when. postEntry admits a closed-period replay only against a live row and cites it in the posting audit.';
COMMENT ON COLUMN public.connector_replay_authorizations.authorized_by IS
  'Controller who granted the replay window; the sync-run actor replays under it but never grants it.';
COMMENT ON COLUMN public.connector_replay_authorizations.period_from_id IS
  'One end of the covered accounting-period range; the ends are interchangeable, coverage is the date span between them.';
COMMENT ON COLUMN public.connector_replay_authorizations.period_to_id IS
  'The other end of the covered accounting-period range; the ends are interchangeable, coverage is the date span between them.';
