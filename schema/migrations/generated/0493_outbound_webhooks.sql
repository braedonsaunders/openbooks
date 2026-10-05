-- OpenBooks forward migration 0493_outbound_webhooks.
-- Signed delivery transport for subscribed domain events: subscriber
-- endpoints with sealed signing secrets and rotation overlap, the domain
-- event outbox written in the business transaction, and the per-endpoint
-- delivery log the worker retries with backoff.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.webhook_endpoints (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  key text NOT NULL,
  url text NOT NULL,
  description text NOT NULL DEFAULT '',
  events text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  secret_sealed text NOT NULL,
  secret_previous_sealed text,
  secret_rotated_at timestamp with time zone,
  consecutive_failures integer NOT NULL DEFAULT 0,
  auto_disable_after integer NOT NULL DEFAULT 25,
  disabled_at timestamp with time zone,
  disabled_reason text,
  last_delivery_at timestamp with time zone,
  last_delivery_status text,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_endpoints_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT webhook_endpoints_key_unique UNIQUE (org_id, key),
  CONSTRAINT webhook_endpoints_key_nonblank CHECK (length(btrim(key)) > 0),
  CONSTRAINT webhook_endpoints_url_nonblank CHECK (length(btrim(url)) > 0),
  CONSTRAINT webhook_endpoints_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT webhook_endpoints_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT webhook_endpoints_threshold_positive CHECK (auto_disable_after > 0),
  CONSTRAINT webhook_endpoints_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.webhook_endpoints
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.webhook_endpoints IS 'openbooks:org_isolation:v1';

CREATE TABLE public.webhook_events (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  event_type text NOT NULL,
  entity_kind text,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT webhook_events_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_events_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT webhook_events_dedupe_unique UNIQUE (org_id, dedupe_key),
  CONSTRAINT webhook_events_type_nonblank CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT webhook_events_dedupe_nonblank CHECK (length(btrim(dedupe_key)) > 0),
  CONSTRAINT webhook_events_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.webhook_events
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.webhook_events IS 'openbooks:org_isolation:v1';

CREATE TABLE public.webhook_deliveries (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  first_attempt_at timestamp with time zone,
  last_attempt_at timestamp with time zone,
  last_response_code integer,
  last_response_excerpt text,
  last_latency_ms integer,
  last_error text,
  delivered_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_deliveries_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT webhook_deliveries_event_endpoint_unique UNIQUE (org_id, event_id, endpoint_id),
  CONSTRAINT webhook_deliveries_status_valid
    CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  CONSTRAINT webhook_deliveries_attempts_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT webhook_deliveries_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT webhook_deliveries_event_fk
    FOREIGN KEY (org_id, event_id) REFERENCES public.webhook_events(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT webhook_deliveries_endpoint_fk
    FOREIGN KEY (org_id, endpoint_id) REFERENCES public.webhook_endpoints(org_id, id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.webhook_deliveries
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.webhook_deliveries IS 'openbooks:org_isolation:v1';

CREATE INDEX webhook_deliveries_due
  ON public.webhook_deliveries (status, next_attempt_at);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('webhook_endpoints', '0493_outbound_webhooks')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('webhook_events', '0493_outbound_webhooks')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('webhook_deliveries', '0493_outbound_webhooks')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
