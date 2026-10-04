-- OpenBooks forward migration 0490_commerce_scheduler_kinds.
-- Admit the periodic scheduler scans for storefront channels, outbound webhook
-- delivery, automatic collection, usage rating, tax provider commits and
-- stored-value breakage. Each is an organization-wide scan (no org or subject).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

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
    'autopay_collection'::text, 'usage_rating'::text, 'tax_provider_commit'::text,
    'stored_value_breakage'::text
  ])) AND org_id IS NULL AND subject_id IS NULL)
  OR ((kind = 'flow_email') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
  OR ((kind = 'allocation_run') AND org_id IS NOT NULL AND subject_id IS NOT NULL AND payload IS NOT NULL)
);
