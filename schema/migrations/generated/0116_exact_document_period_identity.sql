BEGIN;

-- Posted documents already carry an exact journal relationship. Materialize
-- that journal's period on the document; never derive identity from a date.
UPDATE documents document
   SET posting_period_id = entry.period_id,
       updated_at = now()
  FROM journal_entries entry
 WHERE document.status = 'posted'
   AND document.posting_period_id IS NULL
   AND document.posted_entry_id = entry.id
   AND document.org_id = entry.org_id;

-- Repair a missing posted_entry_id only when one and only one unreversed
-- originating journal identifies the document exactly.
WITH exact_origin AS (
  SELECT source_document_id,
         min(id::text)::uuid AS entry_id,
         min(period_id::text)::uuid AS period_id
    FROM journal_entries
   WHERE source_document_id IS NOT NULL
     AND reverses_entry_id IS NULL
     AND status IN ('posted', 'reversed')
   GROUP BY source_document_id
  HAVING count(*) = 1
)
UPDATE documents document
   SET posted_entry_id = exact_origin.entry_id,
       posting_period_id = exact_origin.period_id,
       updated_at = now()
  FROM exact_origin
 WHERE document.status = 'posted'
   AND document.id = exact_origin.source_document_id
   AND document.posted_entry_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM documents
     WHERE status = 'posted'
       AND (posted_entry_id IS NULL OR posting_period_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'every posted document must have exact journal and accounting-period identity';
  END IF;
END;
$$;

ALTER TABLE documents
  ADD CONSTRAINT documents_posted_period_required
  CHECK (status <> 'posted' OR (posted_entry_id IS NOT NULL AND posting_period_id IS NOT NULL))
  NOT VALID;
ALTER TABLE documents VALIDATE CONSTRAINT documents_posted_period_required;

ALTER TABLE documents
  RENAME CONSTRAINT documents_no_legacy_field_ticket_custom
  TO documents_no_field_ticket_custom;

CREATE OR REPLACE FUNCTION validate_document_posted_period_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_period_id uuid;
  entry_org_id uuid;
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NEW;
  END IF;
  IF NEW.posted_entry_id IS NULL OR NEW.posting_period_id IS NULL THEN
    RAISE EXCEPTION 'posted document requires exact journal and accounting-period identity';
  END IF;
  SELECT period_id, org_id
    INTO entry_period_id, entry_org_id
    FROM journal_entries
   WHERE id = NEW.posted_entry_id;
  IF entry_period_id IS NULL
     OR entry_org_id <> NEW.org_id
     OR entry_period_id <> NEW.posting_period_id THEN
    RAISE EXCEPTION 'document posting period must equal its posted journal period';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_posted_period_identity_guard
BEFORE INSERT OR UPDATE OF status, posted_entry_id, posting_period_id ON documents
FOR EACH ROW EXECUTE FUNCTION validate_document_posted_period_identity();

COMMIT;
