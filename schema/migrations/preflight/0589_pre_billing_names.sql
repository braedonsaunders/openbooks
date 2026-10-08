SELECT '0589.pre_billing_relation_collision' AS code, 'refuse' AS severity,
       name AS subject,
       'The target Pre-billing relation already exists before its rename migration.' AS detail,
       'Preserve both objects and ask the database owner to reconcile their schemas and migration identities before upgrading.' AS remedy
  FROM unnest(ARRAY['prebills','prebill_lines','prebill_events','prebill_holds']) name
 WHERE to_regclass('public.' || name) IS NOT NULL
UNION ALL
SELECT '0589.pre_billing_feature_conflict', 'refuse', id::text,
       'The legacy and Pre-billing feature settings have different values.',
       'Reconcile the organization feature configuration before upgrading; neither value will be overwritten.'
  FROM public.orgs
 WHERE settings->'features' ? 'wipBilling' AND settings->'features' ? 'preBilling'
   AND settings->'features'->'wipBilling' IS DISTINCT FROM settings->'features'->'preBilling';
