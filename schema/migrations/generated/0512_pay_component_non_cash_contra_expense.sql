-- OpenBooks forward migration 0512_pay_component_non_cash_contra_expense.
-- A non-cash earning may also credit a contra-expense account: a taxable
-- benefit whose cost the employer already expensed elsewhere (personal use
-- of a company vehicle) is recorded by debiting the benefit expense and
-- crediting a contra account, so the payroll entry nets to nothing. The
-- contra account must differ from the component's expense account. The
-- function is redefined with its full body; only the offset rule changes.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.pay_component_non_cash_account_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE offset_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.payment_kind IS DISTINCT FROM OLD.payment_kind AND EXISTS (
    SELECT 1 FROM public.hrm_benefit_programs p WHERE p.org_id = OLD.org_id AND p.pay_component_id = OLD.id
      AND (p.status = 'active' OR EXISTS (
        SELECT 1 FROM public.hrm_benefit_awards a WHERE a.org_id = p.org_id AND a.program_id = p.id
          AND a.status IN ('approved', 'queued', 'delivered')
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An active benefit program or approved benefit obligation uses this cash representation; preserve its component and create a new program and component for a different delivery policy.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.payment_kind IS DISTINCT FROM OLD.payment_kind AND EXISTS (
    SELECT 1 FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id = l.org_id AND s.id = l.stub_id
    JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    WHERE l.org_id = OLD.org_id AND l.component_id = OLD.id AND r.run_status IN ('committed', 'voided')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pay component cash representation is fixed after committed payroll; preserve this component and create a new component for future earnings.';
  END IF;
  IF NEW.payment_kind = 'non_cash' THEN
    SELECT a.type INTO offset_type FROM public.accounts a
     WHERE a.org_id = NEW.org_id AND a.id = NEW.non_cash_account_id AND a.is_active AND NOT a.is_summary;
    IF offset_type IS NULL OR offset_type NOT IN (
      'asset_current_other', 'asset_other', 'liability_current_other', 'liability_long_term',
      'cogs', 'expense', 'expense_other'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A non-cash earning requires an active posting prepaid asset, provider clearing liability, or contra-expense account as its offset.';
    END IF;
    IF offset_type IN ('cogs', 'expense', 'expense_other') AND NEW.non_cash_account_id = NEW.expense_account_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A contra-expense offset must be a different account from the earning''s expense account; posting both sides to one account records nothing.';
    END IF;
  END IF;
  RETURN NEW;
END
$func$;
