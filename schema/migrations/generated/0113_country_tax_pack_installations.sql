BEGIN;

CREATE TABLE tax_country_pack_installations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  pack_code text NOT NULL,
  country text NOT NULL,
  version text NOT NULL,
  content_hash text NOT NULL,
  manifest jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  installed_at timestamptz NOT NULL DEFAULT now(),
  installed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  superseded_at timestamptz,
  superseded_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT tax_country_pack_installations_status_chk CHECK (status IN ('active', 'superseded')),
  CONSTRAINT tax_country_pack_installations_identity_chk CHECK (
    pack_code <> ''
    AND country ~ '^[A-Z]{2}$'
    AND version ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$'
    AND content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT tax_country_pack_installations_manifest_chk CHECK (
    jsonb_typeof(manifest) = 'object'
    AND manifest->>'code' = pack_code
    AND manifest->>'country' = country
    AND manifest->>'version' = version
  ),
  CONSTRAINT tax_country_pack_installations_lifecycle_chk CHECK (
    (status = 'active' AND superseded_at IS NULL AND superseded_by IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX tax_country_pack_installations_org_pack_version
  ON tax_country_pack_installations (org_id, pack_code, version);
CREATE UNIQUE INDEX tax_country_pack_installations_one_active
  ON tax_country_pack_installations (org_id, pack_code)
  WHERE status = 'active';
CREATE INDEX tax_country_pack_installations_org_country
  ON tax_country_pack_installations (org_id, country);

ALTER TABLE tax_country_pack_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tax_country_pack_installations
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

CREATE OR REPLACE FUNCTION validate_country_tax_pack_installation_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.installed_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.installed_by AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'country tax pack installer must belong to the installation organization';
  END IF;
  IF NEW.superseded_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.superseded_by AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'country tax pack superseding actor must belong to the installation organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER country_tax_pack_installation_actor_guard
BEFORE INSERT OR UPDATE ON tax_country_pack_installations
FOR EACH ROW EXECUTE FUNCTION validate_country_tax_pack_installation_actor();

CREATE OR REPLACE FUNCTION protect_country_tax_pack_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

CREATE TRIGGER country_tax_pack_installation_guard
BEFORE UPDATE OR DELETE ON tax_country_pack_installations
FOR EACH ROW EXECUTE FUNCTION protect_country_tax_pack_installation();

COMMIT;
