BEGIN;

-- The flattened baseline contains some newer foreign keys that also remain in
-- the authoritative referential-integrity map for upgrade compatibility. A
-- zero-state install therefore used to create two equivalent constraints.
-- Keep one validated constraint per semantic FK and remove only redundant
-- catalog objects; no relationship or tenant data is removed.
CREATE TABLE IF NOT EXISTS _migration_schema_convergence (
  migration_filename text NOT NULL,
  relation_name text NOT NULL,
  dropped_constraint text NOT NULL,
  kept_constraint text NOT NULL,
  definition text NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_filename, relation_name, dropped_constraint)
);

DO $$
DECLARE
  duplicate record;
BEGIN
  FOR duplicate IN
    WITH ranked AS (
      SELECT constraint_row.oid,
             constraint_row.conrelid,
             constraint_row.conname,
             constraint_row.convalidated,
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
      'referential-integrity-v3.sql',
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
