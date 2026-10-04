-- OpenBooks forward migration 0492_item_families.
-- Product families with ordered options; each variant stays an ordinary items
-- row so stock, costing, pricing, tax, documents and reports work unchanged.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.item_families (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  category text,
  kind text NOT NULL,
  default_unit text,
  default_rate numeric(19,4),
  status text NOT NULL DEFAULT 'active',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT item_families_pkey PRIMARY KEY (id),
  CONSTRAINT item_families_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT item_families_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT item_families_code_nonblank
    CHECK (length(btrim(code)) > 0),
  CONSTRAINT item_families_name_nonblank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT item_families_kind_allowed
    CHECK (kind IN ('inventory', 'non_inventory', 'service', 'kit', 'assembly')),
  CONSTRAINT item_families_status_allowed
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT item_families_org_code_unique UNIQUE (org_id, code)
);

ALTER TABLE public.item_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_families FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.item_families
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.item_families IS 'openbooks:org_isolation:v1';

CREATE TABLE public.item_family_options (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  family_id uuid NOT NULL,
  position integer NOT NULL,
  name text NOT NULL,
  "values" text[] NOT NULL DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT item_family_options_pkey PRIMARY KEY (id),
  CONSTRAINT item_family_options_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT item_family_options_family_fkey
    FOREIGN KEY (org_id, family_id) REFERENCES public.item_families (org_id, id) ON DELETE CASCADE,
  CONSTRAINT item_family_options_position_positive
    CHECK (position > 0),
  CONSTRAINT item_family_options_name_nonblank
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT item_family_options_values_nonempty
    CHECK (coalesce(cardinality("values"), 0) >= 1),
  CONSTRAINT item_family_options_org_family_name_unique UNIQUE (org_id, family_id, name),
  CONSTRAINT item_family_options_org_family_position_unique UNIQUE (org_id, family_id, position)
);
CREATE INDEX item_family_options_org_family ON public.item_family_options (org_id, family_id, position);

ALTER TABLE public.item_family_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_family_options FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.item_family_options
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.item_family_options IS 'openbooks:org_isolation:v1';

ALTER TABLE public.items ADD COLUMN family_id uuid;
ALTER TABLE public.items ADD COLUMN option_values jsonb;
ALTER TABLE public.items ADD CONSTRAINT items_family_tenant_fkey
  FOREIGN KEY (org_id, family_id) REFERENCES public.item_families (org_id, id) ON DELETE RESTRICT;
ALTER TABLE public.items ADD CONSTRAINT items_family_option_values_check
  CHECK ((family_id IS NULL AND option_values IS NULL)
      OR (family_id IS NOT NULL AND option_values IS NOT NULL));
CREATE UNIQUE INDEX items_org_family_option_values
  ON public.items (org_id, family_id, option_values) WHERE family_id IS NOT NULL;
CREATE INDEX items_org_family ON public.items (org_id, family_id) WHERE family_id IS NOT NULL;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('item_families', '0492_item_families'),
       ('item_family_options', '0492_item_families')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
