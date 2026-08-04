BEGIN;

UPDATE report_definitions
   SET query = CASE
         WHEN query ? 'sorts' THEN query - 'sort'
         WHEN query->'sort' IS NULL OR query->'sort' = 'null'::jsonb THEN query - 'sort'
         ELSE (query - 'sort') || jsonb_build_object('sorts', jsonb_build_array(query->'sort'))
       END,
       updated_at = now()
 WHERE query ? 'sort';

UPDATE report_definitions
   SET query = query - 'sorts',
       updated_at = now()
 WHERE query->'sorts' = 'null'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM report_definitions
     WHERE report_type = 'query'
       AND (
         query IS NULL
         OR query ? 'sort'
         OR (query ? 'sorts' AND jsonb_typeof(query->'sorts') <> 'array')
       )
  ) THEN
    RAISE EXCEPTION 'query report definitions must use the canonical ordered sorts model';
  END IF;
END;
$$;

ALTER TABLE report_definitions
  ADD CONSTRAINT report_definitions_canonical_sort_model
  CHECK (
    report_type <> 'query'
    OR (
      query IS NOT NULL
      AND NOT (query ? 'sort')
      AND (NOT (query ? 'sorts') OR jsonb_typeof(query->'sorts') = 'array')
    )
  );

COMMIT;
