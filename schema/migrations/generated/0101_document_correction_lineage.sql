BEGIN;

-- A correcting document is a new business record.  The edge from the
-- replacement to the retained source is permanent evidence of why and by whom
-- the correction was initiated.
ALTER TABLE document_links
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS requested_by uuid,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz;

ALTER TABLE document_links
  DROP CONSTRAINT IF EXISTS document_links_reversal_evidence,
  ADD CONSTRAINT document_links_reversal_evidence
  CHECK (
    link_type <> 'reverses'
    OR (
      reason IS NOT NULL
      AND length(btrim(reason)) BETWEEN 8 AND 500
      AND requested_by IS NOT NULL
      AND requested_at IS NOT NULL
    )
  ) NOT VALID;

-- A document version has at most one replacement and a replacement corrects
-- exactly one source.  Further corrections form an explicit version chain.
CREATE UNIQUE INDEX IF NOT EXISTS document_links_one_replacement_per_source
  ON document_links (org_id, to_document_id)
  WHERE link_type = 'reverses';

CREATE UNIQUE INDEX IF NOT EXISTS document_links_one_source_per_replacement
  ON document_links (org_id, from_document_id)
  WHERE link_type = 'reverses';

CREATE OR REPLACE FUNCTION document_correction_lineage_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  replacement record;
  source record;
BEGIN
  IF tg_op <> 'INSERT' THEN
    IF old.link_type = 'reverses'
       AND NOT openbooks_sandbox_wipe_allowed(old.org_id)
    THEN
      RAISE EXCEPTION
        'document correction lineage is immutable; retain the source and replacement';
    END IF;
    RETURN coalesce(new, old);
  END IF;

  IF new.link_type <> 'reverses' THEN
    RETURN new;
  END IF;

  SELECT id, org_id, kind, status
    INTO replacement
    FROM documents
   WHERE id = new.from_document_id
   FOR KEY SHARE;
  SELECT id, org_id, kind, status
    INTO source
    FROM documents
   WHERE id = new.to_document_id
   FOR KEY SHARE;

  IF replacement.id IS NULL OR source.id IS NULL
     OR replacement.org_id <> new.org_id
     OR source.org_id <> new.org_id
  THEN
    RAISE EXCEPTION
      'a correction source and replacement must belong to the same tenant';
  END IF;
  IF replacement.id = source.id THEN
    RAISE EXCEPTION 'a document cannot correct itself';
  END IF;
  IF replacement.kind <> source.kind THEN
    RAISE EXCEPTION
      'a correction must retain the source document kind';
  END IF;
  IF source.status NOT IN ('posted', 'voided') THEN
    RAISE EXCEPTION
      'only a posted or already-voided document can be the source of a correction';
  END IF;
  IF replacement.status <> 'draft'
     OR replacement.posted_entry_id IS NOT NULL
  THEN
    RAISE EXCEPTION
      'correction lineage must be established while the replacement is an unposted draft';
  END IF;
  RETURN new;
END
$$;

DROP TRIGGER IF EXISTS document_correction_lineage_guard ON document_links;
CREATE TRIGGER document_correction_lineage_guard
BEFORE INSERT OR UPDATE OR DELETE ON document_links
FOR EACH ROW
EXECUTE FUNCTION document_correction_lineage_guard();

COMMIT;
