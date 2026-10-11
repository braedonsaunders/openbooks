-- Existing exchange-rate rows keep their series names. Invalid registry keys require an explicit owner reconciliation.
SELECT '0691.invalid_rate_type' AS code,'refuse' AS severity,
 format('exchange-rate series %s in organization %s',rate_type,org_id) AS subject,
 'The stored series key cannot be registered as a native exchange-rate type.' AS detail,
 'Reconcile the series identity through the native rate configuration before retrying the upgrade.' AS remedy
FROM public.fx_rates WHERE rate_type !~ '^[a-z][a-z0-9_]{0,63}$' GROUP BY org_id,rate_type;
