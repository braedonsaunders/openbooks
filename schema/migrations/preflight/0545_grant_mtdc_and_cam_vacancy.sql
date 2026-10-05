SELECT '0545.mtdc_exclusions_unconfigured' AS code, 'notice' AS severity, g.code::text AS subject,
 'This grant measures indirect costs on modified total direct costs but has no excluded-cost account group; reimbursements will be refused until one is named.' AS detail,
 'After the upgrade, open the grant and choose the account group holding its excluded costs (an empty group if nothing is excluded), plus any subaward group and threshold.' AS remedy
FROM public.grants g
WHERE g.indirect_base = 'modified_total_direct'
  AND g.status NOT IN ('closed', 'void')
UNION ALL
SELECT '0545.cam_vacancy_occupied_area' AS code, 'notice' AS severity, p.name::text AS subject,
 'This rentable-area CAM pool is recorded as sharing vacant area among occupied leases, which is how it has been allocated so far.' AS detail,
 'After the upgrade, review the pool''s vacancy treatment and choose total rentable area if the landlord absorbs vacant space.' AS remedy
FROM public.cam_pools p
WHERE p.allocation_basis = 'rentable_area'
  AND p.status IN ('draft', 'open');
