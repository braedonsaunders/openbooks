-- OpenBooks forward migration 0411_payroll_employer_fact_account_scope.
-- Extend audited employer facts to bind generic values to one filing account.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP INDEX public.payroll_employer_facts_org_point;

ALTER TABLE public.payroll_employer_facts
  ALTER COLUMN subsidiary_id DROP NOT NULL,
  ADD COLUMN filing_account_id uuid,
  ADD CONSTRAINT payroll_employer_facts_org_filing_account_fkey
    FOREIGN KEY (org_id, filing_account_id)
    REFERENCES public.payroll_filing_accounts (org_id, id) ON DELETE RESTRICT DEFERRABLE,
  ADD CONSTRAINT payroll_employer_facts_scope
    CHECK ((subsidiary_id IS NOT NULL AND filing_account_id IS NULL)
        OR (subsidiary_id IS NULL AND filing_account_id IS NOT NULL));

CREATE UNIQUE INDEX payroll_employer_facts_org_point
  ON public.payroll_employer_facts
    (org_id,
     coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid),
     country, fact_key, effective_from,
     coalesce(filing_account_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE superseded_on IS NULL;

COMMENT ON COLUMN public.payroll_employer_facts.subsidiary_id IS
  'Legal-employer scope for subsidiary facts; null for filing-account facts.';
COMMENT ON COLUMN public.payroll_employer_facts.filing_account_id IS
  'Filing-account scope for account-specific facts; null for legal-employer facts.';

SELECT public.openbooks_refresh_query_catalog();
