WITH findings AS (
  SELECT
    '0720.statutory_treatment_table_exists'::text AS code,
    'public.pay_component_statutory_treatments already exists without this migration being recorded'::text AS subject,
    'The migration creates and guards this relation; an existing object must be compared with the reviewed migration before proceeding.'::text AS detail,
    'Preserve the object and tenant data; compare its columns, constraints, indexes, triggers, policies and query-catalog entry with the reviewed migration before recording or applying any change.'::text AS remedy
  WHERE to_regclass('public.pay_component_statutory_treatments') IS NOT NULL

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
