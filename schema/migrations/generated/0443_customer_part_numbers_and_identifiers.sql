-- OpenBooks forward migration 0443_customer_part_numbers_and_identifiers.
-- Customer product codes and exact item scan identifiers are tenant-owned references.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.customer_item_refs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  item_id uuid NOT NULL,
  customer_sku text NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT customer_item_refs_pkey PRIMARY KEY (id),
  CONSTRAINT customer_item_refs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT customer_item_refs_customer_fkey
    FOREIGN KEY (org_id, customer_id) REFERENCES public.parties (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_item_refs_item_fkey
    FOREIGN KEY (org_id, item_id) REFERENCES public.items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT customer_item_refs_customer_sku_nonblank
    CHECK (length(btrim(customer_sku)) > 0),
  CONSTRAINT customer_item_refs_description_nonblank
    CHECK (description IS NULL OR length(btrim(description)) > 0),
  CONSTRAINT customer_item_refs_org_customer_sku_unique UNIQUE (org_id, customer_id, customer_sku),
  CONSTRAINT customer_item_refs_org_customer_item_unique UNIQUE (org_id, customer_id, item_id)
);
CREATE INDEX customer_item_refs_org_customer ON public.customer_item_refs (org_id, customer_id, item_id);
CREATE INDEX customer_item_refs_org_item ON public.customer_item_refs (org_id, item_id, customer_id);

ALTER TABLE public.customer_item_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_item_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.customer_item_refs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.customer_item_refs IS 'openbooks:org_isolation:v1';

CREATE TABLE public.item_identifiers (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  kind text NOT NULL,
  value text NOT NULL,
  unit text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT item_identifiers_pkey PRIMARY KEY (id),
  CONSTRAINT item_identifiers_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT item_identifiers_item_fkey
    FOREIGN KEY (org_id, item_id) REFERENCES public.items (org_id, id) ON DELETE RESTRICT,
  CONSTRAINT item_identifiers_kind_check CHECK (kind IN ('gtin', 'upc', 'ean', 'internal')),
  CONSTRAINT item_identifiers_value_nonblank CHECK (length(btrim(value)) > 0),
  CONSTRAINT item_identifiers_unit_nonblank CHECK (unit IS NULL OR length(btrim(unit)) > 0),
  CONSTRAINT item_identifiers_org_value_unique UNIQUE (org_id, value)
);
CREATE INDEX item_identifiers_org_item ON public.item_identifiers (org_id, item_id, kind);

ALTER TABLE public.item_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_identifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.item_identifiers
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY tenant_isolation ON public.item_identifiers IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('customer_item_refs', '0443_customer_part_numbers_and_identifiers'),
       ('item_identifiers', '0443_customer_part_numbers_and_identifiers')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
