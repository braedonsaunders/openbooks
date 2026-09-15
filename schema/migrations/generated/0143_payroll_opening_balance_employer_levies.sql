-- OpenBooks forward migration 0143_payroll_opening_balance_employer_levies.
--
-- Capped EMPLOYER levies have the same mid-year-adoption gap migration 0141
-- closed for bonus-attributed history: their annual maximums consume committed
-- stubs only, so history a prior provider holds is unrecordable and the first
-- stub re-opens the full annual room. Québec employer QPIP premiums run
-- against the year's maxEmployer ($620.06 for 2026, T4127 caps them there),
-- and WCB/WSIB assessable earnings run against the worker-comp group's
-- max_assessable per employee. A long-tenure employee adopted mid-year would
-- otherwise over-accrue employer burden and liability already paid — up to a
-- full second annual maximum per head.
--
-- Additive, ledger-tracked, no history reinterpretation: two NOT NULL
-- DEFAULT 0 columns (the convention every other year-to-date column on this
-- table follows), column comments, and the reporting view widened to match
-- with the new columns appended after every existing column. Existing rows
-- read back as zero, which is exactly what "nothing carried in" has always
-- meant here.
ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS qpip_employer_ytd numeric(19,4) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS wcb_assessable_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.qpip_employer_ytd IS
  'Employer QPIP premiums already paid this year before adoption (Quebec). Counts toward the annual employer maximum; zero when the prior provider reports none.';
COMMENT ON COLUMN public.payroll_opening_balances.wcb_assessable_ytd IS
  'Workers-compensation assessable earnings already paid this year before adoption. Counts toward the worker-comp group annual maximum per employee; zero when the prior provider reports none.';

CREATE OR REPLACE VIEW openbooks_query.payroll_opening_balances WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    employee_party_id,
    tax_year,
    pensionable_ytd,
    insurable_ytd,
    cpp_ytd,
    cpp2_ytd,
    ei_ytd,
    qpip_ytd,
    taxable_ytd,
    tax_ytd,
    non_periodic_ytd,
    vacation_balance,
    created_at,
    created_by,
    updated_at,
    updated_by,
    cpp2_bonus_ytd,
    qc_csb_ytd,
    fica_withheld_ytd,
    qpip_employer_ytd,
    wcb_assessable_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());
