BEGIN;

CREATE TABLE IF NOT EXISTS billing_request_field_tickets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  billing_request_id uuid NOT NULL REFERENCES billing_requests(id) ON DELETE RESTRICT,
  field_ticket_id uuid NOT NULL REFERENCES field_tickets(document_id) ON DELETE RESTRICT,
  selection_source text NOT NULL DEFAULT 'request_creation',
  selected_at timestamptz NOT NULL DEFAULT now(),
  selected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT billing_request_field_tickets_source_valid
    CHECK (selection_source IN ('request_creation', 'legacy_json_migration', 'validation_replay'))
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_request_field_tickets_request_ticket
  ON billing_request_field_tickets (org_id, billing_request_id, field_ticket_id);
CREATE INDEX IF NOT EXISTS billing_request_field_tickets_ticket
  ON billing_request_field_tickets (org_id, field_ticket_id);

-- Refuse lossy migration. Every legacy selection must be a UUID and resolve to
-- a Field Ticket in the request's organization and project.
DO $$
DECLARE
  invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM billing_requests br
   WHERE br.custom ? 'fieldTicketIds'
     AND (
       br.basis <> 'field_ticket'
       OR jsonb_typeof(br.custom->'fieldTicketIds') <> 'array'
     );

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'cannot migrate Field Ticket billing selections: % requests have the wrong basis or JSON shape',
      invalid_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
    INTO invalid_count
    FROM (
      SELECT *
        FROM billing_requests
       WHERE custom ? 'fieldTicketIds'
         AND jsonb_typeof(custom->'fieldTicketIds') = 'array'
    ) br
    CROSS JOIN LATERAL jsonb_array_elements_text(br.custom->'fieldTicketIds') value
   WHERE value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'cannot migrate Field Ticket billing selections: % selections are not UUIDs',
      invalid_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
    INTO invalid_count
    FROM (
      SELECT br.*, value
        FROM billing_requests br
        CROSS JOIN LATERAL jsonb_array_elements_text(br.custom->'fieldTicketIds') value
       WHERE br.custom ? 'fieldTicketIds'
         AND jsonb_typeof(br.custom->'fieldTicketIds') = 'array'
         AND value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) selection
   WHERE NOT EXISTS (
         SELECT 1
           FROM documents ticket
          WHERE ticket.id = selection.value::uuid
            AND ticket.org_id = selection.org_id
            AND ticket.project_id = selection.project_id
            AND ticket.kind = 'field_ticket'
       );

  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'cannot migrate Field Ticket billing selections: % cross-scope or missing selections',
      invalid_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

INSERT INTO billing_request_field_tickets (
  org_id,
  billing_request_id,
  field_ticket_id,
  selection_source,
  selected_at,
  selected_by
)
SELECT
  br.org_id,
  br.id,
  value::uuid,
  'legacy_json_migration',
  br.created_at,
  coalesce(br.created_by, br.updated_by)
FROM billing_requests br
CROSS JOIN LATERAL jsonb_array_elements_text(br.custom->'fieldTicketIds') value
WHERE br.custom ? 'fieldTicketIds'
ON CONFLICT (org_id, billing_request_id, field_ticket_id) DO NOTHING;

DO $$
DECLARE
  missing_count bigint;
BEGIN
  SELECT count(*)
    INTO missing_count
    FROM billing_requests br
    CROSS JOIN LATERAL jsonb_array_elements_text(br.custom->'fieldTicketIds') value
   WHERE br.custom ? 'fieldTicketIds'
     AND NOT EXISTS (
       SELECT 1
         FROM billing_request_field_tickets selected
        WHERE selected.org_id = br.org_id
          AND selected.billing_request_id = br.id
          AND selected.field_ticket_id = value::uuid
     );

  IF missing_count <> 0 THEN
    RAISE EXCEPTION
      'Field Ticket billing selection verification failed: % selections were not preserved',
      missing_count
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
    INTO missing_count
    FROM billing_requests br
   WHERE br.basis = 'field_ticket'
     AND NOT EXISTS (
       SELECT 1
         FROM billing_request_field_tickets selected
        WHERE selected.org_id = br.org_id
          AND selected.billing_request_id = br.id
     );

  IF missing_count <> 0 THEN
    RAISE EXCEPTION
      'Field Ticket billing selection verification failed: % requests have no selected tickets',
      missing_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

UPDATE billing_requests
   SET custom = custom - 'fieldTicketIds'
 WHERE custom ? 'fieldTicketIds';

ALTER TABLE billing_requests
  DROP CONSTRAINT IF EXISTS billing_requests_basis_check,
  ADD CONSTRAINT billing_requests_basis_check
    CHECK (basis IN ('date_range', 'draw_amount', 'time_selection', 'milestone', 'field_ticket')),
  DROP CONSTRAINT IF EXISTS billing_requests_no_field_ticket_ids_json,
  ADD CONSTRAINT billing_requests_no_field_ticket_ids_json
    CHECK (NOT (custom ? 'fieldTicketIds'));

-- Field Ticket item/equipment lines are materialized into project charges at
-- approval. Tag those charge lines explicitly so ticket billing never has to
-- infer cost provenance from a date window.
UPDATE document_lines line
   SET field_ticket_id = ticket.id,
       updated_at = now()
  FROM documents ticket
 WHERE ticket.id = line.document_id
   AND ticket.org_id = line.org_id
   AND ticket.kind = 'field_ticket'
   AND line.field_ticket_id IS NULL;

DO $$
DECLARE
  conflicting_count bigint;
BEGIN
  SELECT count(*)
    INTO conflicting_count
    FROM document_links link
    JOIN documents ticket
      ON ticket.id = link.from_document_id
     AND ticket.org_id = link.org_id
     AND ticket.kind = 'field_ticket'
    JOIN documents charge
      ON charge.id = link.to_document_id
     AND charge.org_id = link.org_id
     AND charge.kind = 'project_charge'
    JOIN document_lines line
      ON line.document_id = charge.id
     AND line.org_id = link.org_id
   WHERE link.link_type = 'created_from'
     AND line.field_ticket_id IS NOT NULL
     AND line.field_ticket_id <> ticket.id;

  IF conflicting_count <> 0 THEN
    RAISE EXCEPTION
      'cannot backfill Field Ticket charge provenance: % charge lines conflict',
      conflicting_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

UPDATE document_lines line
   SET field_ticket_id = ticket.id,
       updated_at = now()
  FROM document_links link
  JOIN documents ticket
    ON ticket.id = link.from_document_id
   AND ticket.org_id = link.org_id
   AND ticket.kind = 'field_ticket'
  JOIN documents charge
    ON charge.id = link.to_document_id
   AND charge.org_id = link.org_id
   AND charge.kind = 'project_charge'
 WHERE line.document_id = charge.id
   AND line.org_id = link.org_id
   AND link.link_type = 'created_from'
   AND line.field_ticket_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS document_links_unique_edge
  ON document_links (org_id, from_document_id, to_document_id, link_type);

CREATE OR REPLACE FUNCTION billing_request_field_ticket_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_project_id uuid;
  request_basis text;
  request_status text;
BEGIN
  IF tg_op = 'DELETE'
     AND openbooks_sandbox_wipe_allowed(old.org_id)
  THEN
    RETURN old;
  END IF;

  IF tg_op IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION
      'billing request Field Ticket selections are immutable; cancel the request and create a new one';
  END IF;

  SELECT br.project_id, br.basis, br.status
    INTO request_project_id, request_basis, request_status
    FROM billing_requests br
   WHERE br.id = new.billing_request_id
     AND br.org_id = new.org_id;

  IF request_project_id IS NULL
     OR request_basis <> 'field_ticket'
     OR request_status <> 'open'
  THEN
    RAISE EXCEPTION
      'Field Ticket selections require an open field-ticket billing request in the same organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM documents ticket
     WHERE ticket.id = new.field_ticket_id
       AND ticket.org_id = new.org_id
       AND ticket.project_id = request_project_id
       AND ticket.kind = 'field_ticket'
       AND (
         ticket.status = 'approved'
         OR new.selection_source IN ('legacy_json_migration', 'validation_replay')
       )
  ) THEN
    RAISE EXCEPTION
      'selected Field Ticket must be approved and belong to the billing request project';
  END IF;

  IF new.selected_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM users actor
     WHERE actor.id = new.selected_by
       AND actor.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION
      'Field Ticket selection actor must belong to the same organization';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'billing-field-ticket:' || new.org_id::text || ':' || new.field_ticket_id::text,
      0
    )
  );

  IF new.selection_source = 'request_creation' AND EXISTS (
    SELECT 1
      FROM billing_request_field_tickets existing
      JOIN billing_requests existing_request
        ON existing_request.id = existing.billing_request_id
       AND existing_request.org_id = existing.org_id
     WHERE existing.org_id = new.org_id
       AND existing.field_ticket_id = new.field_ticket_id
       AND existing_request.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'Field Ticket is already selected by another active or completed billing request';
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS billing_request_field_ticket_guard
  ON billing_request_field_tickets;
CREATE TRIGGER billing_request_field_ticket_guard
BEFORE INSERT OR UPDATE OR DELETE
ON billing_request_field_tickets
FOR EACH ROW EXECUTE FUNCTION billing_request_field_ticket_guard();

-- The parent request and its selections are inserted in one transaction.
-- Defer this invariant until commit so neither half can ever persist alone,
-- while still allowing the request row to be inserted before its selections.
CREATE OR REPLACE FUNCTION billing_request_field_ticket_request_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selection_count bigint;
BEGIN
  SELECT count(*)
    INTO selection_count
    FROM billing_request_field_tickets selected
   WHERE selected.org_id = new.org_id
     AND selected.billing_request_id = new.id;

  IF new.basis = 'field_ticket' AND selection_count = 0 THEN
    RAISE EXCEPTION
      'a Field Ticket billing request requires at least one relational ticket selection';
  END IF;

  IF new.basis <> 'field_ticket' AND selection_count <> 0 THEN
    RAISE EXCEPTION
      'Field Ticket selections may only belong to a field-ticket billing request';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM billing_request_field_tickets selected
      JOIN documents ticket
        ON ticket.id = selected.field_ticket_id
       AND ticket.org_id = selected.org_id
     WHERE selected.org_id = new.org_id
       AND selected.billing_request_id = new.id
       AND (
         ticket.kind <> 'field_ticket'
         OR ticket.project_id IS DISTINCT FROM new.project_id
       )
  ) THEN
    RAISE EXCEPTION
      'Field Ticket billing selections must remain in the request organization and project';
  END IF;

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS billing_request_field_ticket_request_guard
  ON billing_requests;
CREATE CONSTRAINT TRIGGER billing_request_field_ticket_request_guard
AFTER INSERT OR UPDATE
ON billing_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION billing_request_field_ticket_request_guard();

ALTER TABLE billing_request_field_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_request_field_tickets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON billing_request_field_tickets;
CREATE POLICY org_isolation ON billing_request_field_tickets
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

COMMIT;
