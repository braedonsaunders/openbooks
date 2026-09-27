-- OpenBooks forward migration 0430_manufacturing_work_orders_and_scrap.
-- Add auditable work-order snapshots, execution records, and coded scrap.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.mfg_scrap_reasons (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  classification text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_scrap_reasons_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_scrap_reasons_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_scrap_reasons_org_code_unique UNIQUE (org_id, code),
  CONSTRAINT mfg_scrap_reasons_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_scrap_reasons_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_scrap_reasons_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_scrap_reasons_classification_check
    CHECK (classification IN ('normal', 'abnormal')),
  CONSTRAINT mfg_scrap_reasons_labels_nonempty
    CHECK (length(btrim(code)) > 0 AND length(btrim(name)) > 0)
);

CREATE INDEX mfg_scrap_reasons_org_active
  ON public.mfg_scrap_reasons (org_id, is_active, code);

ALTER TABLE public.mfg_scrap_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_scrap_reasons FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_scrap_reasons
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_work_orders (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  number text NOT NULL,
  produced_item_id uuid NOT NULL,
  routing_id uuid,
  bom_revision text,
  routing_version integer,
  quantity_ordered numeric(19,4) NOT NULL,
  quantity_completed numeric(19,4) DEFAULT 0 NOT NULL,
  quantity_scrapped numeric(19,4) DEFAULT 0 NOT NULL,
  unit text NOT NULL,
  status text DEFAULT 'draft'::text NOT NULL,
  priority text DEFAULT 'normal'::text NOT NULL,
  source text DEFAULT 'manual'::text NOT NULL,
  source_ref_id uuid,
  parent_wo_id uuid,
  short_close_reason text,
  subsidiary_id uuid,
  issue_location_id uuid,
  receipt_location_id uuid,
  planned_start date,
  planned_end date,
  released_at timestamp with time zone,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  closed_at timestamp with time zone,
  hold_reason text,
  cancel_reason text,
  standard_cost_snapshot numeric(19,4),
  cost_collected numeric(19,4) DEFAULT 0 NOT NULL,
  custom jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_work_orders_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_work_orders_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_work_orders_org_number_unique UNIQUE (org_id, number),
  CONSTRAINT mfg_work_orders_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_work_orders_item_fk
    FOREIGN KEY (org_id, produced_item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_routing_fk
    FOREIGN KEY (org_id, routing_id)
    REFERENCES public.mfg_routings(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_parent_fk
    FOREIGN KEY (org_id, parent_wo_id)
    REFERENCES public.mfg_work_orders(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_issue_location_fk
    FOREIGN KEY (org_id, issue_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_receipt_location_fk
    FOREIGN KEY (org_id, receipt_location_id)
    REFERENCES public.stock_locations(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_work_orders_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_orders_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_work_orders_source_check
    CHECK (source IN ('manual', 'mrp', 'sales_order', 'parent')),
  CONSTRAINT mfg_work_orders_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'rush')),
  CONSTRAINT mfg_work_orders_status_check
    CHECK (status IN ('draft', 'released', 'in_progress', 'on_hold', 'done', 'closed', 'cancelled')),
  CONSTRAINT mfg_work_orders_source_reference
    CHECK ((source = 'manual' AND source_ref_id IS NULL)
        OR (source <> 'manual' AND source_ref_id IS NOT NULL)),
  CONSTRAINT mfg_work_orders_parent_reference
    CHECK ((source = 'parent' AND parent_wo_id IS NOT NULL)
        OR (source <> 'parent' AND parent_wo_id IS NULL)),
  CONSTRAINT mfg_work_orders_quantities_nonnegative
    CHECK (quantity_ordered >= 0 AND quantity_completed >= 0 AND quantity_scrapped >= 0),
  CONSTRAINT mfg_work_orders_costs_nonnegative
    CHECK (cost_collected >= 0 AND (standard_cost_snapshot IS NULL OR standard_cost_snapshot >= 0)),
  CONSTRAINT mfg_work_orders_routing_version_positive
    CHECK (routing_version IS NULL OR routing_version > 0),
  CONSTRAINT mfg_work_orders_hold_reason
    CHECK (status <> 'on_hold' OR (hold_reason IS NOT NULL AND length(btrim(hold_reason)) > 0)),
  CONSTRAINT mfg_work_orders_short_close_reason
    CHECK (status <> 'closed' OR quantity_completed >= quantity_ordered
        OR (short_close_reason IS NOT NULL AND length(btrim(short_close_reason)) > 0)),
  CONSTRAINT mfg_work_orders_dates_ordered
    CHECK (planned_end IS NULL OR planned_start IS NULL OR planned_end >= planned_start),
  CONSTRAINT mfg_work_orders_labels_nonempty
    CHECK (length(btrim(number)) > 0 AND length(btrim(unit)) > 0)
);

CREATE INDEX mfg_work_orders_org_status_start
  ON public.mfg_work_orders (org_id, status, planned_start);

ALTER TABLE public.mfg_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_work_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_work_orders
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_wo_operations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  sequence integer NOT NULL,
  name text NOT NULL,
  work_center_id uuid NOT NULL,
  planned_setup_minutes numeric(19,4) NOT NULL,
  planned_run_minutes numeric(19,4) NOT NULL,
  actual_setup_minutes numeric(19,4),
  actual_run_minutes numeric(19,4),
  actual_labor_minutes numeric(19,4),
  quantity_planned numeric(19,4) NOT NULL,
  quantity_done numeric(19,4) DEFAULT 0 NOT NULL,
  quantity_scrapped_here numeric(19,4) DEFAULT 0 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  operator_user_id uuid,
  pause_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  measured_qty numeric(19,4),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_wo_operations_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_wo_operations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_wo_operations_org_order_id_unique UNIQUE (org_id, work_order_id, id),
  CONSTRAINT mfg_wo_operations_order_sequence_unique
    UNIQUE (org_id, work_order_id, sequence),
  CONSTRAINT mfg_wo_operations_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_wo_operations_work_order_fk
    FOREIGN KEY (org_id, work_order_id)
    REFERENCES public.mfg_work_orders(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_operations_center_fk
    FOREIGN KEY (org_id, work_center_id)
    REFERENCES public.mfg_work_centers(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_operations_operator_fk
    FOREIGN KEY (operator_user_id) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_operations_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_operations_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_operations_status_check
    CHECK (status IN ('pending', 'running', 'paused', 'done')),
  CONSTRAINT mfg_wo_operations_sequence_positive CHECK (sequence > 0),
  CONSTRAINT mfg_wo_operations_minutes_nonnegative
    CHECK (planned_setup_minutes >= 0 AND planned_run_minutes >= 0
       AND (actual_setup_minutes IS NULL OR actual_setup_minutes >= 0)
       AND (actual_run_minutes IS NULL OR actual_run_minutes >= 0)
       AND (actual_labor_minutes IS NULL OR actual_labor_minutes >= 0)),
  CONSTRAINT mfg_wo_operations_quantities_nonnegative
    CHECK (quantity_planned >= 0 AND quantity_done >= 0 AND quantity_scrapped_here >= 0
       AND (measured_qty IS NULL OR measured_qty >= 0)),
  CONSTRAINT mfg_wo_operations_pause_reason
    CHECK (status <> 'paused' OR (pause_reason IS NOT NULL AND length(btrim(pause_reason)) > 0)),
  CONSTRAINT mfg_wo_operations_name_nonempty CHECK (length(btrim(name)) > 0)
);

CREATE INDEX mfg_wo_operations_org_center
  ON public.mfg_wo_operations (org_id, work_center_id, work_order_id);

ALTER TABLE public.mfg_wo_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_wo_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_wo_operations
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_wo_materials (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  component_item_id uuid NOT NULL,
  required_qty numeric(19,4) NOT NULL,
  issued_qty numeric(19,4) DEFAULT 0 NOT NULL,
  backflush_qty numeric(19,4) DEFAULT 0 NOT NULL,
  operation_seq integer,
  lot_serial_policy text NOT NULL,
  shortage_qty numeric(19,4) DEFAULT 0 NOT NULL,
  waived_at timestamp with time zone,
  waived_by uuid,
  waive_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_wo_materials_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_wo_materials_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_wo_materials_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_wo_materials_work_order_fk
    FOREIGN KEY (org_id, work_order_id)
    REFERENCES public.mfg_work_orders(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_materials_item_fk
    FOREIGN KEY (org_id, component_item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_materials_waived_by_fk
    FOREIGN KEY (waived_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_materials_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_materials_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_materials_quantities_nonnegative
    CHECK (required_qty >= 0 AND issued_qty >= 0 AND backflush_qty >= 0 AND shortage_qty >= 0),
  CONSTRAINT mfg_wo_materials_operation_sequence
    CHECK (operation_seq IS NULL OR operation_seq > 0),
  CONSTRAINT mfg_wo_materials_tracking_check
    CHECK (lot_serial_policy IN ('none', 'lot', 'serial')),
  CONSTRAINT mfg_wo_materials_waiver_evidence
    CHECK ((waived_at IS NULL AND waived_by IS NULL AND waive_reason IS NULL)
        OR (waived_at IS NOT NULL AND waived_by IS NOT NULL
            AND waive_reason IS NOT NULL AND length(btrim(waive_reason)) > 0))
);

CREATE INDEX mfg_wo_materials_org_order
  ON public.mfg_wo_materials (org_id, work_order_id, component_item_id);

ALTER TABLE public.mfg_wo_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_wo_materials FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_wo_materials
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.mfg_scrap_events (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  operation_id uuid,
  component_item_id uuid,
  quantity numeric(19,4) NOT NULL,
  reason_id uuid NOT NULL,
  classification text NOT NULL,
  posted_entry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_scrap_events_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_scrap_events_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_scrap_events_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_scrap_events_work_order_fk
    FOREIGN KEY (org_id, work_order_id)
    REFERENCES public.mfg_work_orders(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_scrap_events_operation_fk
    FOREIGN KEY (org_id, work_order_id, operation_id)
    REFERENCES public.mfg_wo_operations(org_id, work_order_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_scrap_events_component_fk
    FOREIGN KEY (org_id, component_item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_scrap_events_reason_fk
    FOREIGN KEY (org_id, reason_id)
    REFERENCES public.mfg_scrap_reasons(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_scrap_events_entry_fk
    FOREIGN KEY (org_id, posted_entry_id)
    REFERENCES public.journal_entries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_scrap_events_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_scrap_events_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_scrap_events_quantity_nonnegative CHECK (quantity >= 0),
  CONSTRAINT mfg_scrap_events_classification_check
    CHECK (classification IN ('normal', 'abnormal'))
);

CREATE INDEX mfg_scrap_events_org_order
  ON public.mfg_scrap_events (org_id, work_order_id, created_at);

ALTER TABLE public.mfg_scrap_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_scrap_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_scrap_events
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
