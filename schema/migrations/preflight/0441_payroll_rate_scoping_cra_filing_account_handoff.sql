-- OpenBooks upgrade preflight for 0441_payroll_rate_scoping_cra_filing_account_handoff.
-- Every refused row names the stored configuration that cannot be carried into
-- an effective-dated statutory rate or a CRA filing-account remitter type.
WITH payroll AS (
  SELECT o.id AS org_id, o.settings -> 'payroll' AS settings
    FROM public.orgs o
   WHERE jsonb_typeof(o.settings -> 'payroll') = 'object'
), cra_accounts AS (
  SELECT p.org_id,
         p.settings -> 'craRemittanceFrequency' AS frequency_value,
         count(f.id)::integer AS account_count,
         string_agg(format('%s (%s)', f.id, f.account_number), ', ' ORDER BY f.account_number) AS accounts
    FROM payroll p
    LEFT JOIN public.payroll_filing_accounts f
      ON f.org_id = p.org_id
     AND f.country = 'CA'
   WHERE p.settings ? 'craRemittanceFrequency'
   GROUP BY p.org_id, p.settings -> 'craRemittanceFrequency'
), cra_issues AS (
  SELECT '0441.ambiguous_cra_remitter' AS code,
         'refuse' AS severity,
         format('organization %s CRA frequency %s', c.org_id, coalesce(c.frequency_value::text, 'missing')) AS subject,
         CASE
           WHEN c.account_count = 0 THEN format('organization %s has a CRA frequency but no Canadian filing account', c.org_id)
           WHEN c.account_count <> 1 THEN format('organization %s has %s Canadian filing accounts: %s', c.org_id, c.account_count, c.accounts)
           ELSE format('organization %s has an unmappable CRA frequency value %s', c.org_id, c.frequency_value::text)
         END AS detail,
         'Create the required Canadian filing account or resolve duplicate accounts, then choose regular, quarterly, accelerated_1, or accelerated_2 in Payroll Setup → Filing accounts. The upgrade does not create accounts or choose between them.' AS remedy
    FROM cra_accounts c
   WHERE c.account_count <> 1
      OR NOT (
        c.frequency_value = 'null'::jsonb
        OR (jsonb_typeof(c.frequency_value) = 'string'
            AND c.frequency_value #>> '{}' IN ('regular', 'quarterly', 'accelerated_1', 'accelerated_2'))
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
  SELECT '0441.invalid_us_futa_rate' AS code,
         'refuse' AS severity,
         format('organization %s US FUTA rate', f.org_id) AS subject,
         format('stored value %s is not a decimal FUTA rate in the declared 0 to 0.2 range with at most four decimal places', f.value::text) AS detail,
         'Correct the effective FUTA rate for each state in Payroll Setup → Statutory rates before retrying the upgrade.' AS remedy
    FROM futa_values f
   WHERE NOT CASE
     WHEN jsonb_typeof(f.value) IN ('string', 'number')
      AND f.amount ~ '^[0-9]+(\.[0-9]{1,4})?$'
     THEN f.amount::numeric BETWEEN 0 AND 0.2
     ELSE false
   END
), sui_nodes AS (
  SELECT p.org_id, p.settings #> '{us,sui}' AS node
    FROM payroll p
   WHERE p.settings #> '{us,sui}' IS NOT NULL
     AND p.settings #> '{us,sui}' <> 'null'::jsonb
), sui_container_issues AS (
  SELECT '0441.invalid_us_sui_shape' AS code,
         'refuse' AS severity,
         format('organization %s US SUI rates', s.org_id) AS subject,
         format('stored state-rate collection has JSON type %s instead of an object', jsonb_typeof(s.node)) AS detail,
         'Enter each state rate and taxable wage base in Payroll Setup → Statutory rates before retrying the upgrade.' AS remedy
    FROM sui_nodes s
   WHERE jsonb_typeof(s.node) <> 'object'
), sui_entries AS (
  SELECT s.org_id, e.key AS region, e.value AS entry,
         e.value -> 'rate' AS rate_value,
         e.value ->> 'rate' AS rate_text,
         e.value -> 'wageBase' AS base_value,
         e.value ->> 'wageBase' AS base_text
    FROM sui_nodes s
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(s.node) = 'object' THEN s.node ELSE '{}'::jsonb END
    ) e
), sui_issues AS (
  SELECT '0441.invalid_us_sui_rate' AS code,
         'refuse' AS severity,
         format('organization %s US SUI region %s', s.org_id, s.region) AS subject,
         CASE
           WHEN s.region NOT IN (
             'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
           ) THEN format('region %s is not declared by the US payroll pack', s.region)
           WHEN jsonb_typeof(s.entry) <> 'object' THEN format('stored state value has JSON type %s instead of a rate object', jsonb_typeof(s.entry))
           WHEN s.rate_value IS NULL OR s.rate_value = 'null'::jsonb OR s.rate_text = ''
             OR s.base_value IS NULL OR s.base_value = 'null'::jsonb OR s.base_text = ''
             THEN 'the state rate and taxable wage base must both be present'
           WHEN s.entry - 'rate' - 'wageBase' <> '{}'::jsonb THEN 'the state rate object contains fields outside rate and wageBase'
           ELSE 'the rate or taxable wage base is outside its declared numeric format or range'
         END AS detail,
         'Enter a valid state experience rate and taxable wage base in Payroll Setup → Statutory rates before retrying the upgrade.' AS remedy
    FROM sui_entries s
   WHERE s.region NOT IN (
           'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
         )
      OR jsonb_typeof(s.entry) <> 'object'
      OR s.rate_value IS NULL OR s.rate_value = 'null'::jsonb OR s.rate_text = ''
      OR s.base_value IS NULL OR s.base_value = 'null'::jsonb OR s.base_text = ''
      OR CASE WHEN jsonb_typeof(s.entry) = 'object'
              THEN s.entry - 'rate' - 'wageBase' <> '{}'::jsonb
              ELSE false END
      OR NOT CASE
        WHEN jsonb_typeof(s.rate_value) IN ('string', 'number')
         AND s.rate_text ~ '^[0-9]+(\.[0-9]{1,4})?$'
        THEN s.rate_text::numeric BETWEEN 0 AND 0.2
        ELSE false
      END
      OR NOT CASE
        WHEN jsonb_typeof(s.base_value) IN ('string', 'number')
         AND s.base_text ~ '^[0-9]+(\.[0-9]{1,2})?$'
        THEN s.base_text::numeric BETWEEN 0 AND 10000000
        ELSE false
      END
), eht_nodes AS (
  SELECT p.org_id, p.settings #> '{ca,eht}' AS node
    FROM payroll p
   WHERE p.settings #> '{ca,eht}' IS NOT NULL
     AND p.settings #> '{ca,eht}' <> 'null'::jsonb
), eht_values AS (
  SELECT e.org_id, e.node,
         e.node -> 'enabled' AS enabled_value,
         e.node -> 'rate' AS rate_value,
         e.node ->> 'rate' AS rate_text,
         e.node -> 'annualExemption' AS exemption_value,
         e.node ->> 'annualExemption' AS exemption_text
    FROM eht_nodes e
), eht_issues AS (
  SELECT '0441.invalid_ca_eht_rate' AS code,
         'refuse' AS severity,
         format('organization %s Canadian employer health tax', e.org_id) AS subject,
         CASE
           WHEN jsonb_typeof(e.node) <> 'object' THEN format('stored EHT value has JSON type %s instead of an object', jsonb_typeof(e.node))
           WHEN e.node - 'enabled' - 'rate' - 'annualExemption' <> '{}'::jsonb THEN 'the EHT object contains fields outside enabled, rate, and annualExemption'
           WHEN e.enabled_value IS NOT NULL AND e.enabled_value <> 'null'::jsonb AND jsonb_typeof(e.enabled_value) <> 'boolean' THEN 'enabled is not a boolean'
           WHEN e.enabled_value = 'true'::jsonb AND (e.rate_value IS NULL OR e.rate_value = 'null'::jsonb OR e.rate_text = '') THEN 'enabled EHT has no rate'
           WHEN e.enabled_value IS DISTINCT FROM 'true'::jsonb AND (
             (e.rate_value IS NOT NULL AND e.rate_value <> 'null'::jsonb AND e.rate_text <> '')
             OR (e.exemption_value IS NOT NULL AND e.exemption_value <> 'null'::jsonb AND e.exemption_text <> '')
           ) THEN 'stored EHT amounts are not active under the old enabled flag and cannot be migrated without changing their meaning'
           ELSE 'the rate or annual exemption is outside its declared numeric format or range'
         END AS detail,
         'Enter the applicable EHT rate and exemption, or an explicit zero where the employer is not liable, in Payroll Setup → Statutory rates before retrying the upgrade.' AS remedy
    FROM eht_values e
   WHERE jsonb_typeof(e.node) <> 'object'
      OR CASE WHEN jsonb_typeof(e.node) = 'object'
              THEN e.node - 'enabled' - 'rate' - 'annualExemption' <> '{}'::jsonb
              ELSE false END
      OR (e.enabled_value IS NOT NULL AND e.enabled_value <> 'null'::jsonb AND jsonb_typeof(e.enabled_value) <> 'boolean')
      OR (e.enabled_value = 'true'::jsonb AND (
            e.rate_value IS NULL OR e.rate_value = 'null'::jsonb OR e.rate_text = ''
          ))
      OR (e.enabled_value IS DISTINCT FROM 'true'::jsonb AND (
            (e.rate_value IS NOT NULL AND e.rate_value <> 'null'::jsonb AND e.rate_text <> '')
            OR (e.exemption_value IS NOT NULL AND e.exemption_value <> 'null'::jsonb AND e.exemption_text <> '')
          ))
      OR (e.enabled_value = 'true'::jsonb AND NOT CASE
            WHEN jsonb_typeof(e.rate_value) IN ('string', 'number')
             AND e.rate_text ~ '^[0-9]+(\.[0-9]{1,4})?$'
            THEN e.rate_text::numeric BETWEEN 0 AND 10
            ELSE false
          END)
      OR (e.enabled_value = 'true' AND e.exemption_value IS NOT NULL
          AND e.exemption_value <> 'null'::jsonb AND e.exemption_text <> ''
          AND NOT CASE
            WHEN jsonb_typeof(e.exemption_value) IN ('string', 'number')
             AND e.exemption_text ~ '^[0-9]+(\.[0-9]{1,2})?$'
            THEN e.exemption_text::numeric BETWEEN 0 AND 100000000
            ELSE false
          END)
)
SELECT code, severity, subject, detail, remedy FROM cra_issues
UNION ALL
SELECT code, severity, subject, detail, remedy FROM futa_issues
UNION ALL
SELECT code, severity, subject, detail, remedy FROM sui_container_issues
UNION ALL
SELECT code, severity, subject, detail, remedy FROM sui_issues
UNION ALL
SELECT code, severity, subject, detail, remedy FROM eht_issues
ORDER BY code, subject;
