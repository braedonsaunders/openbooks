BEGIN;

-- A time type's semantic class is not its rate multiplier and must never be
-- inferred at runtime from a tenant-editable display name. Preserve the class
-- explicitly both on configuration and on immutable Field Ticket evidence.
ALTER TABLE time_types
  ADD COLUMN IF NOT EXISTS classification text;

WITH classified AS (
  UPDATE time_types
     SET classification = CASE
       WHEN lower(name) LIKE '%double%' THEN 'double_time'
       WHEN lower(name) LIKE '%over%' THEN 'overtime'
       ELSE 'regular'
     END
   WHERE classification IS NULL
  RETURNING org_id, id, name, classification
)
INSERT INTO audit_log
  (org_id, table_name, row_id, action, changes)
SELECT org_id, 'time_types', id, 'update',
       jsonb_build_object(
         'source', 'migration_0076',
         'reason', 'Make time semantics explicit and independent from names and rate multipliers',
         'before', jsonb_build_object('classification', null),
         'after', jsonb_build_object('classification', classification),
         'nameAtMigration', name
       )
  FROM classified;

ALTER TABLE time_types
  ALTER COLUMN classification SET DEFAULT 'regular',
  ALTER COLUMN classification SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'time_types'::regclass
       AND conname = 'time_types_classification_valid'
  ) THEN
    ALTER TABLE time_types
      ADD CONSTRAINT time_types_classification_valid
      CHECK (classification IN ('regular','overtime','double_time','other'));
  END IF;
END
$$;

ALTER TABLE field_ticket_labor_lines
  ADD COLUMN IF NOT EXISTS time_classification text;

-- Existing snapshot lines are append-only evidence. This one-time, fully
-- transactional schema enrichment disables only their retention trigger,
-- fills one new column without changing any prior value, writes one audit
-- envelope per snapshot, and re-enables the guard before commit.
ALTER TABLE field_ticket_labor_lines
  DISABLE TRIGGER field_ticket_labor_line_immutable;

WITH classified AS (
  UPDATE field_ticket_labor_lines line
     SET time_classification = coalesce(
       (
         SELECT time_type.classification
           FROM time_types time_type
          WHERE time_type.id = line.time_type_id
            AND time_type.org_id = line.org_id
       ),
       CASE
         WHEN lower(line.time_type_name) LIKE '%double%' THEN 'double_time'
         WHEN lower(line.time_type_name) LIKE '%over%' THEN 'overtime'
         ELSE 'regular'
       END
     )
   WHERE line.time_classification IS NULL
  RETURNING line.org_id, line.snapshot_id, line.time_classification
)
INSERT INTO audit_log
  (org_id, table_name, row_id, action, changes)
SELECT org_id, 'field_ticket_labor_snapshots', snapshot_id, 'update',
       jsonb_build_object(
         'source', 'migration_0076',
         'event', 'schema_evidence_enrichment',
         'reason', 'Snapshot explicit time semantics without changing hours, rates, provenance, or operational time',
         'classifiedLines', count(*),
         'classifications', jsonb_object_agg(time_classification, class_count)
       )
  FROM (
    SELECT org_id, snapshot_id, time_classification, count(*) AS class_count
      FROM classified
     GROUP BY org_id, snapshot_id, time_classification
  ) counts
 GROUP BY org_id, snapshot_id;

ALTER TABLE field_ticket_labor_lines
  ENABLE TRIGGER field_ticket_labor_line_immutable;

ALTER TABLE field_ticket_labor_lines
  ALTER COLUMN time_classification DROP DEFAULT,
  ALTER COLUMN time_classification SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'field_ticket_labor_lines'::regclass
       AND conname = 'field_ticket_labor_lines_time_classification_valid'
  ) THEN
    ALTER TABLE field_ticket_labor_lines
      ADD CONSTRAINT field_ticket_labor_lines_time_classification_valid
      CHECK (time_classification IN ('regular','overtime','double_time','other'));
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION field_ticket_labor_line_classification_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  configured_classification text;
BEGIN
  IF new.time_type_id IS NOT NULL THEN
    SELECT classification
      INTO configured_classification
      FROM time_types
     WHERE id = new.time_type_id
       AND org_id = new.org_id;
  END IF;
  IF new.time_classification IS NULL THEN
    new.time_classification := coalesce(
      configured_classification,
      CASE
        WHEN lower(new.time_type_name) LIKE '%double%' THEN 'double_time'
        WHEN lower(new.time_type_name) LIKE '%over%' THEN 'overtime'
        ELSE 'regular'
      END
    );
  ELSIF configured_classification IS NOT NULL
        AND new.time_classification IS DISTINCT FROM configured_classification
  THEN
    RAISE EXCEPTION
      'field ticket labor classification must match its time type at capture'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
DROP TRIGGER IF EXISTS field_ticket_labor_line_classification
  ON field_ticket_labor_lines;
CREATE TRIGGER field_ticket_labor_line_classification
BEFORE INSERT ON field_ticket_labor_lines
FOR EACH ROW EXECUTE FUNCTION field_ticket_labor_line_classification_guard();

COMMIT;
