SELECT
  '0436.budget_cell_collision'::text AS code,
  'refuse'::text AS severity,
  bl.scenario_id::text AS subject,
  count(*)::text || ' budget lines share a cell that will include the new extra dimensions column' AS detail,
  'Resolve duplicate budget cells through the budget approval flow before applying this migration.'::text AS remedy
FROM public.budget_lines bl
GROUP BY bl.scenario_id, bl.account_id, bl.period_id, bl.subsidiary_id,
         bl.department_id, bl.project_id, bl.location_id, bl.class_id
HAVING count(*) > 1;
