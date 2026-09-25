-- OpenBooks forward migration 0403_payroll_opening_sui_wages.
--
-- SUI-TRANSFER-CREDIT-IMPL: a mid-year adopter's pre-adoption SUI wages had
-- nowhere state-scoped to live. `payroll_opening_balances.insurable_ytd` is
-- the nationwide FUTA number, so the I6-payroll-38 transfer refusal fires on
-- any unscoped opening: state transfer credits (Oregon PUB 217, California
-- CUIC 930.1) cannot be determined from a stateless total. The fix is a
-- per-state SUI carry-in, child of the parent carry-in row exactly like
-- `payroll_opening_balance_components`: one insurable year-to-date per
-- (parent row, US state code). A `sui_<state>` column family on the shared
-- table would bake fifty states into every country's carry-in, so the base
-- lives in this sidecar instead.
--
-- One table:
--
-- (a) New table payroll_opening_sui_wages: one SUI-insurable year-to-date
--     per (opening_balance_id, state). The foreign key to the parent
--     carry-in row (ON DELETE CASCADE) keeps "one carry-in per employee per
--     year" singular: the lock, the fence, the audit trail and the
--     all-zero-is-a-delete rule all keep working through the parent, and a
--     SUI-only carry-in still creates its parent row. Amounts are exact
--     numeric(19,4), NOT NULL, non-negative money; the state is a US postal
--     code the US pack recognises. Entering a state row asserts the transfer
--     determination for those wages (enter only wages the gaining state's
--     rule lets transfer), so the engine prices them instead of refusing.
--
-- Re-runnable: table, constraints, index and policy are IF NOT EXISTS /
-- existence-guarded; replay changes nothing. No backfill: pre-0403 openings
-- carry no per-state split, and the engine keeps refusing unscoped SUI
-- history by name (with the carry-in screen as the remedy) rather than
-- guessing an allocation, so nothing stored needs rewriting.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS public.payroll_opening_sui_wages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  opening_balance_id uuid NOT NULL,
  state text NOT NULL,
  insurable_ytd numeric(19,4) NOT NULL DEFAULT '0',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_opening_sui_wages_parent_state_unique
    UNIQUE (opening_balance_id, state),
  CONSTRAINT payroll_opening_sui_wages_parent_fk
    FOREIGN KEY (opening_balance_id)
    REFERENCES public.payroll_opening_balances (id)
    ON DELETE CASCADE,
  CONSTRAINT payroll_opening_sui_wages_state CHECK (state ~ '^[A-Z]{2}$'),
  CONSTRAINT payroll_opening_sui_wages_nonnegative CHECK (insurable_ytd >= 0)
);
CREATE INDEX IF NOT EXISTS payroll_opening_sui_wages_parent_lookup
  ON public.payroll_opening_sui_wages (org_id, opening_balance_id);

ALTER TABLE ONLY public.payroll_opening_sui_wages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.payroll_opening_sui_wages FORCE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'payroll_opening_sui_wages' AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.payroll_opening_sui_wages
      USING (public.app_bypass_rls_active() OR (org_id::text = current_setting('app.current_org', true)))
      WITH CHECK (public.app_bypass_rls_active() OR (org_id::text = current_setting('app.current_org', true)));
  END IF;
END;
$policy$;

COMMENT ON TABLE public.payroll_opening_sui_wages IS 'Per-state SUI-insurable carry-in for mid-year adopters (0403, SUI-TRANSFER-CREDIT-IMPL): one year-to-date per parent carry-in row and US state code. Child of payroll_opening_balances with cascade; the lock, fence, audit and all-zero-delete rules stay on the parent. A state row asserts the transfer determination for those wages.';
COMMENT ON COLUMN public.payroll_opening_sui_wages.state IS 'US state postal code whose SUI account these pre-adoption wages belong to. Read by the gaining state''s declared transfer rule (engine/src/payroll/us/sui-transfer.ts).';
COMMENT ON COLUMN public.payroll_opening_sui_wages.insurable_ytd IS 'Pre-adoption earnings insurable for SUI in this state. Exact money, never negative; folds into the gaining state''s taxable wage base per its transfer rule together with the committed stubs.';
