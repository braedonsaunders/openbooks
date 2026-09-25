-- OpenBooks forward migration 0410_payroll_opening_account_bases.
-- Preserve filing-account-scoped statutory wage-base carry-ins for payroll.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.payroll_opening_account_bases (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  tax_year integer NOT NULL,
  program_key text NOT NULL,
  filing_account_id uuid NOT NULL,
  region text,
  insurable_ytd numeric(19,4) DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT payroll_opening_account_bases_pkey PRIMARY KEY (id),
  CONSTRAINT payroll_opening_account_bases_parent_fk
    FOREIGN KEY (org_id, employee_party_id, tax_year)
    REFERENCES public.payroll_opening_balances (org_id, employee_party_id, tax_year)
    ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT payroll_opening_account_bases_account_fk
    FOREIGN KEY (org_id, filing_account_id)
    REFERENCES public.payroll_filing_accounts(org_id, id)
    ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT payroll_opening_account_bases_program_key CHECK (length(btrim(program_key)) > 0),
  CONSTRAINT payroll_opening_account_bases_region CHECK (region IS NULL OR region ~ '^[A-Z]{2}$'),
  CONSTRAINT payroll_opening_account_bases_nonnegative CHECK (insurable_ytd >= 0),
  CONSTRAINT payroll_opening_account_bases_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT payroll_opening_account_bases_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT payroll_opening_account_bases_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

CREATE UNIQUE INDEX payroll_opening_account_bases_org_point
  ON public.payroll_opening_account_bases
    (org_id, employee_party_id, tax_year, program_key, filing_account_id, coalesce(region, ''));
CREATE INDEX payroll_opening_account_bases_year_lookup
  ON public.payroll_opening_account_bases (org_id, tax_year, employee_party_id, filing_account_id);

ALTER TABLE public.payroll_opening_account_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_opening_account_bases FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.payroll_opening_account_bases
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.payroll_opening_account_bases IS
  'Filing-account- and jurisdiction-scoped statutory insurable wage-base carry-ins; the legacy employee-only insurable_ytd cannot be attributed to an EIN or state unemployment account.';
COMMENT ON COLUMN public.payroll_opening_account_bases.program_key IS
  'Country-pack-declared statutory base program key. The row is read only by the declaring pack.';
COMMENT ON COLUMN public.payroll_opening_account_bases.region IS
  'Statutory jurisdiction for a state-scoped filing account; null for a federal account base.';

SELECT public.openbooks_refresh_query_catalog();
