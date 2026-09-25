-- OpenBooks forward migration 0396_payroll_opening_balance_employer_cpp_ei_ytd.
--
-- The T4 Summary's employer share has the same mid-year-adoption gap
-- migrations 0143 and 0395 closed for employer QPIP/WCB levies and Québec
-- income tax: payroll_opening_balances carries the employee-side CPP/CPP2/EI
-- money in cpp_ytd/cpp2_ytd/ei_ytd, so a mid-year adopter's employer CPP,
-- second additional CPP, and EI premiums paid by the prior provider are
-- unrecordable and the Summary's employer share reconciles to the committed
-- stubs alone — understating the year's employer levies by exactly the prior
-- provider's amounts.
--
-- Additive, ledger-tracked, no history reinterpretation: three NOT NULL
-- DEFAULT 0 columns (the convention every other year-to-date column on this
-- table follows), a column comment each, and the reporting view widened to
-- match with the new columns appended after every existing column. Existing
-- rows read back as zero, which is exactly what "nothing carried in" has
-- always meant here.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS employer_cpp_ytd numeric(19,4) DEFAULT 0 NOT NULL;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS employer_cpp2_ytd numeric(19,4) DEFAULT 0 NOT NULL;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS employer_ei_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.employer_cpp_ytd IS
  'Employer CPP contributions paid before adoption (T4 Summary employer-share year-to-date). Distinct from cpp_ytd, which is the employee-side T4-box-16 money; zero when the prior provider reports none.';

COMMENT ON COLUMN public.payroll_opening_balances.employer_cpp2_ytd IS
  'Employer second additional CPP contributions paid before adoption (T4 Summary employer-share year-to-date). Distinct from cpp2_ytd, which is the employee-side T4-box-16A money; zero when the prior provider reports none.';

COMMENT ON COLUMN public.payroll_opening_balances.employer_ei_ytd IS
  'Employer EI premiums paid before adoption (T4 Summary employer-share year-to-date). Distinct from ei_ytd, which is the employee-side T4-box-18 money; zero when the prior provider reports none.';

DROP VIEW IF EXISTS openbooks_query.payroll_opening_balances;
CREATE VIEW openbooks_query.payroll_opening_balances WITH (security_barrier='true') AS
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
    wcb_assessable_ytd,
    eht_remuneration_ytd,
    qc_tax_ytd,
    employer_cpp_ytd,
    employer_cpp2_ytd,
    employer_ei_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON openbooks_query.payroll_opening_balances TO openbooks_read;
