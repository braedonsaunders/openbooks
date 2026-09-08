-- OpenBooks forward migration 0099_project_profile_sandbox_teardown.
-- Permit controlled sandbox teardown of copied financial policy history.
-- Production immutability and all update/insert checks remain enforced.

CREATE OR REPLACE FUNCTION public.project_financial_profile_version_guard() RETURNS trigger
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
  IF tg_op = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(old.org_id) THEN
    RETURN old;
  END IF;
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

  -- Effective-range exclusivity is owned by the
  -- project_financial_profile_versions_no_overlap exclusion constraint
  -- (0051). Publish-mode window closing and correction-mode immutability
  -- above are unchanged.
  RETURN new;
END;
$$;

COMMENT ON FUNCTION public.project_financial_profile_version_guard() IS
  'openbooks:project_financial_profile_version_guard:v3 - authorized sandbox teardown; publish/correct-mode immutability for project financial profile versions; effective-range exclusivity moved to the project_financial_profile_versions_no_overlap exclusion constraint';

