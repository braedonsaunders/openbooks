-- OpenBooks forward migration 0503_usage_schedules.
-- Scheduled usage rating (per-link cadence with per-org defaults, late-usage
-- grace days, draft vs auto-commit) and the Stripe Billing import schedule
-- plus explicit operator skip decisions for unlinked Stripe objects.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.usage_rating_settings (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  link_id uuid,
  cadence text DEFAULT 'billing_period' NOT NULL,
  grace_days integer DEFAULT 2 NOT NULL,
  mode text DEFAULT 'draft' NOT NULL,
  last_rated_period_end date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT usage_rating_settings_pkey PRIMARY KEY (id),
  CONSTRAINT usage_rating_settings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_rating_settings_cadence_valid
    CHECK (cadence IN ('billing_period', 'monthly', 'paused')),
  CONSTRAINT usage_rating_settings_grace_days_valid
    CHECK (grace_days >= 0 AND grace_days <= 30),
  CONSTRAINT usage_rating_settings_mode_valid
    CHECK (mode IN ('draft', 'auto_commit')),
  CONSTRAINT usage_rating_settings_watermark_valid
    CHECK (last_rated_period_end IS NULL OR link_id IS NOT NULL),
  CONSTRAINT usage_rating_settings_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_rating_settings_link_org_fk
    FOREIGN KEY (org_id, link_id) REFERENCES public.subscription_usage_links(org_id, id) ON DELETE CASCADE DEFERRABLE
);

CREATE UNIQUE INDEX usage_rating_settings_org_default_unique
  ON public.usage_rating_settings (org_id) WHERE link_id IS NULL;
CREATE UNIQUE INDEX usage_rating_settings_org_link_unique
  ON public.usage_rating_settings (org_id, link_id) WHERE link_id IS NOT NULL;

ALTER TABLE public.usage_rating_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_rating_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.usage_rating_settings
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.usage_rating_settings IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.usage_rating_settings IS
  'Usage rating schedule. A row with link_id NULL is the per-org default; a row with link_id set overrides it for one subscription usage link. last_rated_period_end is the scheduler watermark and is only meaningful on link rows.';

CREATE TABLE public.stripe_billing_import_schedules (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  cadence text DEFAULT 'off' NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT stripe_billing_import_schedules_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_billing_import_schedules_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT stripe_billing_import_schedules_org_singleton_unique UNIQUE (org_id),
  CONSTRAINT stripe_billing_import_schedules_cadence_valid
    CHECK (cadence IN ('off', 'hourly', 'daily')),
  CONSTRAINT stripe_billing_import_schedules_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

ALTER TABLE public.stripe_billing_import_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_billing_import_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.stripe_billing_import_schedules
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.stripe_billing_import_schedules IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.stripe_billing_import_schedules IS
  'Stripe Billing import cadence, at most one row per organization. The last import time is read from sync_runs, never stored here.';

CREATE TABLE public.stripe_billing_link_skips (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  stripe_account text NOT NULL,
  object_type text NOT NULL,
  stripe_id text NOT NULL,
  reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT stripe_billing_link_skips_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_billing_link_skips_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT stripe_billing_link_skips_type_valid
    CHECK (object_type IN ('customer', 'subscription')),
  CONSTRAINT stripe_billing_link_skips_stripe_id_nonblank
    CHECK (length(btrim(stripe_id)) > 0),
  CONSTRAINT stripe_billing_link_skips_account_nonblank
    CHECK (length(btrim(stripe_account)) > 0),
  CONSTRAINT stripe_billing_link_skips_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

CREATE UNIQUE INDEX stripe_billing_link_skips_object_unique
  ON public.stripe_billing_link_skips (org_id, stripe_account, object_type, stripe_id);

ALTER TABLE public.stripe_billing_link_skips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_billing_link_skips FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.stripe_billing_link_skips
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.stripe_billing_link_skips IS 'openbooks:org_isolation:v1';

COMMENT ON TABLE public.stripe_billing_link_skips IS
  'Explicit operator decisions to leave a Stripe customer or subscription unlinked. Skipped objects stay out of the unlinked triage list until unskipped; linking a skipped object removes its skip.';

-- Admit the Stripe Billing import scan alongside the rating scan the commerce
-- scheduler kinds migration already admitted. Both scans are organization-wide
-- (no org or subject), like the other periodic scans.
ALTER TABLE public.scheduler_outbox DROP CONSTRAINT IF EXISTS scheduler_outbox_kind;
ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_kind CHECK (
  kind = ANY (ARRAY[
    'dunning'::text,
    'subscription_billing'::text,
    'property_billing'::text,
    'fx_providers'::text,
    'approval_escalation'::text,
    'flow_email'::text,
    'allocation_run'::text,
    'saas_metrics'::text,
    'commerce_inbound'::text,
    'commerce_channel_sync'::text,
    'webhook_delivery'::text,
    'autopay_collection'::text,
    'usage_rating'::text,
    'stripe_billing_import'::text,
    'tax_provider_commit'::text,
    'stored_value_breakage'::text
  ])
);

ALTER TABLE public.scheduler_outbox DROP CONSTRAINT IF EXISTS scheduler_outbox_scope;
ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_scope CHECK (
  ((kind = 'approval_escalation') AND org_id IS NOT NULL AND subject_id IS NOT NULL)
  OR ((kind = ANY (ARRAY[
    'dunning'::text, 'subscription_billing'::text, 'property_billing'::text,
    'fx_providers'::text, 'saas_metrics'::text,
    'commerce_inbound'::text, 'commerce_channel_sync'::text, 'webhook_delivery'::text,
    'autopay_collection'::text, 'usage_rating'::text, 'stripe_billing_import'::text,
    'tax_provider_commit'::text, 'stored_value_breakage'::text
  ])) AND org_id IS NULL AND subject_id IS NULL)
  OR ((kind = 'flow_email') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
  OR ((kind = 'allocation_run') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
);

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('usage_rating_settings', '0503_usage_schedules')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('stripe_billing_import_schedules', '0503_usage_schedules')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('stripe_billing_link_skips', '0503_usage_schedules')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
