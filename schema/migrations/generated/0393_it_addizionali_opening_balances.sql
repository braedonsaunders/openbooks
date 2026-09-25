-- OpenBooks forward migration 0393_it_addizionali_opening_balances.
--
-- I6-payroll-50 remainder: the regional/municipal addizionali saldo for year
-- N-1 is withheld in installments during year N, but no adapter channel
-- carries the assessed balances. The December conguaglio stamps the assessed
-- annuals as CONG_ADDREG_ANNUAL / CONG_ADDCOM_ANNUAL stub factors, so a year
-- OpenBooks itself settled resolves its own priors — but a mid-year adopter's
-- prior-provider assessment lives nowhere, and without it the installment
-- computation has no numerator (or, worse, prices zero and silently drops a
-- liability that is always owed).
--
-- This table is that home: one assessed-saldo row per (org, employee, tax
-- year) holding the prior-year assessment the year's installments withhold.
-- Row presence IS the declaration — including an explicit zero for a worker
-- with no prior-year Italian employment — so the engine refuses a missing row
-- by name instead of guessing, and the operator always has a remedy (record
-- the figures in Payroll → Opening balances). Two rows for the same point
-- would make the installment numerator ambiguous, hence the unique index.
--
-- WHY A TABLE AND NOT COLUMNS ON payroll_opening_balances. That table's save
-- deletes all-zero rows ("zero is no carry-in, not a row"), which is correct
-- for year-to-date history but would make an explicit assessed zero
-- unrecordable — the exact remedy the engine refusal names for first-time
-- workers. A dedicated table persists declared zeros beside nonzero history
-- without disturbing the generic layer's invariant.
--
-- WHY NO BACKFILL. Every row this table will ever hold is written by the
-- carry-in save before the first stub that needs it. Existing installs behave
-- exactly as today until an operator records a row; installs whose IT history
-- OpenBooks itself settled resolve through their December factors and need no
-- rows at all. The 0393 preflight lists the employees who will need one.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.it_addizionali_opening_balances (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  tax_year integer NOT NULL,
  regionale_saldo numeric(19, 4) DEFAULT 0 NOT NULL,
  comunale_saldo numeric(19, 4) DEFAULT 0 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT it_addizionali_opening_balances_pkey PRIMARY KEY (id),
  CONSTRAINT it_addizionali_opening_balances_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT it_addizionali_opening_balances_employee_party_id_fkey
    FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT it_addizionali_opening_balances_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT it_addizionali_opening_balances_updated_by_fkey
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT it_addizionali_opening_balances_nonnegative CHECK (
    regionale_saldo >= 0 AND comunale_saldo >= 0
  ),
  CONSTRAINT it_addizionali_opening_balances_org_id_unique UNIQUE (org_id, id)
);

-- One assessed saldo per employee per year. Two rows for the same point would
-- make the installment numerator ambiguous, and an ambiguous annual allowance
-- is wrong money that changes answer between queries.
CREATE UNIQUE INDEX IF NOT EXISTS it_addizionali_opening_balances_employee_year
  ON public.it_addizionali_opening_balances (org_id, employee_party_id, tax_year);

CREATE INDEX IF NOT EXISTS it_addizionali_opening_balances_org_year
  ON public.it_addizionali_opening_balances (org_id, tax_year);

ALTER TABLE public.it_addizionali_opening_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.it_addizionali_opening_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation ON public.it_addizionali_opening_balances;
CREATE POLICY org_isolation ON public.it_addizionali_opening_balances
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

COMMENT ON TABLE public.it_addizionali_opening_balances IS
  'IT addizionali assessed-saldo carry-in (0393, I6-payroll-50): the prior-year regional/municipal assessment per (org, employee, tax year) that the year''s saldo installments withhold. Row presence is the declaration — an explicit zero records a worker with no prior-year Italian employment. Written by the carry-in save under the employee tax-year fence; read with the December settlement factors.';
COMMENT ON COLUMN public.it_addizionali_opening_balances.regionale_saldo IS
  'Prior-year addizionale regionale assessment to withhold in this year''s installments (D.Lgs. 446/1997 art. 50: up to 11 ratei), copied from the prior provider''s final report or the year N-1 CU. Never negative: a negative assessment is a sign-flipped export, not history.';
COMMENT ON COLUMN public.it_addizionali_opening_balances.comunale_saldo IS
  'Prior-year addizionale comunale assessment to withhold in this year''s installments (D.Lgs. 360/1998 art. 1: the saldo rides the March–November ninths), copied from the prior provider''s final report or the year N-1 CU. Never negative: a negative assessment is a sign-flipped export, not history.';

SELECT public.openbooks_refresh_query_catalog();
