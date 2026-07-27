BEGIN;

-- Field Tickets are a native domain. Refuse to advance any database that still
-- carries the retired documents.custom.fieldTicket compatibility copy: the
-- operational retirement step must first prove and preserve every signature,
-- request, charge link, lifecycle fact, and header value in native tables.
DO $$
DECLARE
  legacy_count bigint;
BEGIN
  SELECT count(*)
    INTO legacy_count
    FROM documents
   WHERE custom ? 'fieldTicket';

  IF legacy_count <> 0 THEN
    RAISE EXCEPTION
      'cannot forbid legacy Field Ticket JSON: % documents still carry the retired key',
      legacy_count
      USING ERRCODE = '23514',
            HINT = 'Run the guarded native Field Ticket evidence migration and retirement procedure before applying this migration.';
  END IF;
END
$$;

-- Make retirement durable. This is deliberately global, not conditional on
-- document kind: a product-native reserved key must never be repurposed as a
-- tenant custom field or integration scratchpad on another document type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'documents'::regclass
       AND conname = 'documents_no_legacy_field_ticket_custom'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_no_legacy_field_ticket_custom
      CHECK (NOT (custom ? 'fieldTicket'));
  END IF;
END
$$;

COMMIT;
