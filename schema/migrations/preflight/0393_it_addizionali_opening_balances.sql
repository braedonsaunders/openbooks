-- OpenBooks upgrade preflight for 0393_it_addizionali_opening_balances.
--
-- Read-only mirror of the installment channel's source rule: a year-N IT run
-- withholds the prior-year assessed saldo from the employee's committed year
-- N-1 December settlement, or from an explicit carry-in row once 0393 lands.
-- An employee with committed IT stubs in a year and no December settlement in
-- the year before will refuse by name on their next run until the assessed
-- figures are recorded — so each such employee is one finding, with the
-- remedy in hand. Zero rows means every IT history OpenBooks holds already
-- resolves, and the install is ready.
--
-- Severity is notice, not refuse, on purpose: the carry-in rows this names
-- can only be recorded AFTER 0393 applies (the table does not exist yet), so
-- refusing the upgrade on them would deadlock every install with a first-year
-- worker. The upgrade proceeds; the runtime refusal stays the hard gate.
SELECT '0393.it_saldo_source_missing' AS code,
       'notice' AS severity,
       format('org %s employee %s tax year %s has committed IT stubs but no prior-year December settlement',
              y.org_id, y.employee_party_id, y.tax_year) AS subject,
       format('%s committed stub(s): the %s December settlement (CONG_ADDREG_ANNUAL) is absent and no 0393 carry-in row can exist yet',
              y.stubs, y.tax_year - 1) AS detail,
       'Record the prior-year assessed addizionali (regionale and comunale, 0.00 when the worker had no prior-year Italian employment) in Payroll → Opening balances after applying 0393, or settle the prior December in OpenBooks first.' AS remedy
  FROM (
    SELECT s.org_id, s.employee_party_id, s.tax_year, count(*) AS stubs
      FROM public.pay_stubs s
      JOIN public.pay_runs r
        ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
       AND r.run_status = 'committed'
      JOIN public.documents d
        ON d.org_id = r.org_id AND d.id = r.document_id
       AND d.status <> 'voided'
     WHERE s.country = 'IT'
     GROUP BY s.org_id, s.employee_party_id, s.tax_year
  ) y
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.pay_stubs s
     JOIN public.pay_runs r
       ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
      AND r.run_status = 'committed'
     JOIN public.documents d
       ON d.org_id = r.org_id AND d.id = r.document_id
      AND d.status <> 'voided'
    WHERE s.org_id = y.org_id
      AND s.employee_party_id = y.employee_party_id
      AND s.country = 'IT'
      AND s.tax_year = y.tax_year - 1
      AND s.factors ? 'CONG_ADDREG_ANNUAL'
 )
 ORDER BY y.org_id, y.tax_year, y.employee_party_id
 LIMIT 20;
