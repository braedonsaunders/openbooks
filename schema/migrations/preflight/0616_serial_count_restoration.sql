-- Existing observer evidence must resolve before adding its deferred references.
SELECT '0616.count_observer_reference' AS code, 'refuse' AS severity,
       format('count line %s (org %s)', line.id,line.org_id) AS subject,
       'A recorded first or second observer is absent or belongs to another organization.' AS detail,
       'Preserve the original count evidence and reconcile its observer identity through the database owner before upgrading.' AS remedy
  FROM public.stock_count_lines line
 WHERE ((to_jsonb(line)->>'first_counted_by')::uuid IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.users observer WHERE observer.id=(to_jsonb(line)->>'first_counted_by')::uuid AND observer.org_id=line.org_id))
    OR ((to_jsonb(line)->>'second_counted_by')::uuid IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM public.users observer WHERE observer.id=(to_jsonb(line)->>'second_counted_by')::uuid AND observer.org_id=line.org_id))
 ORDER BY line.org_id,line.id LIMIT 20;
