BEGIN;

-- Exact posted-period identity is a transaction invariant. Source correction
-- atomically appends a reversal/replacement and repoints the document, so a
-- row-level BEFORE trigger would reject the safe intermediate state. Validate
-- the final row at commit instead; no mismatched identity can commit.
DROP TRIGGER IF EXISTS document_posted_period_identity_guard ON documents;

CREATE OR REPLACE FUNCTION validate_document_posted_period_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status text;
  current_entry_id uuid;
  current_period_id uuid;
  current_org_id uuid;
  entry_period_id uuid;
  entry_org_id uuid;
BEGIN
  SELECT status, posted_entry_id, posting_period_id, org_id
    INTO current_status, current_entry_id, current_period_id, current_org_id
    FROM documents
   WHERE id = NEW.id;

  -- The document may have been deleted later in the same transaction.
  IF NOT FOUND OR current_status <> 'posted' THEN
    RETURN NULL;
  END IF;
  IF current_entry_id IS NULL OR current_period_id IS NULL THEN
    RAISE EXCEPTION 'posted document requires exact journal and accounting-period identity';
  END IF;
  SELECT period_id, org_id
    INTO entry_period_id, entry_org_id
    FROM journal_entries
   WHERE id = current_entry_id;
  IF entry_period_id IS NULL
     OR entry_org_id <> current_org_id
     OR entry_period_id <> current_period_id THEN
    RAISE EXCEPTION 'document posting period must equal its posted journal period';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER document_posted_period_identity_guard
AFTER INSERT OR UPDATE OF status, posted_entry_id, posting_period_id ON documents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_document_posted_period_identity();

COMMIT;
