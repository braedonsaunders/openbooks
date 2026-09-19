-- OpenBooks forward migration 0180_pay_stub_line_expense_account.
--
-- Per-line payroll expense-account routing: the SAME employee in the SAME pay
-- period can have hours on one service item costed to one account and hours on
-- another item costed to a different one (e.g. production work capitalised to
-- work-in-process while administrative work lands in an expense account).
--
-- THE AXIS IS THE ITEM, NEVER BILLABILITY. Billable is a billing decision,
-- not a cost-nature decision: the same hour of trade labor is direct labour
-- whether or not it is ultimately billed. Routing on the flag would move COGS
-- when someone toggles a checkbox, and a flag flipped after posting would
-- leave the journal disagreeing with the flag. So the mapping is ONE optional
-- account per item (items.payroll_expense_account_id, below): an item with an
-- account declares where hours worked on it are costed; null means the item
-- has no opinion and resolution falls through to the pay component, then the
-- org wage/burden default — silently, never as a refusal.
--
-- items.expense_account_id is DELIBERATELY NOT reused: it means "what this
-- costs when you BUY it", a different fact from "where worked hours land".
--
-- KNOWN LIMITATION (recorded, not solved): accounts.subsidiary_id exists, so
-- accounts can be subsidiary-scoped and a multi-subsidiary tenant may keep a
-- chart per entity — a single item pointing at a single account is
-- theoretically wrong for such a group. The item's four pre-existing account
-- columns (expense, income, deferred, cost recovery) already carry exactly
-- this limitation; solving it only for payroll would make the model
-- inconsistent, and solving it generally is a larger piece of work. So the
-- new column follows the established pattern: one account per item.
--
-- The stamp columns MIRROR migration 0094's liability pattern on this same
-- table (liability_account_id / _source / _evidence), including its guards:
-- the account is stamped at calculate, re-stamped on every recalculation
-- (recalculate deletes and reinserts stub rows, so the BEFORE UPDATE guard
-- below never fires on a draft), and immutable once the run is committed.
-- Nothing here touches payroll MONEY: amount, hours and rate are unchanged,
-- and legacy rows keep source 'unknown' with null account/evidence and
-- resolve through the exact fallback chain they always have (component, then
-- org default), so no historical figure moves. There is deliberately NO
-- 0094-style backfill: today's live resolution IS component-then-default, so
-- backfilling it would only relabel history without changing a single figure.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The item-side mapping: where hours worked on this item are costed.
ALTER TABLE public.items ADD COLUMN payroll_expense_account_id uuid;
ALTER TABLE public.items ADD CONSTRAINT items_payroll_expense_account_tenant_fkey
  FOREIGN KEY (org_id, payroll_expense_account_id) REFERENCES public.accounts(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX items_payroll_expense_account ON public.items(org_id, payroll_expense_account_id);

-- The line-side stamp, carried and frozen exactly like the liability stamp.
ALTER TABLE public.pay_stub_lines ADD COLUMN item_id uuid;
ALTER TABLE public.pay_stub_lines ADD COLUMN expense_account_id uuid;
ALTER TABLE public.pay_stub_lines ADD COLUMN expense_account_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.pay_stub_lines ADD COLUMN expense_account_evidence jsonb;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_expense_account_tenant_fkey
  FOREIGN KEY (org_id, expense_account_id) REFERENCES public.accounts(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
-- 'unknown' rows are unstamped history and resolve live (component, then org
-- default), exactly as before. Every stamped row names the rung that answered
-- (item > component > org_default) and carries evidence explaining it, so a
-- historical line can never masquerade as a new commit and no money column is
-- part of this constraint.
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_expense_account_evidence CHECK (
  (expense_account_source = 'unknown' AND expense_account_id IS NULL AND expense_account_evidence IS NULL) OR
  (expense_account_source IN ('item', 'component', 'org_default') AND expense_account_id IS NOT NULL
    AND expense_account_evidence IS NOT NULL AND jsonb_typeof(expense_account_evidence) = 'object')
);
CREATE INDEX pay_stub_lines_expense_account ON public.pay_stub_lines(org_id, expense_account_id);
CREATE INDEX pay_stub_lines_item ON public.pay_stub_lines(org_id, item_id);

CREATE OR REPLACE FUNCTION public.pay_stub_line_expense_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.expense_account_source <> 'unknown'
     AND ROW(NEW.expense_account_id, NEW.expense_account_source)
         IS DISTINCT FROM ROW(OLD.expense_account_id, OLD.expense_account_source) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_line_expense_immutable',
      MESSAGE = 'The expense account a committed payroll line was costed to is immutable.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_line_expense_guard BEFORE UPDATE ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_expense_guard();
COMMENT ON COLUMN public.items.payroll_expense_account_id IS
  'Where hours worked on this item are costed at payroll calculate time. Null = the item has no opinion; resolution falls through to the pay component, then the org wage/burden default. Distinct from expense_account_id (buy cost), and single-account-per-item like the item''s other account columns (see migration 0180).';
COMMENT ON COLUMN public.pay_stub_lines.item_id IS
  'Service item the hours on this line were worked on, carried from the time entry like project_id/time_type_id. Null for lines with no operational item (salary, bonus, per diem).';
COMMENT ON COLUMN public.pay_stub_lines.expense_account_id IS
  'Expense account this earning line was costed to at calculate. Posting debits this account, never the component''s or item''s current setup.';
COMMENT ON COLUMN public.pay_stub_lines.expense_account_source IS
  'item = the line''s item declared an account; component = fell through to the pay component''s expense account; org_default = fell through to the org wage/burden default; unknown = unstamped history resolving live as before.';
