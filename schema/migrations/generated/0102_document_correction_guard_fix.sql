BEGIN;

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

  SELECT id, org_id, kind, status, posted_entry_id
    INTO replacement
    FROM documents
   WHERE id = new.from_document_id
   FOR KEY SHARE;
  SELECT id, org_id, kind, status, posted_entry_id
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

COMMIT;
