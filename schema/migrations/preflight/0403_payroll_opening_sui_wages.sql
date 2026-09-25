-- OpenBooks upgrade preflight for 0403_payroll_opening_sui_wages.
--
-- Read-only notice (never a refusal: the migration is purely additive and
-- safe to apply regardless). After 0403 ships, a US run whose employee
-- carries an opening insurable balance with no per-state SUI split keeps
-- hitting the named I6-payroll-38 transfer refusal until the wages are
-- allocated to states. Zero rows means no US carry-in needs allocating.
SELECT '0403.unallocated_sui_opening' AS code,
       'notice' AS severity,
       format('employee %s (%s) carries an opening insurable balance of %s for %s with no per-state SUI split',
              p.display_name, b.employee_party_id, b.insurable_ytd, b.tax_year) AS subject,
       format('payroll_opening_balances for %s/%s holds unscoped insurable wages; the SUI transfer refusal will name them until they are allocated',
              b.employee_party_id, b.tax_year) AS detail,
       'Enter the state allocation in Payroll → Opening balances (one SUI row per state) before the next US run for this employee.' AS remedy
  FROM public.payroll_opening_balances b
  JOIN public.parties p ON p.id = b.employee_party_id AND p.org_id = b.org_id
  JOIN public.employee_payroll_profiles prof
    ON prof.org_id = b.org_id AND prof.employee_party_id = b.employee_party_id
 WHERE b.insurable_ytd > 0
   AND prof.country = 'US'
 ORDER BY p.display_name, b.tax_year
 LIMIT 50;
