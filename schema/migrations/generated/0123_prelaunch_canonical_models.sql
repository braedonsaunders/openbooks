BEGIN;

-- Canonical names and ownership are completed before the first public release.
UPDATE project_financial_profile_versions
   SET financial_profile = jsonb_set(
     financial_profile,
     '{overhead,method}',
     '"posted_gl_account_group"'::jsonb
   )
 WHERE financial_profile->'overhead'->>'method' = 'account_group_actual';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sync_runs WHERE connection_id IS NULL) THEN
    RAISE EXCEPTION
      'cannot complete sync-run cutover: every run requires an authoritative connection';
  END IF;
  IF EXISTS (SELECT 1 FROM landed_cost_allocations WHERE voucher_id IS NULL) THEN
    RAISE EXCEPTION
      'cannot complete landed-cost cutover: every allocation requires voucher evidence';
  END IF;
  IF EXISTS (SELECT 1 FROM project_types WHERE billing_method IS NULL) THEN
    RAISE EXCEPTION
      'cannot complete project-type cutover: every type requires a billing classification';
  END IF;
END;
$$;

ALTER TABLE sync_runs
  ALTER COLUMN connection_id SET NOT NULL;

ALTER TABLE landed_cost_allocations
  ALTER COLUMN voucher_id SET NOT NULL;

ALTER TABLE project_types
  ALTER COLUMN billing_method SET NOT NULL;

-- Normalize the only pre-cutover reporting-package encoding once, then require
-- the canonical object model at the database boundary.
UPDATE close_reporting_packages package
   SET reports = coalesce(
     (
       SELECT jsonb_agg(
         CASE
           WHEN jsonb_typeof(item.value) = 'string'
             THEN jsonb_build_object('slug', item.value #>> '{}')
           ELSE item.value
         END
         ORDER BY item.ordinality
       )
         FROM jsonb_array_elements(package.reports) WITH ORDINALITY AS item(value, ordinality)
     ),
     '[]'::jsonb
   );

-- Custom record definitions were never released publicly, so complete the
-- section-model cutover in place. A flat field list has one deterministic,
-- lossless interpretation: the same ordered fields in one non-repeating
-- Details section. Record payload keys are unchanged.
WITH candidates AS (
  SELECT id, org_id, fields AS before_fields
    FROM custom_record_types
   WHERE jsonb_typeof(fields) = 'array'
     AND jsonb_array_length(fields) > 0
     AND jsonb_typeof(fields->0->'fields') IS DISTINCT FROM 'array'
), updated AS (
  UPDATE custom_record_types record_type
     SET fields = jsonb_build_array(
           jsonb_build_object(
             'id', 'main',
             'title', 'Details',
             'fields', candidates.before_fields
           )
         ),
         updated_at = now()
    FROM candidates
   WHERE record_type.id = candidates.id
  RETURNING record_type.id, record_type.org_id,
            candidates.before_fields,
            record_type.fields AS after_fields
)
INSERT INTO audit_log (
  org_id, table_name, row_id, action, changes, request_id
)
SELECT org_id, 'custom_record_types', id, 'update',
       jsonb_build_object(
         'source', 'prelaunch_cutover',
         'reason', 'Normalize the custom record definition to the canonical form-section model',
         'before', jsonb_build_object('fields', before_fields),
         'after', jsonb_build_object('fields', after_fields)
       ),
       'prelaunch-canonical-custom-record-sections'
  FROM updated;

CREATE OR REPLACE FUNCTION openbooks_valid_form_sections(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(value) section
       WHERE jsonb_typeof(section) IS DISTINCT FROM 'object'
          OR jsonb_typeof(section->'fields') IS DISTINCT FROM 'array'
    )
  END
$$;

CREATE OR REPLACE FUNCTION openbooks_valid_report_attachments(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(value) attachment
       WHERE jsonb_typeof(attachment) IS DISTINCT FROM 'object'
          OR jsonb_typeof(attachment->'slug') IS DISTINCT FROM 'string'
          OR length(btrim(attachment->>'slug')) = 0
    )
  END
$$;

-- OpenBooks has not shipped a stable release. Finish the project-policy model
-- now instead of carrying two financial-profile sources into production.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM project_types pt
     WHERE NOT EXISTS (
       SELECT 1
         FROM project_financial_profile_versions version
        WHERE version.org_id = pt.org_id
          AND version.project_type_id = pt.id
     )
  ) THEN
    RAISE EXCEPTION
      'cannot complete project-policy cutover: every project type requires an effective-dated financial profile';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM project_types pt
     WHERE pt.invoicing_profile->>'billingProcedure'
           NOT IN ('standard', 'application_for_payment')
        OR NOT (pt.invoicing_profile ? 'billingProcedure')
  ) THEN
    RAISE EXCEPTION
      'cannot complete project-policy cutover: every project type requires an explicit billing procedure';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM custom_record_types record_type
     WHERE jsonb_array_length(record_type.fields) > 0
       AND jsonb_typeof(record_type.fields->0->'fields') IS DISTINCT FROM 'array'
  ) THEN
    RAISE EXCEPTION
      'cannot complete custom-record cutover: every custom record definition must use form sections';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM form_layouts form
     WHERE form.record_type = 'project'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(coalesce(form.layout->'tabs', '[]'::jsonb)) tab
          WHERE tab->>'key' IN ('work_breakdown', 'schedule')
       )
  ) THEN
    RAISE EXCEPTION
      'cannot complete project-form cutover: planning tabs must be nested under project_management';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS project_type_financial_profile_guard ON project_types;
DROP FUNCTION IF EXISTS project_type_financial_profile_guard();

DROP VIEW IF EXISTS openbooks_query.project_types;

ALTER TABLE project_types
  DROP COLUMN financial_profile;

ALTER TABLE project_types
  ADD CONSTRAINT project_types_billing_procedure_required
  CHECK (
    invoicing_profile->>'billingProcedure'
      IN ('standard', 'application_for_payment')
  );

ALTER TABLE custom_record_types
  ADD CONSTRAINT custom_record_types_section_model
  CHECK (openbooks_valid_form_sections(fields));

ALTER TABLE close_reporting_packages
  ADD CONSTRAINT close_reporting_packages_attachment_model
  CHECK (openbooks_valid_report_attachments(reports));

SELECT public.openbooks_refresh_query_catalog();

COMMIT;
