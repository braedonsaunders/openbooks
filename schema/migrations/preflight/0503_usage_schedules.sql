SELECT '0503.table_collision' AS code,'refuse' AS severity,table_name::text AS subject,
 'A usage schedule table already exists and migration 0503 would collide with it.' AS detail,
 'Rename or drop the conflicting table before applying the usage schedule migration.' AS remedy
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('usage_rating_settings', 'stripe_billing_import_schedules', 'stripe_billing_link_skips');
