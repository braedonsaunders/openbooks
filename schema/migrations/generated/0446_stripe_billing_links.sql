-- OpenBooks forward migration 0446_stripe_billing_links.
-- Preserve tenant-owned Stripe identities separately from native usage records.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.stripe_billing_links (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  object_type text NOT NULL,
  stripe_id text NOT NULL,
  openbooks_id uuid NOT NULL,
  stripe_account text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT stripe_billing_links_pkey PRIMARY KEY (id),
  CONSTRAINT stripe_billing_links_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT stripe_billing_links_type_valid
    CHECK (object_type IN ('meter', 'price', 'customer', 'subscription', 'subscription_item')),
  CONSTRAINT stripe_billing_links_stripe_id_nonblank
    CHECK (length(btrim(stripe_id)) > 0),
  CONSTRAINT stripe_billing_links_account_nonblank
    CHECK (length(btrim(stripe_account)) > 0),
  CONSTRAINT stripe_billing_links_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE
);

CREATE UNIQUE INDEX stripe_billing_links_external_unique
  ON public.stripe_billing_links (org_id, stripe_account, object_type, stripe_id);
CREATE UNIQUE INDEX stripe_billing_links_native_unique
  ON public.stripe_billing_links (org_id, stripe_account, object_type, openbooks_id);

ALTER TABLE public.stripe_billing_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_billing_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.stripe_billing_links
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.stripe_billing_links IS
  'Organization-owned Stripe identity map. openbooks_id is polymorphic and has no party foreign key; customer identities are linked explicitly.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('stripe_billing_links', '0446_stripe_billing_links')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
