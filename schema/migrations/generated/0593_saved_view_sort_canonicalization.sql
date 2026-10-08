-- Preserve saved-view ordering while adopting the shared ordered sort model.
-- Query representation changes retain owner, visibility and edit provenance.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM saved_views
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
        )
  ) THEN
    RAISE EXCEPTION 'Saved views contain malformed sort configuration; preserve the records and repair their query configuration before upgrading';
  END IF;
END;
$$;

WITH candidates AS MATERIALIZED (
  SELECT id, org_id, query AS before_query,
         CASE
           WHEN CASE WHEN jsonb_typeof(query->'sorts') = 'array' THEN jsonb_array_length(query->'sorts') > 0 ELSE false END
             THEN query - 'sort'
           WHEN query->'sort' IS NOT NULL AND query->'sort' <> 'null'::jsonb
             THEN (query - 'sort' - 'sorts') || jsonb_build_object('sorts', jsonb_build_array(query->'sort'))
           WHEN query->'sorts' = 'null'::jsonb THEN query - 'sort' - 'sorts'
           ELSE query - 'sort'
         END AS after_query
    FROM saved_views
   WHERE query ? 'sort' OR query->'sorts' = 'null'::jsonb
   FOR UPDATE
), changed AS (
  UPDATE saved_views v SET query = c.after_query
    FROM candidates c
   WHERE v.org_id = c.org_id AND v.id = c.id AND v.query IS DISTINCT FROM c.after_query
  RETURNING v.org_id, v.id, c.before_query, v.query AS after_query
)
INSERT INTO audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'saved_views', id, 'update',
       jsonb_build_object(
         'before', jsonb_build_object('query', before_query),
         'after', jsonb_build_object('query', after_query),
         'reason', 'Canonical report sort representation; saved-view ordering and visibility preserved'
       ), NULL
  FROM changed;

ALTER TABLE saved_views ADD CONSTRAINT saved_views_canonical_sort_model CHECK (
  jsonb_typeof(query) = 'object'
  AND NOT (query ? 'sort')
  AND (NOT (query ? 'sorts') OR jsonb_typeof(query->'sorts') = 'array')
);
