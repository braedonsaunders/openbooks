-- OpenBooks forward migration 0441_payroll_rate_scoping_cra_filing_account_handoff.
-- Move stored payroll configuration to the scopes that own the statutory rate
-- and CRA remitter type before removing the organization-level settings.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The read-only preflight names every row that cannot be preserved. Repeat its
-- refusal in the write path so applying this file directly cannot guess or
-- discard an unmappable value.
DO $precheck$
DECLARE
  blockers text;
BEGIN
  -- Hold the organization rows while the source shapes and child-account
  -- cardinality are checked. Child inserts take a key-share lock on this row.
  PERFORM o.id
    FROM public.orgs o
   WHERE jsonb_typeof(o.settings -> 'payroll') = 'object'
     AND (
       ((o.settings -> 'payroll') ? 'craRemittanceFrequency')
       OR (jsonb_typeof(o.settings #> '{payroll,us}') = 'object'
           AND (o.settings #> '{payroll,us}') ?| ARRAY['futaRate','sui'])
       OR (jsonb_typeof(o.settings #> '{payroll,ca}') = 'object'
           AND (o.settings #> '{payroll,ca}') ? 'eht')
     )
   ORDER BY o.id
   FOR UPDATE;

  WITH payroll AS (
    SELECT o.id AS org_id, o.settings -> 'payroll' AS settings
      FROM public.orgs o
     WHERE jsonb_typeof(o.settings -> 'payroll') = 'object'
  ), cra_accounts AS (
    SELECT p.org_id,
           p.settings -> 'craRemittanceFrequency' AS frequency_value,
           count(f.id)::integer AS account_count
      FROM payroll p
      LEFT JOIN public.payroll_filing_accounts f
        ON f.org_id = p.org_id AND f.country = 'CA'
     WHERE p.settings ? 'craRemittanceFrequency'
     GROUP BY p.org_id, p.settings -> 'craRemittanceFrequency'
  ), cra_issues AS (
    SELECT format('organization %s CRA frequency %s', org_id, frequency_value::text) AS detail
      FROM cra_accounts
     WHERE account_count <> 1
        OR NOT (
          frequency_value = 'null'::jsonb
          OR (jsonb_typeof(frequency_value) = 'string'
              AND frequency_value #>> '{}' IN ('regular', 'quarterly', 'accelerated_1', 'accelerated_2'))
        )
  ), futa_values AS (
    SELECT p.org_id,
           p.settings #> '{us,futaRate}' AS value,
           p.settings #>> '{us,futaRate}' AS amount
      FROM payroll p
     WHERE p.settings #> '{us,futaRate}' IS NOT NULL
       AND p.settings #> '{us,futaRate}' <> 'null'::jsonb
       AND p.settings #>> '{us,futaRate}' <> ''
  ), futa_issues AS (
    SELECT format('organization %s US FUTA rate %s', org_id, value::text) AS detail
      FROM futa_values
     WHERE NOT CASE
       WHEN jsonb_typeof(value) IN ('string', 'number')
        AND amount ~ '^[0-9]+(\.[0-9]{1,4})?$'
       THEN amount::numeric BETWEEN 0 AND 0.2
       ELSE false
     END
  ), sui_nodes AS (
    SELECT p.org_id, p.settings #> '{us,sui}' AS node
      FROM payroll p
     WHERE p.settings #> '{us,sui}' IS NOT NULL
       AND p.settings #> '{us,sui}' <> 'null'::jsonb
  ), sui_issues AS (
    SELECT format('organization %s US SUI value has JSON type %s', org_id, jsonb_typeof(node)) AS detail
      FROM sui_nodes
     WHERE jsonb_typeof(node) <> 'object'
    UNION ALL
    SELECT format('organization %s US SUI region %s has an unmappable value', s.org_id, e.key) AS detail
      FROM sui_nodes s
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(s.node) = 'object' THEN s.node ELSE '{}'::jsonb END
      ) e
     WHERE e.key NOT IN (
       'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
     )
        OR jsonb_typeof(e.value) <> 'object'
        OR e.value -> 'rate' IS NULL OR e.value -> 'rate' = 'null'::jsonb OR e.value ->> 'rate' = ''
        OR e.value -> 'wageBase' IS NULL OR e.value -> 'wageBase' = 'null'::jsonb OR e.value ->> 'wageBase' = ''
        OR CASE WHEN jsonb_typeof(e.value) = 'object'
                THEN e.value - 'rate' - 'wageBase' <> '{}'::jsonb
                ELSE false END
        OR NOT CASE
          WHEN jsonb_typeof(e.value -> 'rate') IN ('string', 'number')
           AND e.value ->> 'rate' ~ '^[0-9]+(\.[0-9]{1,4})?$'
          THEN (e.value ->> 'rate')::numeric BETWEEN 0 AND 0.2
          ELSE false
        END
        OR NOT CASE
          WHEN jsonb_typeof(e.value -> 'wageBase') IN ('string', 'number')
           AND e.value ->> 'wageBase' ~ '^[0-9]+(\.[0-9]{1,2})?$'
          THEN (e.value ->> 'wageBase')::numeric BETWEEN 0 AND 10000000
          ELSE false
        END
  ), eht_nodes AS (
    SELECT p.org_id, p.settings #> '{ca,eht}' AS node
      FROM payroll p
     WHERE p.settings #> '{ca,eht}' IS NOT NULL
       AND p.settings #> '{ca,eht}' <> 'null'::jsonb
  ), eht_issues AS (
    SELECT format('organization %s Canadian EHT value has JSON type %s', org_id, jsonb_typeof(node)) AS detail
      FROM eht_nodes
     WHERE jsonb_typeof(node) <> 'object'
    UNION ALL
    SELECT format('organization %s Canadian EHT values cannot be represented without changing their meaning', org_id) AS detail
      FROM eht_nodes e
     WHERE jsonb_typeof(e.node) = 'object'
       AND (
         CASE WHEN jsonb_typeof(e.node) = 'object'
              THEN e.node - 'enabled' - 'rate' - 'annualExemption' <> '{}'::jsonb
              ELSE false END
         OR (e.node -> 'enabled' IS NOT NULL AND e.node -> 'enabled' <> 'null'::jsonb
             AND jsonb_typeof(e.node -> 'enabled') <> 'boolean')
         OR (e.node -> 'enabled' = 'true'::jsonb AND (
               e.node -> 'rate' IS NULL OR e.node -> 'rate' = 'null'::jsonb OR e.node ->> 'rate' = ''
             ))
         OR (e.node -> 'enabled' IS DISTINCT FROM 'true'::jsonb AND (
               (e.node -> 'rate' IS NOT NULL AND e.node -> 'rate' <> 'null'::jsonb AND e.node ->> 'rate' <> '')
               OR (e.node -> 'annualExemption' IS NOT NULL AND e.node -> 'annualExemption' <> 'null'::jsonb AND e.node ->> 'annualExemption' <> '')
             ))
         OR (e.node -> 'enabled' = 'true'::jsonb AND NOT CASE
               WHEN jsonb_typeof(e.node -> 'rate') IN ('string', 'number')
                AND e.node ->> 'rate' ~ '^[0-9]+(\.[0-9]{1,4})?$'
               THEN (e.node ->> 'rate')::numeric BETWEEN 0 AND 10
               ELSE false
             END)
         OR (e.node -> 'enabled' = 'true'::jsonb
             AND e.node -> 'annualExemption' IS NOT NULL
             AND e.node -> 'annualExemption' <> 'null'::jsonb
             AND e.node ->> 'annualExemption' <> ''
             AND NOT CASE
               WHEN jsonb_typeof(e.node -> 'annualExemption') IN ('string', 'number')
                AND e.node ->> 'annualExemption' ~ '^[0-9]+(\.[0-9]{1,2})?$'
               THEN (e.node ->> 'annualExemption')::numeric BETWEEN 0 AND 100000000
               ELSE false
             END)
       )
  ), issues AS (
    SELECT detail FROM cra_issues
    UNION ALL SELECT detail FROM futa_issues
    UNION ALL SELECT detail FROM sui_issues
    UNION ALL SELECT detail FROM eht_issues
  )
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO blockers FROM issues;

  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION '0441 cannot safely scope payroll configuration: %; resolve the listed values in Payroll Setup → Filing accounts or Payroll Setup → Statutory rates, then retry', blockers;
  END IF;
END;
$precheck$;

-- Capture the unambiguous CRA handoff before removing the organization key.
CREATE TEMP TABLE migration_0441_cra_accounts ON COMMIT DROP AS
SELECT f.id AS account_id,
       f.org_id,
       f.remitter_type AS old_remitter_type,
       CASE WHEN o.settings #> '{payroll,craRemittanceFrequency}' = 'null'::jsonb
            THEN 'regular'
            ELSE o.settings #>> '{payroll,craRemittanceFrequency}'
       END AS new_remitter_type
  FROM public.orgs o
  JOIN public.payroll_filing_accounts f
    ON f.org_id = o.id AND f.country = 'CA'
 WHERE jsonb_typeof(o.settings #> '{payroll}') = 'object'
   AND o.settings #> '{payroll,craRemittanceFrequency}' IS NOT NULL;

-- The old blobs had no effective year. Their live setup values become the
-- current 2026 declarations; existing scoped rows remain authoritative.
CREATE TEMP TABLE migration_0441_statutory_rates ON COMMIT DROP AS
WITH payroll AS (
  SELECT o.id AS org_id, o.settings -> 'payroll' AS settings
    FROM public.orgs o
   WHERE jsonb_typeof(o.settings -> 'payroll') = 'object'
), states(region) AS (
  SELECT unnest(ARRAY[
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
  ]::text[])
), legacy_rows AS (
  SELECT p.org_id, 'US'::text AS country, 'us_futa'::text AS rate_key,
         s.region, NULL::text AS sub_region, NULL::uuid AS filing_account_id,
         jsonb_build_object('rate', p.settings #>> '{us,futaRate}') AS rate_values
    FROM payroll p CROSS JOIN states s
   WHERE p.settings #> '{us,futaRate}' IS NOT NULL
     AND p.settings #> '{us,futaRate}' <> 'null'::jsonb
     AND p.settings #>> '{us,futaRate}' <> ''
  UNION ALL
  SELECT p.org_id, 'US', 'us_sui', e.key, NULL::text, NULL::uuid,
         jsonb_build_object('rate', e.value ->> 'rate', 'wageBase', e.value ->> 'wageBase')
    FROM payroll p
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(p.settings #> '{us,sui}') = 'object'
           THEN p.settings #> '{us,sui}' ELSE '{}'::jsonb END
    ) e
  UNION ALL
  SELECT p.org_id, 'CA', 'ca_eht', 'ON', NULL::text, NULL::uuid,
         jsonb_build_object('rate', p.settings #>> '{ca,eht,rate}')
         || CASE
              WHEN p.settings #> '{ca,eht,annualExemption}' IS NOT NULL
               AND p.settings #> '{ca,eht,annualExemption}' <> 'null'::jsonb
               AND p.settings #>> '{ca,eht,annualExemption}' <> ''
              THEN jsonb_build_object('annualExemption', p.settings #>> '{ca,eht,annualExemption}')
              ELSE '{}'::jsonb
            END
    FROM payroll p
   WHERE p.settings #> '{ca,eht,enabled}' = 'true'::jsonb
), missing_rows AS (
  SELECT l.*
    FROM legacy_rows l
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.payroll_statutory_rates r
      WHERE r.org_id = l.org_id
        AND r.country = l.country
        AND r.rate_key = l.rate_key
        AND r.tax_year = 2026
        AND r.region IS NOT DISTINCT FROM l.region
        AND r.sub_region IS NOT DISTINCT FROM l.sub_region
        AND r.filing_account_id IS NOT DISTINCT FROM l.filing_account_id
        AND r.superseded_on IS NULL
   )
)
SELECT public.uuid_generate_v7() AS id,
       org_id, country, rate_key, region, sub_region, filing_account_id,
       2026 AS tax_year, rate_values
  FROM missing_rows;

CREATE TEMP TABLE migration_0441_org_settings ON COMMIT DROP AS
SELECT o.id AS org_id,
       o.settings AS before_settings,
       o.settings #> '{payroll}' AS before_payroll,
       o.settings #- '{payroll,craRemittanceFrequency}'
                    #- '{payroll,us,futaRate}'
                    #- '{payroll,us,sui}'
                    #- '{payroll,ca,eht}' AS after_settings
  FROM public.orgs o
 WHERE jsonb_typeof(o.settings #> '{payroll}') = 'object'
   AND (
     (o.settings #> '{payroll}') ? 'craRemittanceFrequency'
     OR (jsonb_typeof(o.settings #> '{payroll,us}') = 'object'
         AND (o.settings #> '{payroll,us}') ?| ARRAY['futaRate','sui'])
     OR (jsonb_typeof(o.settings #> '{payroll,ca}') = 'object'
         AND (o.settings #> '{payroll,ca}') ? 'eht')
   );

DO $handoff$
DECLARE
  expected_rows bigint;
  changed_rows bigint;
BEGIN
  SELECT count(*) INTO expected_rows FROM migration_0441_cra_accounts
   WHERE old_remitter_type IS DISTINCT FROM new_remitter_type;
  IF expected_rows > 0 THEN
    UPDATE public.payroll_filing_accounts f
       SET remitter_type = m.new_remitter_type,
           updated_at = clock_timestamp(),
           updated_by = NULL
      FROM migration_0441_cra_accounts m
     WHERE f.id = m.account_id
       AND f.org_id = m.org_id
       AND f.remitter_type IS NOT DISTINCT FROM m.old_remitter_type
       AND f.remitter_type IS DISTINCT FROM m.new_remitter_type;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 CRA filing-account handoff updated % of % expected rows; retry after resolving concurrent account changes', changed_rows, expected_rows;
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    SELECT org_id, 'payroll_filing_accounts', account_id, 'update',
           jsonb_build_object(
             'operation', 'cra_remitter_type_migration',
             'before', jsonb_build_object('remitter_type', old_remitter_type),
             'after', jsonb_build_object('remitter_type', new_remitter_type)
           )
      FROM migration_0441_cra_accounts
     WHERE old_remitter_type IS DISTINCT FROM new_remitter_type;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 CRA filing-account audit wrote % of % expected rows', changed_rows, expected_rows;
    END IF;
  END IF;

  SELECT count(*) INTO expected_rows FROM migration_0441_statutory_rates;
  IF expected_rows > 0 THEN
    -- An exact-scope current row remains authoritative. ON CONFLICT handles a
    -- concurrent setup save, and the row-count assertion rolls back instead of
    -- silently dropping the staged legacy value.
    INSERT INTO public.payroll_statutory_rates
      (id, org_id, country, rate_key, region, sub_region, filing_account_id,
       tax_year, rate_values, created_by, updated_by)
    SELECT id, org_id, country, rate_key, region, sub_region, filing_account_id,
           tax_year, rate_values, NULL, NULL
      FROM migration_0441_statutory_rates
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 statutory-rate backfill inserted % of % staged rows; retry after resolving concurrent statutory-rate changes', changed_rows, expected_rows;
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    SELECT org_id, 'payroll_statutory_rates', id, 'insert',
           jsonb_build_object(
             'operation', 'pre_scoping_payroll_rate_migration',
             'after', jsonb_build_object(
               'country', country, 'rate_key', rate_key, 'region', region,
               'tax_year', tax_year, 'rate_values', rate_values
             )
           )
      FROM migration_0441_statutory_rates;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 statutory-rate audit wrote % of % expected rows', changed_rows, expected_rows;
    END IF;
  END IF;

  SELECT count(*) INTO expected_rows FROM migration_0441_org_settings;
  IF expected_rows > 0 THEN
    UPDATE public.orgs o
       SET settings = m.after_settings,
           updated_at = clock_timestamp(),
           updated_by = NULL
      FROM migration_0441_org_settings m
     WHERE o.id = m.org_id
       AND o.settings IS NOT DISTINCT FROM m.before_settings;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 payroll setting cleanup updated % of % expected organizations', changed_rows, expected_rows;
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes)
    SELECT org_id, 'orgs', org_id, 'update',
           jsonb_build_object(
             'operation', 'payroll_pre_scoping_settings_migration',
             'before', jsonb_build_object('payroll', before_payroll),
             'after', jsonb_build_object('payroll', after_settings -> 'payroll')
           )
      FROM migration_0441_org_settings;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> expected_rows THEN
      RAISE EXCEPTION '0441 payroll setting audit wrote % of % expected organizations', changed_rows, expected_rows;
    END IF;
  END IF;
END;
$handoff$;
