SELECT '0506.table_collision' AS code,'refuse' AS severity,table_name::text AS subject,
 'A quote-to-cash table already exists and migration 0506 would collide with it.' AS detail,
 'Rename or drop the conflicting table before applying the quote-to-cash migration.' AS remedy
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('quote_to_cash_settings', 'quote_subscription_terms', 'quote_ramp_steps', 'signature_requests');
