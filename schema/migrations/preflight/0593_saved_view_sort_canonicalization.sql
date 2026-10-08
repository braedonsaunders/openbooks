SELECT '0593.saved_view_sort_shape' AS code, 'refuse' AS severity,
       id::text AS subject,
       'The saved view has malformed query or sort configuration.' AS detail,
       'Preserve the saved view and repair its query configuration before upgrading; do not delete it or discard its sort terms.' AS remedy
  FROM public.saved_views
 WHERE jsonb_typeof(query) IS DISTINCT FROM 'object'
    OR (query ? 'sorts' AND jsonb_typeof(query->'sorts') NOT IN ('array', 'null'))
    OR (query->'sort' IS NOT NULL AND query->'sort' <> 'null'::jsonb
        AND (jsonb_typeof(query->'sort') IS DISTINCT FROM 'object'
             OR jsonb_typeof(query->'sort'->'column') IS DISTINCT FROM 'string'))
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(query->'sorts') = 'array' THEN query->'sorts' ELSE '[]'::jsonb END
      ) term
       WHERE jsonb_typeof(term) IS DISTINCT FROM 'object'
          OR jsonb_typeof(term->'column') IS DISTINCT FROM 'string'
    );
