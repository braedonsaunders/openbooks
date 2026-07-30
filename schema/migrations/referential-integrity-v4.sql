BEGIN;

-- environments.sql makes every FK deferrable for deterministic sandbox clones.
-- Constraints that differed only by deferrability can become semantic
-- duplicates at that point, so run the same evidence-preserving deduplication
-- once more after the environment/RLS migration.
DO $$
DECLARE
  duplicate record;
BEGIN
  FOR duplicate IN
    WITH ranked AS (
      SELECT constraint_row.conrelid,
             constraint_row.conname,
             regexp_replace(
               pg_get_constraintdef(constraint_row.oid, true),
               ' NOT VALID$',
               ''
             ) AS semantic_definition,
             first_value(constraint_row.conname) OVER (
               PARTITION BY
                 constraint_row.conrelid,
                 regexp_replace(
                   pg_get_constraintdef(constraint_row.oid, true),
                   ' NOT VALID$',
                   ''
                 )
               ORDER BY
                 constraint_row.convalidated DESC,
                 length(constraint_row.conname),
                 constraint_row.conname
             ) AS kept_constraint,
             row_number() OVER (
               PARTITION BY
                 constraint_row.conrelid,
                 regexp_replace(
                   pg_get_constraintdef(constraint_row.oid, true),
                   ' NOT VALID$',
                   ''
                 )
               ORDER BY
                 constraint_row.convalidated DESC,
                 length(constraint_row.conname),
                 constraint_row.conname
             ) AS semantic_rank
        FROM pg_constraint constraint_row
        JOIN pg_namespace namespace_row
          ON namespace_row.oid = constraint_row.connamespace
       WHERE namespace_row.nspname = 'public'
         AND constraint_row.contype = 'f'
         AND constraint_row.conrelid <> 0
    )
    SELECT conrelid::regclass AS relation_name,
           conname AS dropped_constraint,
           kept_constraint,
           semantic_definition
      FROM ranked
     WHERE semantic_rank > 1
     ORDER BY conrelid::regclass::text, conname
  LOOP
    INSERT INTO _migration_schema_convergence (
      migration_filename,
      relation_name,
      dropped_constraint,
      kept_constraint,
      definition
    )
    VALUES (
      'referential-integrity-v4.sql',
      duplicate.relation_name::text,
      duplicate.dropped_constraint,
      duplicate.kept_constraint,
      duplicate.semantic_definition
    )
    ON CONFLICT DO NOTHING;
    EXECUTE format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      duplicate.relation_name,
      duplicate.dropped_constraint
    );
  END LOOP;
END
$$;

COMMIT;
