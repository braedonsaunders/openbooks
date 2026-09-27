-- OpenBooks upgrade preflight for 0419_warehouses.
--
-- 0419 adds a unique warehouse code per organization and refuses a warehouse
-- nested inside another warehouse. Either condition in existing data would
-- stop the migration, so both are named here first. Zero rows means ready.
WITH RECURSIVE chain AS (
  SELECT w.org_id, w.id AS warehouse_id, w.code AS warehouse_code,
         w.parent_id AS ancestor_id, 1 AS depth
    FROM public.stock_locations w
   WHERE w.kind = 'warehouse' AND w.parent_id IS NOT NULL
  UNION ALL
  SELECT c.org_id, c.warehouse_id, c.warehouse_code, p.parent_id, c.depth + 1
    FROM chain c
    JOIN public.stock_locations p ON p.id = c.ancestor_id AND p.org_id = c.org_id
   WHERE p.kind <> 'warehouse' AND p.parent_id IS NOT NULL AND c.depth < 64
)
SELECT '0419.duplicate_warehouse_code' AS code,
       'refuse' AS severity,
       'organization ' || sl.org_id::text AS subject,
       'warehouse code ' || sl.code || ' is used by ' || count(*)::text || ' warehouse-kind stock locations' AS detail,
       'Rename all but one of these warehouse-kind stock locations in Setup → Stock locations so each warehouse code is unique, then upgrade.' AS remedy
  FROM public.stock_locations sl
 WHERE sl.kind = 'warehouse'
 GROUP BY sl.org_id, sl.code
HAVING count(*) > 1
UNION ALL
SELECT '0419.nested_warehouse' AS code,
       'refuse' AS severity,
       'stock location ' || c.warehouse_id::text AS subject,
       'warehouse ' || c.warehouse_code || ' sits inside warehouse ' || a.code AS detail,
       'Change the inner location''s kind to zone, or move it out from under the outer warehouse, in Setup → Stock locations, then upgrade.' AS remedy
  FROM chain c
  JOIN public.stock_locations a ON a.id = c.ancestor_id AND a.org_id = c.org_id
 WHERE a.kind = 'warehouse';
