-- OpenBooks forward migration 0642_warehouse_defaults.
--
-- Default receiving and fulfillment warehouse per legal entity. A company
-- with several warehouses names one default for each entity (or one
-- company-wide row when subsidiary_id is null); single-warehouse orgs never
-- need a row because the only active warehouse is already the implicit
-- default. Receipt, fulfillment, and order-line writers resolve the
-- entity's designated row first and fall back to that implicit default.
--
-- No data or backfill: a new table, empty on arrival. Reapply-safe by
-- construction (create-if-absent objects only).

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.warehouse_defaults (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subsidiary_id uuid,
    warehouse_id uuid NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT warehouse_defaults_pkey PRIMARY KEY (id),
    CONSTRAINT warehouse_defaults_org_id_id_unique UNIQUE (org_id, id),
    -- One company-wide row and at most one row per legal entity.
    CONSTRAINT warehouse_defaults_org_company_unique UNIQUE NULLS NOT DISTINCT (org_id, subsidiary_id),
    CONSTRAINT warehouse_defaults_warehouse_required CHECK (warehouse_id IS NOT NULL)
);

CREATE INDEX warehouse_defaults_org_warehouse ON public.warehouse_defaults (org_id, warehouse_id);
