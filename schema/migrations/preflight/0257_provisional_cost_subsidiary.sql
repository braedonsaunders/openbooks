-- OpenBooks upgrade preflight for 0257_provisional_cost_subsidiary.
--
-- Read-only mirror of the migration's ownerless-deficit refusal, expressed
-- without the subsidiary_id column the migration itself adds: every deficit
-- is born by exactly one issue movement, which has carried its legal entity
-- since 0020. A deficit whose movement is missing has no truthful owner.
-- Zero rows means ready for 0257.
SELECT '0257.ownerless_deficit' AS code,
       'refuse' AS severity,
       format('inventory_provisional_costs row %s (org %s item %s location %s) names a missing issue movement %s',
              pc.id, pc.org_id, pc.item_id, pc.stock_location_id, pc.issue_movement_id) AS subject,
       format('no inventory_movements row (org %s, id %s) exists to derive the owning subsidiary from',
              pc.org_id, pc.issue_movement_id) AS detail,
       'Attribute each row to its owning subsidiary (or confirm the rows are stray and remove them) before this constraint can be installed.' AS remedy
  FROM public.inventory_provisional_costs pc
  LEFT JOIN public.inventory_movements m
    ON m.id = pc.issue_movement_id AND m.org_id = pc.org_id
 WHERE m.id IS NULL
 ORDER BY pc.org_id, pc.id
 LIMIT 20;
