SELECT
  'fx_rates_non_positive'::text AS code,
  'refuse'::text AS severity,
  concat(org_id::text, '/', from_currency, '→', to_currency, '/', as_of::text, '/', id::text) AS subject,
  'The FX observation is zero or negative and cannot be used as a valid exchange ratio.'::text AS detail,
  'Use the identified observation to obtain the correct positive quote from its source, correct the stored rate through an audited database repair, and rerun this preflight.'::text AS remedy
FROM public.fx_rates
WHERE rate <= 0;
