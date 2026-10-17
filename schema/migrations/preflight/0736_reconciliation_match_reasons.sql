WITH findings AS (
 SELECT '0736.match_reasons_column_exists'::text AS code,
  'Reconciliation match reasons exist without this migration being recorded'::text AS subject,
  'The migration adds the nullable match_reasons column and its array-shape check to reconciliation_matches.'::text AS detail,
  'Preserve the column, its constraint and every match row; compare them with the reviewed migration and obtain the database owner’s approval before reconciliation.'::text AS remedy
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('public.reconciliation_matches') AND attname = 'match_reasons' AND NOT attisdropped)
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
   WHERE conrelid = to_regclass('public.reconciliation_matches') AND conname = 'reconciliation_matches_reasons_shape')
 UNION ALL
 SELECT '0736.matches_table_missing','The reconciliation matches table this migration extends is unavailable',
  'The migration adds a column to reconciliation_matches, created by the published baseline.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all reconciliation history.'
 WHERE to_regclass('public.reconciliation_matches') IS NULL
 UNION ALL
 SELECT '0736.query_catalog_missing','The query catalog refresh is unavailable',
  'The migration refreshes the query catalog after adding the column.',
  'Install the published baseline migrations through the authorized native migration runner; preserve all reconciliation history.'
 WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL
)
SELECT code,'refuse'::text AS severity,subject,detail,remedy FROM findings;
