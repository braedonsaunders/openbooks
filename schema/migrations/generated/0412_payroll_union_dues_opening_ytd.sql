-- OpenBooks forward migration 0412_payroll_union_dues_opening_ytd.
--
-- A mid-year adopter's prior provider withholds eligible union dues the
-- year-end slips must report in full: T4 box 44 and, for Québec employment,
-- RL-1 box F both require the total dues deducted during the calendar year,
-- but the opening-balance model carried wages, tax, CPP/QPP, EI and QPIP
-- with no union-dues column, so the builders priced only committed
-- OpenBooks stubs and understated deductible dues by the pre-adoption
-- amount. A $500 pre-adoption / $400 stub split reported $400 instead of
-- $900.
--
-- Additive, ledger-tracked, no history reinterpretation: one NOT NULL
-- DEFAULT 0 column (the convention every other year-to-date column on this
-- table follows), a column comment, and the reporting view widened to match
-- with the new column appended after every existing column. Existing rows
-- read back as zero, which is exactly what "nothing carried in" has always
-- meant here.
--
-- The view is dropped and recreated (not CREATE OR REPLACE): governed
-- openbooks_query.* views have drifted column order from the baseline on
-- real installs, and CREATE OR REPLACE refuses to reorder columns
-- ("cannot change name of view column" aborted a deploy once already).
-- Nothing depends on this view, and the read role's grant is restored
-- explicitly below.
--
-- Recreated on current main (I6-payroll-250): the view carries main's newer
-- columns (qc_tax_ytd, employer_cpp/cpp2/ei_ytd) with union_dues_ytd
-- appended after them, so this migration widens rather than narrows the
-- reporting view.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS union_dues_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.union_dues_ytd IS
  'Eligible union dues already withheld this year before adoption (Canada). Folds into T4 box 44 and RL-1 box F with the committed stubs; zero when the prior provider reports none.';

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
    employer_ei_ytd,
    union_dues_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON openbooks_query.payroll_opening_balances TO openbooks_read;
