-- Bank-funded entitlement settlements debit or credit the plan's liability.
--
-- A payout drawn from an accrued bank was already expensed when it accrued,
-- so the stub line settling it is stamped with the entitlement plan's
-- liability account instead of an expense account; a deposit into a
-- liability-carrying bank credits the same account. The stub-line evidence
-- check gains the entitlement_plan source. Every stamped row still names the
-- rung that answered and carries evidence explaining it.
-- Backfill: none. Existing stamps are immutable and keep their source.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE ONLY public.pay_stub_lines DROP CONSTRAINT pay_stub_lines_expense_account_evidence;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_expense_account_evidence CHECK (
  (expense_account_source = 'unknown' AND expense_account_id IS NULL AND expense_account_evidence IS NULL) OR
  (expense_account_source IN ('item', 'component', 'department', 'org_default', 'entitlement_plan')
    AND expense_account_id IS NOT NULL
    AND expense_account_evidence IS NOT NULL AND jsonb_typeof(expense_account_evidence) = 'object')
);
COMMENT ON COLUMN public.pay_stub_lines.expense_account_source IS
  'item = the line''s item declared an account; department = the component''s department mapping for the line''s department answered; component = fell through to the pay component''s expense account; org_default = fell through to the org wage/burden default; entitlement_plan = the line settles an entitlement bank and posts to the plan''s liability account; unknown = unstamped history resolving live as before.';

SELECT public.openbooks_refresh_query_catalog();
