SELECT
  'allocation_driver_value_overlap'::text AS code,
  'refuse'::text AS severity,
  a.id::text AS subject,
  format('Driver value %s overlaps driver value %s for the same organization, driver, and dimension value.', a.id, b.id) AS detail,
  'Edit or end-date one value so the effective windows no longer overlap, then retry the upgrade.'::text AS remedy
FROM public.allocation_driver_values a
JOIN public.allocation_driver_values b
  ON b.org_id = a.org_id
 AND b.driver_id = a.driver_id
 AND b.dimension_value_id = a.dimension_value_id
 AND b.id::text > a.id::text
 AND daterange(a.effective_from, a.effective_to, '[]')
     && daterange(b.effective_from, b.effective_to, '[]');
