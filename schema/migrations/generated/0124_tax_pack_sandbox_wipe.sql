BEGIN;

-- Country-pack installation evidence is immutable in every live tenant. An
-- explicitly authorized sandbox teardown is the sole delete path: the caller
-- must set openbooks.sandbox_wipe in its transaction and the owning org must
-- already be marked sandbox. This keeps test/sandbox lifecycle operable without
-- turning the maintenance GUC into a production-history bypass.
CREATE OR REPLACE FUNCTION protect_country_tax_pack_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('openbooks.sandbox_wipe', true) = 'on'
     AND EXISTS (
       SELECT 1
         FROM orgs
        WHERE id = OLD.org_id
          AND env_kind = 'sandbox'
     ) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'country tax pack installation evidence is immutable';
  END IF;
  IF OLD.status = 'active'
     AND NEW.status = 'superseded'
     AND NEW.org_id = OLD.org_id
     AND NEW.pack_code = OLD.pack_code
     AND NEW.country = OLD.country
     AND NEW.version = OLD.version
     AND NEW.content_hash = OLD.content_hash
     AND NEW.manifest = OLD.manifest
     AND NEW.installed_at = OLD.installed_at
     AND NEW.installed_by IS NOT DISTINCT FROM OLD.installed_by
     AND NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'country tax pack installation may only transition from active to superseded';
END;
$$;

COMMIT;
