-- OpenBooks forward migration 0141_payroll_opening_balance_second_order_ytd.
--
-- A mid-year adopter's prior provider reports what was withheld ON lump sums,
-- not just the lump sums themselves: the CPP2 attributed to bonuses (T4127
-- factor F5B), the additional-QPP attributed to bonuses (TP-1015 factor CSB1),
-- and the employee FICA dollars already withheld (the year-to-date behind
-- Massachusetts' $2,000 retirement-contribution subtraction). Without columns
-- for them the carry-in silently dropped that history: every bonus was then
-- taxed as if no bonus had been paid before, and every US stub re-granted the
-- full $2,000 subtraction.
--
-- Additive, ledger-tracked, no history reinterpretation: three NOT NULL
-- DEFAULT 0 columns (the convention every other year-to-date column on this
-- table follows), column comments, and the reporting view widened to match.
-- Existing rows read back as zero, which is exactly what "nothing carried in"
-- has always meant here.
ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS cpp2_bonus_ytd numeric(19,4) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS qc_csb_ytd numeric(19,4) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS fica_withheld_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.cpp2_bonus_ytd IS
  'Second additional CPP contributions withheld ON lump-sum payments before adoption (T4127 factor F5B year-to-date). Reduces the bonus-method base of the first bonus; zero when the prior provider reports none.';
COMMENT ON COLUMN public.payroll_opening_balances.qc_csb_ytd IS
  'Additional-QPP (CSB) amounts attributed to lump-sum payments before adoption (TP-1015 factor CSB1 year-to-date, Quebec). Reduces the lump-sum annual income of the first bonus; zero when the prior provider reports none.';
COMMENT ON COLUMN public.payroll_opening_balances.fica_withheld_ytd IS
  'Employee Social Security and Medicare tax, including Additional Medicare, already withheld this year before adoption (US). Counts toward year-to-date caps that read withheld dollars rather than wages, such as the Massachusetts $2,000 retirement-contribution subtraction.';

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
    fica_withheld_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());
