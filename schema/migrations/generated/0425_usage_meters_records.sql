-- OpenBooks forward migration 0425_usage_meters_records.
-- Preserve org-scoped usage configuration and append-only source evidence for rating.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.usage_meters (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL,
  aggregation text NOT NULL,
  item_id uuid,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT usage_meters_pkey PRIMARY KEY (id),
  CONSTRAINT usage_meters_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_meters_org_key_unique UNIQUE (org_id, key),
  CONSTRAINT usage_meters_key_nonblank CHECK (length(btrim(key)) > 0),
  CONSTRAINT usage_meters_name_nonblank CHECK (length(btrim(name)) > 0),
  CONSTRAINT usage_meters_unit_nonblank CHECK (length(btrim(unit)) > 0),
  CONSTRAINT usage_meters_aggregation_valid
    CHECK (aggregation IN ('sum', 'count', 'max', 'last', 'unique_count')),
  CONSTRAINT usage_meters_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_meters_item_org_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id) DEFERRABLE
);

CREATE INDEX usage_meters_org_active ON public.usage_meters (org_id, is_active);

ALTER TABLE public.usage_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_meters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_meters
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.usage_meters IS
  'Organization-owned usage definitions; key and aggregation become fixed after usage evidence exists.';

CREATE TABLE public.usage_records (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  meter_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  subscription_id uuid,
  occurred_on date NOT NULL,
  quantity numeric(28,8) NOT NULL,
  distinct_key text,
  source text NOT NULL,
  source_ref text,
  idempotency_key text NOT NULL,
  reverses_id uuid,
  reversal_reason text,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT usage_records_pkey PRIMARY KEY (id),
  CONSTRAINT usage_records_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT usage_records_source_valid
    CHECK (source IN ('api', 'import', 'connector_stripe', 'manual')),
  CONSTRAINT usage_records_quantity_valid
    CHECK ((reverses_id IS NULL AND quantity > 0)
        OR (reverses_id IS NOT NULL AND quantity < 0)),
  CONSTRAINT usage_records_reversal_reason
    CHECK ((reverses_id IS NULL AND reversal_reason IS NULL)
        OR (reverses_id IS NOT NULL AND reversal_reason IS NOT NULL
            AND length(btrim(reversal_reason)) > 0)),
  CONSTRAINT usage_records_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT usage_records_meter_org_fk
    FOREIGN KEY (org_id, meter_id) REFERENCES public.usage_meters(org_id, id) DEFERRABLE,
  CONSTRAINT usage_records_customer_org_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.parties(org_id, id) DEFERRABLE,
  CONSTRAINT usage_records_subscription_org_fk
    FOREIGN KEY (org_id, subscription_id) REFERENCES public.subscriptions(org_id, id) DEFERRABLE,
  CONSTRAINT usage_records_reverses_org_fk
    FOREIGN KEY (org_id, reverses_id) REFERENCES public.usage_records(org_id, id) DEFERRABLE
);

CREATE UNIQUE INDEX usage_records_org_meter_idempotency_unique
  ON public.usage_records (org_id, meter_id, idempotency_key);
CREATE UNIQUE INDEX usage_records_one_reversal
  ON public.usage_records (org_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX usage_records_window
  ON public.usage_records (org_id, meter_id, customer_id, occurred_on, id);

ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.usage_records
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.usage_records IS
  'Immutable, idempotent usage evidence; corrections append a negative row linked to the original.';
COMMENT ON COLUMN public.usage_records.reversal_reason IS
  'Operator explanation required for a reversal; the original usage evidence remains unchanged.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('usage_meters', '0425_usage_meters_records'),
  ('usage_records', '0425_usage_meters_records')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
