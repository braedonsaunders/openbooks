BEGIN;

CREATE TABLE IF NOT EXISTS project_financial_profile_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_type_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  financial_profile jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT project_financial_profile_versions_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT project_financial_profile_versions_profile_object
    CHECK (jsonb_typeof(financial_profile) = 'object'),
  CONSTRAINT project_financial_profile_versions_reason
    CHECK (length(btrim(reason)) >= 8),
  CONSTRAINT project_financial_profile_versions_org_fk
    FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT project_financial_profile_versions_type_fk
    FOREIGN KEY (project_type_id) REFERENCES project_types(id),
  CONSTRAINT project_financial_profile_versions_identity
    UNIQUE (project_type_id, effective_from)
);

CREATE INDEX IF NOT EXISTS project_financial_profile_versions_effective
  ON project_financial_profile_versions
    (org_id, project_type_id, effective_from, effective_to);

INSERT INTO project_financial_profile_versions (
  org_id, project_type_id, effective_from, effective_to, financial_profile,
  reason, created_by, updated_by
)
SELECT pt.org_id, pt.id, date '0001-01-01', NULL, pt.financial_profile,
       'Initial version migrated from the project type profile',
       pt.created_by, pt.updated_by
  FROM project_types pt
 WHERE NOT EXISTS (
   SELECT 1
     FROM project_financial_profile_versions v
    WHERE v.project_type_id = pt.id
 );

CREATE OR REPLACE FUNCTION project_financial_profile_version_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF tg_op <> 'DELETE' AND NOT EXISTS (
    SELECT 1
      FROM project_types pt
     WHERE pt.id = new.project_type_id
       AND pt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION
      'project financial profile version must belong to the project type organization';
  END IF;

  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'published project financial profile versions are immutable';
  END IF;

  IF tg_op = 'UPDATE' THEN
    IF coalesce(current_setting('openbooks.publish_project_profile', true), 'off') <> 'on'
       OR (to_jsonb(new) - 'effective_to' - 'updated_at' - 'updated_by')
          IS DISTINCT FROM
          (to_jsonb(old) - 'effective_to' - 'updated_at' - 'updated_by')
    THEN
      RAISE EXCEPTION 'published project financial profile versions are immutable';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM project_financial_profile_versions v
     WHERE v.org_id = new.org_id
       AND v.project_type_id = new.project_type_id
       AND v.id <> new.id
       AND daterange(v.effective_from, v.effective_to, '[]')
           && daterange(new.effective_from, new.effective_to, '[]')
  ) THEN
    RAISE EXCEPTION 'project financial profile effective ranges cannot overlap';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS project_financial_profile_version_guard
  ON project_financial_profile_versions;
CREATE TRIGGER project_financial_profile_version_guard
BEFORE INSERT OR UPDATE OR DELETE
ON project_financial_profile_versions
FOR EACH ROW EXECUTE FUNCTION project_financial_profile_version_guard();

CREATE OR REPLACE FUNCTION project_type_financial_profile_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF new.financial_profile IS DISTINCT FROM old.financial_profile
     AND EXISTS (
       SELECT 1
         FROM project_financial_profile_versions v
        WHERE v.org_id = old.org_id
          AND v.project_type_id = old.id
     )
  THEN
    RAISE EXCEPTION
      'project_types.financial_profile is a seed value; publish an effective-dated version';
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS project_type_financial_profile_guard ON project_types;
CREATE TRIGGER project_type_financial_profile_guard
BEFORE UPDATE OF financial_profile
ON project_types
FOR EACH ROW EXECUTE FUNCTION project_type_financial_profile_guard();

ALTER TABLE project_financial_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_financial_profile_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON project_financial_profile_versions;
CREATE POLICY org_isolation ON project_financial_profile_versions
  USING (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true));

COMMIT;
