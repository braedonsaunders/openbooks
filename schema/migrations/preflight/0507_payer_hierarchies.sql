SELECT '0507.table_collision' AS code,'refuse' AS severity,table_name::text AS subject,
 'A payer hierarchy table already exists and migration 0507 would collide with it.' AS detail,
 'Rename or drop the conflicting table before applying the payer hierarchy migration.' AS remedy
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('consolidation_groups', 'customer_billing_relationships', 'consolidation_runs')
UNION ALL
SELECT '0507.column_collision' AS code,'refuse' AS severity,(table_name || '.' || column_name)::text AS subject,
 'A payer hierarchy column already exists and migration 0507 would collide with it.' AS detail,
 'Rename or drop the conflicting column before applying the payer hierarchy migration.' AS remedy
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ((table_name = 'subscriptions' AND column_name IN ('bill_to_party_id', 'payer_party_id'))
    OR (table_name = 'document_lines' AND column_name = 'service_party_id'));
