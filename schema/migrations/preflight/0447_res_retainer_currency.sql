-- OpenBooks upgrade preflight for 0447_res_retainer_currency.
-- Every retainer needs either its customer's currency or the organization's base currency.
SELECT '0447.retainer_currency_unresolved' AS code,
       'refuse' AS severity,
       format('retainer %s in organization %s', r.id, r.org_id) AS subject,
       'the customer has no currency and the organization has no base currency' AS detail,
       'Set the customer currency or the organization base currency before retrying the upgrade.' AS remedy
  FROM public.res_retainers r
  JOIN public.orgs o ON o.id = r.org_id
  LEFT JOIN public.customer_roles cr
    ON cr.org_id = r.org_id AND cr.party_id = r.customer_party_id
 WHERE nullif(btrim(cr.currency), '') IS NULL
   AND nullif(btrim(o.base_currency), '') IS NULL;
