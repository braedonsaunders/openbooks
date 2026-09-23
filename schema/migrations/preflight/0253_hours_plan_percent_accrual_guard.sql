-- OpenBooks upgrade preflight for 0253_hours_plan_percent_accrual_guard.
--
-- Read-only mirror of the migration's precheck: an hours-denominated plan
-- that accrues a percent of earnings stores dollars as hours. Zero rows
-- means ready for 0253.
SELECT '0253.hours_percent_accrual' AS code,
       'refuse' AS severity,
       format('entitlement plan %s (org %s) banks hours but accrues a percent of earnings',
              p.code, p.org_id) AS subject,
       format('entitlement_plans row %s has unit hours with accrual_method percent_of_earnings', p.id) AS detail,
       'Change the plan to per_hour_worked or fixed_per_period, or change its unit to money, before applying 0253.' AS remedy
  FROM public.entitlement_plans p
 WHERE p.unit = 'hours' AND p.accrual_method = 'percent_of_earnings'
 ORDER BY p.org_id, p.code
 LIMIT 20;
