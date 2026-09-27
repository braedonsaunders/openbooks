-- Refuse manufacturing rows whose released facts cannot be copied into durable columns.
WITH bom_orders AS (
  SELECT id, org_id, produced_item_id, bom_revision,
         coalesce(planned_start, released_at::date) AS as_of
    FROM public.mfg_work_orders
   WHERE bom_revision IS NOT NULL
), bom_rows AS (
  SELECT work_order.id AS work_order_id, work_order.org_id, work_order.produced_item_id,
         work_order.bom_revision, component.component_item_id, component.quantity_per,
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
    FROM bom_orders work_order
    JOIN public.bom_components component
      ON component.org_id = work_order.org_id
     AND component.assembly_item_id = work_order.produced_item_id
     AND (component.effective_from IS NULL OR component.effective_from <= work_order.as_of)
     AND (component.effective_to IS NULL OR work_order.as_of < component.effective_to)
), resolved_revisions AS (
  SELECT bom_rows.work_order_id, bom_rows.org_id, bom_rows.bom_revision,
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
            bom_rows.produced_item_id
)
SELECT '0449.operation_snapshot_missing' AS code,
       'refuse' AS severity,
       format('operation %s for work order %s', operation.id, operation.work_order_id) AS subject,
       'the release audit snapshot is missing qualityGate or backflushAt' AS detail,
       'Restore the release audit evidence before retrying the upgrade.' AS remedy
  FROM public.mfg_wo_operations operation
  LEFT JOIN LATERAL (
    SELECT changes FROM public.audit_log
     WHERE org_id = operation.org_id AND table_name = 'mfg_wo_operations'
       AND row_id = operation.id AND action = 'insert'
     ORDER BY at, id LIMIT 1
  ) snapshot ON true
 WHERE snapshot.changes IS NULL
    OR NOT (snapshot.changes->'after' ? 'qualityGate')
    OR NOT (snapshot.changes->'after' ? 'backflushAt')
    OR snapshot.changes->'after'->>'qualityGate' NOT IN ('none', 'measure')
    OR snapshot.changes->'after'->>'backflushAt' NOT IN ('none', 'start', 'finish')
UNION ALL
SELECT '0449.material_snapshot_missing', 'refuse',
       format('material %s for work order %s', material.id, material.work_order_id),
       'the release audit snapshot is missing quantityPer',
       'Restore the release audit evidence before retrying the upgrade.'
  FROM public.mfg_wo_materials material
  LEFT JOIN LATERAL (
    SELECT changes FROM public.audit_log
     WHERE org_id = material.org_id AND table_name = 'mfg_wo_materials'
       AND row_id = material.id AND action = 'insert'
     ORDER BY at, id LIMIT 1
  ) snapshot ON true
 WHERE snapshot.changes IS NULL
    OR NOT (snapshot.changes->'after' ? 'quantityPer')
    OR nullif(snapshot.changes->'after'->>'quantityPer', '') IS NULL
    OR nullif(snapshot.changes->'after'->>'quantityPer', '') !~ '^\+?([0-9]+(\.[0-9]+)?|\.[0-9]+)$'
UNION ALL
SELECT '0449.hold_snapshot_missing', 'refuse',
       format('work order %s', work_order.number),
       'the latest hold audit event does not identify a released or in-progress prior status',
       'Restore the hold audit evidence before retrying the upgrade.'
  FROM public.mfg_work_orders work_order
  LEFT JOIN LATERAL (
    SELECT changes FROM public.audit_log
     WHERE org_id = work_order.org_id AND table_name = 'mfg_work_orders'
       AND row_id = work_order.id AND action = 'update'
       AND changes->'after'->>'status' = 'on_hold'
     ORDER BY at DESC, id DESC LIMIT 1
  ) snapshot ON true
 WHERE work_order.status = 'on_hold'
   AND coalesce(snapshot.changes->'before'->>'status', '') NOT IN ('released', 'in_progress')
UNION ALL
SELECT '0449.bom_revision_unresolved', 'refuse',
       format('work order %s', work_order.number),
       'the BOM rows effective at release do not match the recorded BOM revision',
       'Restore the BOM version referenced by the work order before retrying the upgrade.'
  FROM public.mfg_work_orders work_order
  LEFT JOIN resolved_revisions resolved ON resolved.work_order_id = work_order.id
 WHERE work_order.bom_revision IS NOT NULL
   AND (resolved.work_order_id IS NULL OR resolved.bom_revision <> resolved.calculated_revision);
