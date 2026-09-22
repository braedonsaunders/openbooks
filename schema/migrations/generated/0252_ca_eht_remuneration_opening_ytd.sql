-- OpenBooks forward migration 0252_ca_eht_remuneration_opening_ytd.
--
-- Ontario EHT has the same mid-year-adoption gap migrations 0141 and 0143
-- closed for bonus-attributed history and capped employer levies: the annual
-- exemption consumes committed stub EHT_EARN only, so remuneration a prior
-- provider already paid is unrecordable and the first stub re-opens the full
-- exemption. A mid-year adopter with $1M of pre-adoption Ontario payroll
-- would otherwise under-accrue EHT already owed — up to the full exemption
-- slice of liability per year.
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

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payroll_opening_balances
  ADD COLUMN IF NOT EXISTS eht_remuneration_ytd numeric(19,4) DEFAULT 0 NOT NULL;

COMMENT ON COLUMN public.payroll_opening_balances.eht_remuneration_ytd IS
  'EHT-subject remuneration already paid this year before adoption (Ontario, British Columbia, Manitoba). Counts toward the employer''s annual EHT exemption in the employee''s current payroll province; zero when the prior provider reports none.';

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
    eht_remuneration_ytd
   FROM public.payroll_opening_balances
  WHERE (org_id = public.openbooks_query_org_id());

GRANT SELECT ON openbooks_query.payroll_opening_balances TO openbooks_read;
