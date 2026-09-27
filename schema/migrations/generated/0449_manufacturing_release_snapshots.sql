-- Freeze manufacturing execution rules and by-products when a work order is released.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.mfg_wo_operations
  ADD COLUMN quality_gate text,
  ADD COLUMN backflush_at text;

ALTER TABLE public.mfg_wo_materials
  ADD COLUMN quantity_per numeric(19,4),
  ADD COLUMN scrap_pct numeric(19,4) DEFAULT 0;

ALTER TABLE public.mfg_work_orders
  ADD COLUMN hold_prior_status text;

CREATE TABLE public.mfg_wo_byproducts (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity_per numeric(19,4) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT mfg_wo_byproducts_pkey PRIMARY KEY (id),
  CONSTRAINT mfg_wo_byproducts_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT mfg_wo_byproducts_org_work_order_item_unique UNIQUE (org_id, work_order_id, item_id),
  CONSTRAINT mfg_wo_byproducts_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT mfg_wo_byproducts_work_order_fk
    FOREIGN KEY (org_id, work_order_id)
    REFERENCES public.mfg_work_orders(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_byproducts_item_fk
    FOREIGN KEY (org_id, item_id)
    REFERENCES public.items(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT mfg_wo_byproducts_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_byproducts_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT mfg_wo_byproducts_quantity_nonnegative CHECK (quantity_per >= 0)
);

ALTER TABLE public.mfg_wo_byproducts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfg_wo_byproducts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.mfg_wo_byproducts
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

WITH snapshots AS (
  SELECT DISTINCT ON (org_id, row_id) org_id, row_id, changes
    FROM public.audit_log
   WHERE table_name = 'mfg_wo_operations' AND action = 'insert'
   ORDER BY org_id, row_id, at, id
)
UPDATE public.mfg_wo_operations operation
   SET quality_gate = snapshots.changes->'after'->>'qualityGate',
       backflush_at = snapshots.changes->'after'->>'backflushAt'
  FROM snapshots
 WHERE snapshots.org_id = operation.org_id AND snapshots.row_id = operation.id;

WITH snapshots AS (
  SELECT DISTINCT ON (org_id, row_id) org_id, row_id, changes
    FROM public.audit_log
   WHERE table_name = 'mfg_wo_materials' AND action = 'insert'
   ORDER BY org_id, row_id, at, id
)
UPDATE public.mfg_wo_materials material
   SET quantity_per = (snapshots.changes->'after'->>'quantityPer')::numeric(19,4),
       scrap_pct = coalesce((snapshots.changes->'after'->>'scrapPct')::numeric(19,4), 0)
  FROM snapshots
 WHERE snapshots.org_id = material.org_id AND snapshots.row_id = material.id;

WITH hold_events AS (
  SELECT DISTINCT ON (org_id, row_id) org_id, row_id, changes
    FROM public.audit_log
   WHERE table_name = 'mfg_work_orders'
     AND action = 'update'
     AND changes->'after'->>'status' = 'on_hold'
   ORDER BY org_id, row_id, at DESC, id DESC
)
UPDATE public.mfg_work_orders work_order
   SET hold_prior_status = hold_events.changes->'before'->>'status'
  FROM hold_events
 WHERE hold_events.org_id = work_order.org_id AND hold_events.row_id = work_order.id
   AND work_order.status = 'on_hold';

ALTER TABLE public.mfg_wo_operations
  ALTER COLUMN quality_gate SET NOT NULL,
  ALTER COLUMN backflush_at SET NOT NULL;
ALTER TABLE ONLY public.mfg_wo_operations
  ADD CONSTRAINT mfg_wo_operations_quality_gate_check
    CHECK (quality_gate IN ('none', 'measure')),
  ADD CONSTRAINT mfg_wo_operations_backflush_check
    CHECK (backflush_at IN ('none', 'start', 'finish'));

ALTER TABLE public.mfg_wo_materials
  ALTER COLUMN quantity_per SET NOT NULL,
  ALTER COLUMN scrap_pct SET DEFAULT 0,
  ALTER COLUMN scrap_pct SET NOT NULL;
ALTER TABLE ONLY public.mfg_wo_materials
  ADD CONSTRAINT mfg_wo_materials_quantity_per_nonnegative CHECK (quantity_per >= 0),
  ADD CONSTRAINT mfg_wo_materials_scrap_pct_check CHECK (scrap_pct >= 0 AND scrap_pct < 100);

ALTER TABLE ONLY public.mfg_work_orders
  ADD CONSTRAINT mfg_work_orders_hold_prior_status_check
    CHECK (hold_prior_status IS NULL OR hold_prior_status IN ('released', 'in_progress')),
  ADD CONSTRAINT mfg_work_orders_hold_prior_status_state_check
    CHECK ((status = 'on_hold') = (hold_prior_status IS NOT NULL));

WITH work_orders AS (
  SELECT id, org_id, produced_item_id, bom_revision, coalesce(planned_start, released_at::date) AS as_of,
         released_at, created_by
    FROM public.mfg_work_orders
   WHERE bom_revision IS NOT NULL
), bom_rows AS (
  SELECT work_order.id AS work_order_id, work_order.org_id, work_order.produced_item_id,
         work_order.bom_revision, work_order.released_at, work_order.created_by,
         component.id AS component_row_id, component.component_item_id, component.quantity_per,
         component.sort_order, component.effective_from, component.effective_to,
         component.operation_seq, component.scrap_pct, component.is_byproduct,
         jsonb_strip_nulls(jsonb_build_object(
           'componentItemId', component.component_item_id::text,
           'effectiveFrom', component.effective_from::text,
           'effectiveTo', component.effective_to::text,
           'operationSeq', component.operation_seq,
           'quantityPer', component.quantity_per::numeric(19,4)::text,
           'scrapPct', CASE WHEN component.scrap_pct IS NOT NULL AND component.scrap_pct <> 0
                            THEN component.scrap_pct::numeric(19,4)::text END,
           'sortOrder', component.sort_order
         )) AS revision_row
    FROM work_orders work_order
    JOIN public.bom_components component
      ON component.org_id = work_order.org_id
     AND component.assembly_item_id = work_order.produced_item_id
     AND (component.effective_from IS NULL OR component.effective_from <= work_order.as_of)
     AND (component.effective_to IS NULL OR work_order.as_of < component.effective_to)
), resolved_revisions AS (
  SELECT bom_rows.work_order_id, bom_rows.org_id, bom_rows.bom_revision,
         bom_rows.released_at, bom_rows.created_by,
         'sha256:' || encode(public.digest(convert_to(
           replace(replace(jsonb_build_object(
             'assemblyItemId', bom_rows.produced_item_id::text,
             'components', jsonb_agg(bom_rows.revision_row ORDER BY bom_rows.sort_order,
               bom_rows.component_item_id, bom_rows.operation_seq NULLS FIRST,
               bom_rows.is_byproduct, bom_rows.effective_from NULLS FIRST),
             'format', 'openbooks.inventory-bom.v1'
           )::text, ': ', ':'), ', ', ','), 'UTF8'), 'sha256'), 'hex') AS calculated_revision
    FROM bom_rows
   GROUP BY bom_rows.work_order_id, bom_rows.org_id, bom_rows.bom_revision,
            bom_rows.released_at, bom_rows.created_by, bom_rows.produced_item_id
), release_actors AS (
  SELECT DISTINCT ON (org_id, row_id) org_id, row_id, actor_id, at
    FROM public.audit_log
   WHERE table_name = 'mfg_work_orders' AND action = 'update'
     AND changes->'after'->>'status' IN ('released', 'in_progress', 'on_hold', 'done', 'closed')
   ORDER BY org_id, row_id, at, id
)
INSERT INTO public.mfg_wo_byproducts (
  org_id, work_order_id, item_id, quantity_per, created_at, created_by, updated_at, updated_by
)
SELECT resolved.org_id, resolved.work_order_id, bom.component_item_id,
       sum(bom.quantity_per)::numeric(19,4), coalesce(actor.at, resolved.released_at, now()),
       coalesce(actor.actor_id, resolved.created_by), coalesce(actor.at, resolved.released_at, now()),
       coalesce(actor.actor_id, resolved.created_by)
  FROM resolved_revisions resolved
  JOIN bom_rows bom ON bom.work_order_id = resolved.work_order_id AND bom.is_byproduct
  LEFT JOIN release_actors actor ON actor.org_id = resolved.org_id AND actor.row_id = resolved.work_order_id
 WHERE resolved.bom_revision = resolved.calculated_revision
 GROUP BY resolved.org_id, resolved.work_order_id, bom.component_item_id,
          actor.at, resolved.released_at, actor.actor_id, resolved.created_by;

-- Conflicts on replay are expected because the registry owns one row per relation.
INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('mfg_wo_byproducts', '0449')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
