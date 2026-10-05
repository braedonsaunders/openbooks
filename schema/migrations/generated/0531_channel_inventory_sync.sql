-- OpenBooks forward migration 0531_channel_inventory_sync.
-- Storefront inventory push: per-location buffer and stop-selling policy,
-- per-item overrides, the last-pushed baseline per mapped pair, and the
-- conflict queue for quantities changed outside OpenBooks.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Buffer kept back per storefront location, and whether the storefront must
-- stop selling the item when the pushed quantity reaches zero. Both default
-- to the safe posture: nothing held back, selling stops at zero.
ALTER TABLE public.sales_channel_locations
  ADD COLUMN buffer_quantity numeric(19,4) NOT NULL DEFAULT '0';
ALTER TABLE public.sales_channel_locations
  ADD COLUMN stop_selling_at_zero boolean NOT NULL DEFAULT true;
ALTER TABLE public.sales_channel_locations
  ADD CONSTRAINT sales_channel_locations_buffer_nonnegative
    CHECK (buffer_quantity >= 0);

-- Per-item override of the location policy. Null means inherit the
-- location's value, so an override touches only what it changes.
CREATE TABLE public.channel_item_inventory_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  item_id uuid NOT NULL,
  buffer_quantity numeric(19,4),
  stop_selling_at_zero boolean,
  sync_inventory boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_item_inventory_policies_pkey PRIMARY KEY (id),
  CONSTRAINT channel_item_inventory_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_item_inventory_policies_buffer_nonnegative
    CHECK (buffer_quantity IS NULL OR buffer_quantity >= 0),
  CONSTRAINT channel_item_inventory_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_item_inventory_policies_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_item_inventory_policies_item_tenant_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_item_inventory_policies_channel_item_unique
  ON public.channel_item_inventory_policies (org_id, channel_id, item_id);

ALTER TABLE public.channel_item_inventory_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_item_inventory_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_item_inventory_policies
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_item_inventory_policies IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_item_inventory_policies IS
  'Per-item override of a channel location inventory policy: null inherits the location value. Never a second policy store; resolution is override-first in the inventory push path.';

-- The last-pushed baseline per mapped pair. The next push compares the
-- storefront quantity against this row: a storefront that moved on its own
-- becomes a conflict, never a silent overwrite.
CREATE TABLE public.channel_inventory_push_states (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  shopify_inventory_item_id text,
  last_pushed_quantity integer,
  last_shopify_quantity integer,
  last_inventory_policy text,
  last_pushed_at timestamp with time zone,
  last_status text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_inventory_push_states_pkey PRIMARY KEY (id),
  CONSTRAINT channel_inventory_push_states_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_inventory_push_states_policy_valid
    CHECK (last_inventory_policy IS NULL OR last_inventory_policy IN ('deny', 'continue')),
  CONSTRAINT channel_inventory_push_states_status_valid
    CHECK (last_status IN ('pending', 'ok', 'conflict', 'error')),
  CONSTRAINT channel_inventory_push_states_error_present
    CHECK ((last_status IN ('conflict', 'error')) = (last_error IS NOT NULL)),
  CONSTRAINT channel_inventory_push_states_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_inventory_push_states_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_inventory_push_states_stock_tenant_fk
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id),
  CONSTRAINT channel_inventory_push_states_item_tenant_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_inventory_push_states_pair_unique
  ON public.channel_inventory_push_states (org_id, channel_id, stock_location_id, item_id);
CREATE INDEX channel_inventory_push_states_stale_scan
  ON public.channel_inventory_push_states (org_id, channel_id, last_pushed_at);

ALTER TABLE public.channel_inventory_push_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_inventory_push_states FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_inventory_push_states
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_inventory_push_states IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_inventory_push_states IS
  'Last-pushed storefront quantity per mapped channel, stock location and item: the compare baseline that keeps an outside change from being overwritten.';

-- Quantities the storefront changed outside OpenBooks, awaiting the
-- operator: push ours or accept theirs. Resolutions are terminal and
-- audited; a new outside change opens a fresh row.
CREATE TABLE public.channel_inventory_conflicts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  item_id uuid NOT NULL,
  openbooks_quantity integer NOT NULL,
  shopify_quantity integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT channel_inventory_conflicts_pkey PRIMARY KEY (id),
  CONSTRAINT channel_inventory_conflicts_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT channel_inventory_conflicts_status_valid
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT channel_inventory_conflicts_resolution_valid
    CHECK (resolution IS NULL OR resolution IN ('pushed_openbooks', 'accepted_shopify')),
  CONSTRAINT channel_inventory_conflicts_resolution_present
    CHECK ((status = 'resolved') = (resolution IS NOT NULL)),
  CONSTRAINT channel_inventory_conflicts_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT channel_inventory_conflicts_channel_tenant_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES public.sales_channels(org_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_inventory_conflicts_stock_tenant_fk
    FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id),
  CONSTRAINT channel_inventory_conflicts_item_tenant_fk
    FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_inventory_conflicts_open_unique
  ON public.channel_inventory_conflicts (org_id, channel_id, stock_location_id, item_id)
  WHERE status = 'open';
CREATE INDEX channel_inventory_conflicts_channel_scan
  ON public.channel_inventory_conflicts (org_id, channel_id, status);

ALTER TABLE public.channel_inventory_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_inventory_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.channel_inventory_conflicts
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON POLICY org_isolation ON public.channel_inventory_conflicts IS 'openbooks:org_isolation:v1';
COMMENT ON TABLE public.channel_inventory_conflicts IS
  'Storefront quantities changed outside OpenBooks: one open row per mapped pair, resolved by pushing ours or accepting theirs, never by silent overwrite.';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_item_inventory_policies', '0531_channel_inventory_sync')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_inventory_push_states', '0531_channel_inventory_sync')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('channel_inventory_conflicts', '0531_channel_inventory_sync')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
