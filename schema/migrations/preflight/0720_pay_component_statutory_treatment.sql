WITH findings AS (
  SELECT
    '0720.statutory_treatment_table_exists'::text AS code,
    'public.pay_component_statutory_treatments already exists without this migration being recorded'::text AS subject,
    'The migration creates and guards this relation; an existing object must be compared with the reviewed migration before proceeding.'::text AS detail,
    'Preserve the object and tenant data; compare its columns, constraints, indexes, triggers, policies and query-catalog entry with the reviewed migration before recording or applying any change.'::text AS remedy
  WHERE to_regclass('public.pay_component_statutory_treatments') IS NOT NULL

  UNION ALL

  SELECT
    '0720.statutory_treatment_function_exists',
    'a statutory treatment function already exists without this migration being recorded',
    'The migration creates a pay-date group selector and retained-policy guards.',
    'Preserve these functions and compare their definitions with the reviewed migration before proceeding.'
  WHERE to_regprocedure('public.payroll_worker_comp_group_at(uuid,uuid,date)') IS NOT NULL
    OR to_regprocedure('public.pay_component_statutory_treatment_clone_matches(jsonb)') IS NOT NULL
    OR to_regprocedure('public.pay_component_statutory_treatment_preserve_committed()') IS NOT NULL

  UNION ALL

  SELECT
    '0720.dated_worker_comp_assignment_source_missing',
    'public.payroll_employee_employer_assignments is not available for the nullable dated group update',
    'The migration retains explicit dated assignments that resolve to no active worker-compensation group.',
    'Preserve existing payroll data and install the native dated-employer-assignment source before applying this migration.'
  WHERE to_regclass('public.payroll_employee_employer_assignments') IS NULL

  UNION ALL

  SELECT
    '0720.dated_worker_comp_assignment_shape_changed',
    'the expected assignment-kind constraint is not available for the reviewed update',
    'The migration changes only the worker-compensation branch so a dated assignment can explicitly carry no group.',
    'Preserve the table and compare its constraints with the published 0568 schema before proceeding.'
  WHERE to_regclass('public.payroll_employee_employer_assignments') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = to_regclass('public.payroll_employee_employer_assignments')
         AND constraint_row.conname = 'payroll_employee_employer_assignments_check1'
         AND constraint_row.contype = 'c'
    )

  UNION ALL

  SELECT
    '0720.statutory_treatment_source_missing',
    'public.pay_components.program_exclusions is not available for the backfill',
    'The migration copies the existing static treatment into an open-ended effective-dated row before dropping the source column.',
    'Preserve the organization data and resolve the exact source schema before applying this migration.'
  WHERE NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = to_regclass('public.pay_components')
       AND attribute.attname = 'program_exclusions'
       AND NOT attribute.attisdropped
  )
)
SELECT code, 'refuse'::text AS severity, subject, detail, remedy
  FROM findings;
