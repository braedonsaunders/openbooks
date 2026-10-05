-- OpenBooks forward migration 0534_customer_portal.
-- Customer portal: passwordless magic-link tokens keyed to a customer party,
-- the organization's effective-dated portal configuration (branding, enabled
-- sections, return rules, cancel save offers), and the immutable audit trail
-- of every customer action taken through the portal. The plaintext token is
-- never stored; only its sha256 hash is kept, like payment link tokens.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.customer_portal_links (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  party_id uuid NOT NULL,
  contact_email text NOT NULL,
  token_hash text NOT NULL,
  purpose text NOT NULL DEFAULT 'magic_link',
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  failed_attempts integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT customer_portal_links_pkey PRIMARY KEY (id),
  CONSTRAINT customer_portal_links_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_portal_links_email_nonblank CHECK (length(btrim(contact_email)) > 0),
  CONSTRAINT customer_portal_links_hash_nonblank CHECK (length(btrim(token_hash)) > 0),
  CONSTRAINT customer_portal_links_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT customer_portal_links_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT customer_portal_links_party_tenant_fk
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX customer_portal_links_token_hash_unique
  ON public.customer_portal_links (token_hash);
CREATE INDEX customer_portal_links_party_scan
  ON public.customer_portal_links (org_id, party_id, expires_at);

ALTER TABLE public.customer_portal_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_links FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.customer_portal_links
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.customer_portal_links IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.customer_portal_links IS
  'Customer portal magic links: one short-lived single-use token hash per customer party and contact email. The plaintext token is never stored; lookup is by hash only.';

CREATE TABLE public.customer_portal_settings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  effective_from date NOT NULL,
  portal_name text NOT NULL DEFAULT 'Customer portal',
  sections jsonb NOT NULL DEFAULT '{}'::jsonb,
  return_window_days integer NOT NULL DEFAULT 30,
  return_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  return_resolutions jsonb NOT NULL DEFAULT '{}'::jsonb,
  save_offers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT customer_portal_settings_pkey PRIMARY KEY (id),
  CONSTRAINT customer_portal_settings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_portal_settings_effective_unique UNIQUE (org_id, effective_from),
  CONSTRAINT customer_portal_settings_window_nonnegative CHECK (return_window_days >= 0),
  CONSTRAINT customer_portal_settings_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

CREATE INDEX customer_portal_settings_effective_scan
  ON public.customer_portal_settings (org_id, effective_from DESC);

ALTER TABLE public.customer_portal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.customer_portal_settings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.customer_portal_settings IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.customer_portal_settings IS
  'Customer portal configuration, effective-dated: the reader takes the newest row on or before today, so a rule change never reinterprets past portal requests.';

CREATE TABLE public.customer_portal_events (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  party_id uuid NOT NULL,
  link_id uuid,
  action text NOT NULL,
  reason_code text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT customer_portal_events_pkey PRIMARY KEY (id),
  CONSTRAINT customer_portal_events_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_portal_events_action_nonblank CHECK (length(btrim(action)) > 0),
  CONSTRAINT customer_portal_events_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT customer_portal_events_party_tenant_fk
    FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id) ON DELETE CASCADE,
  CONSTRAINT customer_portal_events_link_tenant_fk
    FOREIGN KEY (org_id, link_id) REFERENCES public.customer_portal_links(org_id, id) ON DELETE SET NULL
);

CREATE INDEX customer_portal_events_party_scan
  ON public.customer_portal_events (org_id, party_id, created_at DESC);

ALTER TABLE public.customer_portal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.customer_portal_events
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.customer_portal_events IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.customer_portal_events IS
  'Customer portal audit trail: one immutable row per customer action. Rows are insert-only; corrections are new rows.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('customer_portal_links', '0534_customer_portal')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('customer_portal_settings', '0534_customer_portal')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('customer_portal_events', '0534_customer_portal')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
