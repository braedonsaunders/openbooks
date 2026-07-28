BEGIN;

-- A Field Ticket's approved/signed labor is commercial evidence, not a second
-- operational time ledger. Preserve it in append-only revisions so later time,
-- payroll, or upstream corrections cannot silently change what the customer
-- saw. These rows never post accounting or approve time entries.
CREATE TABLE IF NOT EXISTS field_ticket_labor_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  field_ticket_id uuid NOT NULL,
  revision integer NOT NULL,
  evidence_basis text NOT NULL
    CHECK (evidence_basis IN ('operational_time','source_import','controlled_amendment')),
  reason text NOT NULL,
  source_system text,
  source_payload_hash text,
  currency varchar(3) NOT NULL,
  captured_by uuid,
  captured_at timestamptz NOT NULL DEFAULT now(),
  superseded_by uuid,
  superseded_at timestamptz,
  CONSTRAINT field_ticket_labor_snapshots_revision_positive CHECK (revision > 0),
  CONSTRAINT field_ticket_labor_snapshots_supersession_shape CHECK (
    (superseded_at IS NULL AND superseded_by IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by IS NOT NULL)
  ),
  CONSTRAINT field_ticket_labor_snapshots_org_fk
    FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT field_ticket_labor_snapshots_ticket_fk
    FOREIGN KEY (field_ticket_id) REFERENCES field_tickets(document_id),
  CONSTRAINT field_ticket_labor_snapshots_captured_by_fk
    FOREIGN KEY (captured_by) REFERENCES users(id),
  CONSTRAINT field_ticket_labor_snapshots_superseded_by_fk
    FOREIGN KEY (superseded_by) REFERENCES users(id),
  CONSTRAINT field_ticket_labor_snapshots_revision
    UNIQUE (org_id, field_ticket_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS field_ticket_labor_snapshots_current
  ON field_ticket_labor_snapshots (org_id, field_ticket_id)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS field_ticket_labor_snapshots_ticket
  ON field_ticket_labor_snapshots (org_id, field_ticket_id, captured_at);

CREATE TABLE IF NOT EXISTS field_ticket_labor_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  field_ticket_id uuid NOT NULL,
  sequence integer NOT NULL,
  employee_party_id uuid NOT NULL,
  employee_name text NOT NULL,
  item_id uuid,
  item_name text,
  time_type_id uuid,
  time_type_name text NOT NULL,
  project_task_id uuid,
  project_task_name text,
  worked_on date NOT NULL,
  hours numeric(19,4) NOT NULL,
  time_entry_id uuid,
  time_entry_status text,
  cost_rate numeric(28,8),
  cost_rate_currency varchar(3),
  bill_rate numeric(28,8),
  bill_rate_currency varchar(3),
  cost_amount numeric(19,4),
  bill_amount numeric(19,4),
  source_system text,
  source_line_ref text,
  source_payload_hash text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_ticket_labor_lines_sequence_positive CHECK (sequence > 0),
  CONSTRAINT field_ticket_labor_lines_hours_nonzero CHECK (hours <> 0),
  CONSTRAINT field_ticket_labor_lines_org_fk
    FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT field_ticket_labor_lines_snapshot_fk
    FOREIGN KEY (snapshot_id) REFERENCES field_ticket_labor_snapshots(id),
  CONSTRAINT field_ticket_labor_lines_ticket_fk
    FOREIGN KEY (field_ticket_id) REFERENCES field_tickets(document_id),
  CONSTRAINT field_ticket_labor_lines_employee_fk
    FOREIGN KEY (employee_party_id) REFERENCES parties(id),
  CONSTRAINT field_ticket_labor_lines_item_fk
    FOREIGN KEY (item_id) REFERENCES items(id),
  CONSTRAINT field_ticket_labor_lines_time_type_fk
    FOREIGN KEY (time_type_id) REFERENCES time_types(id),
  CONSTRAINT field_ticket_labor_lines_project_task_fk
    FOREIGN KEY (project_task_id) REFERENCES project_tasks(id),
  CONSTRAINT field_ticket_labor_lines_time_entry_fk
    FOREIGN KEY (time_entry_id) REFERENCES time_entries(id),
  CONSTRAINT field_ticket_labor_lines_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT field_ticket_labor_lines_sequence
    UNIQUE (org_id, snapshot_id, sequence),
  CONSTRAINT field_ticket_labor_lines_time_entry
    UNIQUE (org_id, snapshot_id, time_entry_id),
  CONSTRAINT field_ticket_labor_lines_source_ref
    UNIQUE (org_id, snapshot_id, source_system, source_line_ref)
);
CREATE INDEX IF NOT EXISTS field_ticket_labor_lines_ticket
  ON field_ticket_labor_lines (org_id, field_ticket_id, worked_on);
CREATE INDEX IF NOT EXISTS field_ticket_labor_lines_time_entry_lookup
  ON field_ticket_labor_lines (org_id, time_entry_id);

CREATE OR REPLACE FUNCTION field_ticket_labor_snapshot_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM field_tickets ft
      JOIN documents d
        ON d.id = ft.document_id
       AND d.org_id = ft.org_id
       AND d.kind = 'field_ticket'
     WHERE ft.document_id = new.field_ticket_id
       AND ft.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION
      'field ticket labor snapshot must belong to a Field Ticket in the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.captured_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = new.captured_by AND u.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor snapshot actor must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.superseded_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u
     WHERE u.id = new.superseded_by AND u.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor snapshot superseding actor must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.superseded_at IS NOT NULL AND new.superseded_at < new.captured_at THEN
    RAISE EXCEPTION 'field ticket labor snapshot cannot be superseded before capture'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
DROP TRIGGER IF EXISTS field_ticket_labor_snapshot_integrity
  ON field_ticket_labor_snapshots;
CREATE TRIGGER field_ticket_labor_snapshot_integrity
BEFORE INSERT OR UPDATE ON field_ticket_labor_snapshots
FOR EACH ROW EXECUTE FUNCTION field_ticket_labor_snapshot_integrity_guard();

CREATE OR REPLACE FUNCTION field_ticket_labor_snapshot_retention_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'field ticket labor snapshots are retained evidence';
  END IF;
  IF row(new.org_id, new.field_ticket_id, new.revision, new.evidence_basis,
         new.reason, new.source_system, new.source_payload_hash, new.currency,
         new.captured_by, new.captured_at)
     IS DISTINCT FROM
     row(old.org_id, old.field_ticket_id, old.revision, old.evidence_basis,
         old.reason, old.source_system, old.source_payload_hash, old.currency,
         old.captured_by, old.captured_at)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot evidence is immutable';
  END IF;
  IF old.superseded_at IS NOT NULL
     AND row(new.superseded_at, new.superseded_by)
         IS DISTINCT FROM row(old.superseded_at, old.superseded_by)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot supersession is immutable once recorded';
  END IF;
  IF old.superseded_at IS NULL
     AND (new.superseded_at IS NULL OR new.superseded_by IS NULL)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot may only change through a complete supersession';
  END IF;
  RETURN new;
END
$$;
DROP TRIGGER IF EXISTS field_ticket_labor_snapshot_retention
  ON field_ticket_labor_snapshots;
CREATE TRIGGER field_ticket_labor_snapshot_retention
BEFORE UPDATE OR DELETE ON field_ticket_labor_snapshots
FOR EACH ROW EXECUTE FUNCTION field_ticket_labor_snapshot_retention_guard();

CREATE OR REPLACE FUNCTION field_ticket_labor_line_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked_time time_entries%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM field_ticket_labor_snapshots snapshot
     WHERE snapshot.id = new.snapshot_id
       AND snapshot.org_id = new.org_id
       AND snapshot.field_ticket_id = new.field_ticket_id
       AND snapshot.superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'field ticket labor line must belong to the current snapshot and ticket in the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM parties p
     WHERE p.id = new.employee_party_id AND p.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor employee must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM items i WHERE i.id = new.item_id AND i.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor item must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.time_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM time_types tt
     WHERE tt.id = new.time_type_id AND tt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor time type must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.project_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM project_tasks pt
      JOIN documents d
        ON d.id = new.field_ticket_id
       AND d.org_id = pt.org_id
       AND d.project_id = pt.project_id
     WHERE pt.id = new.project_task_id
       AND pt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor task must belong to the ticket project'
      USING ERRCODE = '23514';
  END IF;
  IF new.created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = new.created_by AND u.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor line actor must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  -- An optional link means exact atomic provenance, not a fuzzy association.
  IF new.time_entry_id IS NOT NULL THEN
    SELECT * INTO linked_time
      FROM time_entries te
     WHERE te.id = new.time_entry_id
       AND te.org_id = new.org_id;
    IF NOT FOUND
       OR linked_time.field_ticket_id IS DISTINCT FROM new.field_ticket_id
       OR linked_time.employee_party_id IS DISTINCT FROM new.employee_party_id
       OR linked_time.item_id IS DISTINCT FROM new.item_id
       OR linked_time.time_type_id IS DISTINCT FROM new.time_type_id
       OR linked_time.project_task_id IS DISTINCT FROM new.project_task_id
       OR linked_time.worked_on IS DISTINCT FROM new.worked_on
       OR linked_time.hours IS DISTINCT FROM new.hours
    THEN
      RAISE EXCEPTION
        'field ticket labor time-entry provenance must be an exact line on the same ticket'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN new;
END
$$;
DROP TRIGGER IF EXISTS field_ticket_labor_line_integrity
  ON field_ticket_labor_lines;
CREATE TRIGGER field_ticket_labor_line_integrity
BEFORE INSERT ON field_ticket_labor_lines
FOR EACH ROW EXECUTE FUNCTION field_ticket_labor_line_integrity_guard();

CREATE OR REPLACE FUNCTION field_ticket_labor_line_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'field ticket labor snapshot lines are append-only evidence';
END
$$;
DROP TRIGGER IF EXISTS field_ticket_labor_line_immutable
  ON field_ticket_labor_lines;
CREATE TRIGGER field_ticket_labor_line_immutable
BEFORE UPDATE OR DELETE ON field_ticket_labor_lines
FOR EACH ROW EXECUTE FUNCTION field_ticket_labor_line_immutable_guard();

ALTER TABLE field_ticket_labor_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_ticket_labor_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON field_ticket_labor_snapshots;
CREATE POLICY org_isolation ON field_ticket_labor_snapshots
  USING (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true));

ALTER TABLE field_ticket_labor_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_ticket_labor_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON field_ticket_labor_lines;
CREATE POLICY org_isolation ON field_ticket_labor_lines
  USING (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true));

-- Establish a stable revision for already-approved native tickets. A later
-- source-evidence import can supersede this in one controlled transaction;
-- this backfill does not modify or approve any operational time entry.
WITH inserted AS (
  INSERT INTO field_ticket_labor_snapshots
    (org_id, field_ticket_id, revision, evidence_basis, reason,
     source_system, currency, captured_by, captured_at)
  SELECT d.org_id, d.id, 1, 'operational_time',
         'Initial commercial labor snapshot created from linked operational time during native evidence migration',
         'openbooks', d.currency, coalesce(d.updated_by, d.created_by), coalesce(d.updated_at, d.created_at, now())
    FROM documents d
    JOIN field_tickets ft
      ON ft.document_id = d.id
     AND ft.org_id = d.org_id
   WHERE d.kind = 'field_ticket'
     AND d.status = 'approved'
     AND NOT EXISTS (
       SELECT 1
         FROM field_ticket_labor_snapshots existing
        WHERE existing.org_id = d.org_id
          AND existing.field_ticket_id = d.id
     )
  RETURNING id, org_id, field_ticket_id, captured_by
)
INSERT INTO audit_log
  (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'field_ticket_labor_snapshots', id, 'insert',
       jsonb_build_object(
         'source', 'migration_0075',
         'fieldTicketId', field_ticket_id,
         'revision', 1,
         'evidenceBasis', 'operational_time'
       ),
       captured_by
  FROM inserted;

INSERT INTO field_ticket_labor_lines
  (org_id, snapshot_id, field_ticket_id, sequence,
   employee_party_id, employee_name, item_id, item_name,
   time_type_id, time_type_name, project_task_id, project_task_name,
   worked_on, hours, time_entry_id, time_entry_status,
   cost_rate, cost_rate_currency, bill_rate, bill_rate_currency,
   cost_amount, bill_amount,
   source_system, source_line_ref, created_by, created_at)
SELECT snapshot.org_id,
       snapshot.id,
       snapshot.field_ticket_id,
       row_number() OVER (
         PARTITION BY snapshot.id
         ORDER BY te.worked_on, te.employee_party_id, te.item_id NULLS FIRST,
                  te.time_type_id, te.project_task_id NULLS FIRST, te.id
       )::integer,
       te.employee_party_id,
       employee.display_name,
       te.item_id,
       item.name,
       te.time_type_id,
       coalesce(time_type.name, 'Unclassified'),
       te.project_task_id,
       project_task.name,
       te.worked_on,
       te.hours,
       te.id,
       te.status,
       te.cost_rate,
       te.cost_rate_currency,
       te.bill_rate,
       te.bill_rate_currency,
       CASE WHEN te.cost_rate IS NULL
         THEN NULL
         ELSE round(te.hours * te.cost_rate, 4)
       END,
       CASE WHEN te.bill_rate IS NULL
         THEN NULL
         ELSE round(te.hours * te.bill_rate, 4)
       END,
       'openbooks',
       te.id::text,
       snapshot.captured_by,
       snapshot.captured_at
  FROM field_ticket_labor_snapshots snapshot
  JOIN time_entries te
    ON te.org_id = snapshot.org_id
   AND te.field_ticket_id = snapshot.field_ticket_id
   AND te.hours <> 0
  JOIN parties employee
    ON employee.id = te.employee_party_id
   AND employee.org_id = te.org_id
  LEFT JOIN items item
    ON item.id = te.item_id
   AND item.org_id = te.org_id
  LEFT JOIN time_types time_type
    ON time_type.id = te.time_type_id
   AND time_type.org_id = te.org_id
  LEFT JOIN project_tasks project_task
    ON project_task.id = te.project_task_id
   AND project_task.org_id = te.org_id
 WHERE snapshot.revision = 1
   AND snapshot.evidence_basis = 'operational_time'
   AND snapshot.source_system = 'openbooks'
   AND NOT EXISTS (
     SELECT 1
       FROM field_ticket_labor_lines existing
      WHERE existing.org_id = snapshot.org_id
        AND existing.snapshot_id = snapshot.id
   );

COMMIT;
