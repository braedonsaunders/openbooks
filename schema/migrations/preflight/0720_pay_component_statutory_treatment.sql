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
    OR to_regprocedure('public.pay_component_vacation_creation_default_guard()') IS NOT NULL

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

  UNION ALL

  SELECT
    '0720.vacation_base_source_missing',
    'public.pay_components.vacationable is not available for the dated-policy backfill',
    'The migration preserves each existing vacation-base choice in its initial dated treatment before making the component flag creation-only.',
    'Preserve payroll history and resolve the exact source schema before applying this migration.'
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = to_regclass('public.pay_components')
       AND attribute.attname = 'vacationable' AND attribute.atttypid = 'boolean'::regtype
       AND attribute.attnotnull AND NOT attribute.attisdropped
  )

  UNION ALL

  SELECT
    '0720.query_catalog_refresh_missing',
    'the native governed-query catalog refresh is not available',
    'The migration removes the frozen pay-components view before retiring its static column, then restores the governed views through the native registry.',
    'Preserve the query catalog and restore its published native refresh function before applying this migration.'
  WHERE to_regprocedure('public.openbooks_refresh_query_catalog()') IS NULL

  UNION ALL

  SELECT
    '0720.pay_components_query_relation_changed',
    'openbooks_query.pay_components is not a governed view',
    'Only the disposable governed view may be removed before the source column is retired; a table or materialized view may contain retained data.',
    'Preserve the relation and obtain database-owner review of its definition, data, ownership and dependencies before applying this migration.'
  WHERE EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
     WHERE relation.oid = to_regclass('openbooks_query.pay_components')
       AND relation.relkind <> 'v'
  )

  UNION ALL

  SELECT DISTINCT
    '0720.pay_components_query_dependency_unreviewed',
    format('%I.%I', dependent_namespace.nspname, dependent_view.relname),
    'This view depends on the retiring static treatment column or its governed pay-components view. The migration removes only the native pay-components view and must preserve other dependent objects.',
    'Preserve the dependent view and obtain database-owner review of a forward definition using the effective-dated statutory treatment source before applying this migration.'
    FROM pg_catalog.pg_depend dependency
    JOIN pg_catalog.pg_rewrite rewrite ON rewrite.oid = dependency.objid
    JOIN pg_catalog.pg_class dependent_view ON dependent_view.oid = rewrite.ev_class
    JOIN pg_catalog.pg_namespace dependent_namespace ON dependent_namespace.oid = dependent_view.relnamespace
   WHERE dependency.classid = 'pg_catalog.pg_rewrite'::regclass
     AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
     AND dependency.deptype = 'n'
     AND dependent_view.oid IS DISTINCT FROM to_regclass('openbooks_query.pay_components')
     AND (
       dependency.refobjid = to_regclass('openbooks_query.pay_components')
       OR (
         dependency.refobjid = to_regclass('public.pay_components')
         AND dependency.refobjsubid = (
           SELECT attribute.attnum FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = to_regclass('public.pay_components')
              AND attribute.attname = 'program_exclusions'
              AND NOT attribute.attisdropped
         )
       )
     )
)
SELECT code, 'refuse'::text AS severity, subject, detail, remedy
  FROM findings;
