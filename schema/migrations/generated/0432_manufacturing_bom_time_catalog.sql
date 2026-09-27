-- OpenBooks forward migration 0432_manufacturing_bom_time_catalog.
-- Add effectivity and manufacturing cost-object links, then refresh governed views.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.bom_components
  ADD COLUMN effective_from date,
  ADD COLUMN effective_to date,
  ADD COLUMN operation_seq integer,
  ADD COLUMN scrap_pct numeric(19,4),
  ADD COLUMN is_byproduct boolean DEFAULT false NOT NULL;

ALTER TABLE ONLY public.bom_components
  ADD CONSTRAINT bom_components_effective_range_check
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from);

ALTER TABLE ONLY public.bom_components
  ADD CONSTRAINT bom_components_operation_sequence_check
  CHECK (operation_seq IS NULL OR operation_seq > 0);

ALTER TABLE ONLY public.bom_components
  ADD CONSTRAINT bom_components_scrap_pct_check
  CHECK (scrap_pct IS NULL OR (scrap_pct >= 0 AND scrap_pct < 100));

DROP INDEX public.bom_assembly_component;

ALTER TABLE ONLY public.bom_components
  ADD CONSTRAINT bom_components_effective_identity_excl
  EXCLUDE USING gist (
    org_id WITH =,
    assembly_item_id WITH =,
    component_item_id WITH =,
    (coalesce(operation_seq, -1)) WITH =,
    is_byproduct WITH =,
    (daterange(effective_from, effective_to, '[)')) WITH &&
  );

ALTER TABLE public.time_entries
  ADD COLUMN work_order_id uuid,
  ADD COLUMN wo_operation_id uuid;

ALTER TABLE ONLY public.time_entries
  ADD CONSTRAINT time_entries_work_order_fk
  FOREIGN KEY (org_id, work_order_id)
  REFERENCES public.mfg_work_orders(org_id, id)
  ON DELETE RESTRICT DEFERRABLE;

ALTER TABLE ONLY public.time_entries
  ADD CONSTRAINT time_entries_wo_operation_fk
  FOREIGN KEY (org_id, work_order_id, wo_operation_id)
  REFERENCES public.mfg_wo_operations(org_id, work_order_id, id)
  ON DELETE RESTRICT DEFERRABLE;

ALTER TABLE ONLY public.time_entries
  ADD CONSTRAINT time_entries_one_cost_object_check
  CHECK (project_id IS NULL OR work_order_id IS NULL);

ALTER TABLE ONLY public.time_entries
  ADD CONSTRAINT time_entries_operation_requires_work_order_check
  CHECK (wo_operation_id IS NULL OR work_order_id IS NOT NULL);

CREATE INDEX time_entries_org_work_order
  ON public.time_entries (org_id, work_order_id)
  WHERE work_order_id IS NOT NULL;

-- Conflicts on replay are expected because the registry owns one row per relation.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('mfg_capacity_weeks', '0432'),
  ('mfg_item_policies', '0432'),
  ('mfg_mrp_runs', '0432'),
  ('mfg_planned_orders', '0432'),
  ('mfg_routing_operations', '0432'),
  ('mfg_routings', '0432'),
  ('mfg_scrap_events', '0432'),
  ('mfg_scrap_reasons', '0432'),
  ('mfg_work_center_rates', '0432'),
  ('mfg_work_centers', '0432'),
  ('mfg_work_orders', '0432'),
  ('mfg_wo_materials', '0432'),
  ('mfg_wo_operations', '0432')
ON CONFLICT (relation) DO NOTHING;

SELECT public.openbooks_refresh_query_catalog();
