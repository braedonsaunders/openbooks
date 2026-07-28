BEGIN;

-- Published valid-time rows remain append-only under ordinary setup. A
-- separately flagged correction may replace only the policy JSON, never its
-- identity or effective dates. The service must supply a reason and writes
-- immutable before/after audit evidence in the same transaction.
CREATE OR REPLACE FUNCTION project_financial_profile_version_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  publish_mode boolean :=
    coalesce(current_setting('openbooks.publish_project_profile', true), 'off') = 'on';
  correction_mode boolean :=
    coalesce(current_setting('openbooks.correct_project_profile', true), 'off') = 'on';
  correction_reason text :=
    coalesce(current_setting('openbooks.project_profile_correction_reason', true), '');
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
    IF correction_mode THEN
      IF length(btrim(correction_reason)) < 8
         OR (to_jsonb(new) - 'financial_profile' - 'updated_at' - 'updated_by')
            IS DISTINCT FROM
            (to_jsonb(old) - 'financial_profile' - 'updated_at' - 'updated_by')
      THEN
        RAISE EXCEPTION
          'controlled project financial profile correction may change only policy JSON and requires a reason';
      END IF;
    ELSIF NOT publish_mode
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

COMMIT;
