-- OpenBooks forward migration 0395_payroll_opening_balance_qc_tax_ytd.
--
-- Québec income tax withheld has the same mid-year-adoption gap migration
-- 0143 closed for capped employer levies: payroll_opening_balances carries
-- the federal T4-box-22 money in tax_ytd, so a mid-year adopter's Québec
-- income tax withheld by the prior provider is unrecordable and the RL-1
-- Box E reconciles to the committed stubs alone — understating the year's
-- Québec tax by exactly the prior provider's amount. Revenu Québec requires
-- Box E to report total Québec income tax withheld during the year (RL-1
-- guide s. 5.7).
--
-- Additive, ledger-tracked, no history reinterpretation: one NOT NULL
-- DEFAULT 0 column (the convention every other year-to-date column on this
-- table follows), a column comment, and the reporting view widened to match
-- with the new column appended after every existing column. Existing rows
-- read back as zero, which is exactly what "nothing carried in" has always
-- meant here.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS qc_tax_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.qc_tax_ytd IS
  'Quebec income tax withheld before adoption (RL-1 Box E year-to-date). Distinct from tax_ytd, which is the federal T4-box-22 money; zero when the prior provider reports none.';

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
    qc_tax_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON openbooks_query.payroll_opening_balances TO openbooks_read;
