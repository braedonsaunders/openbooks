-- Per-component department expense accounts: the same earning, levy or
-- benefit posts to different expense accounts depending on the worker's
-- department (direct-labour departments to cost-of-sales accounts,
-- overhead departments to operating-expense accounts).
--
-- The mapping is one expense account per component and department inside
-- an effective window. Resolution at calculate stamps the line's
-- department mapping first (item-routed lines keep their item account),
-- then the component's default expense account exactly as before; the
-- liability side is unchanged. Because the stamp carries the account,
-- source and evidence on the stub line, the GL preview, the register and
-- the posted journal agree without any posting-rule change.
--
-- One active mapping per component, department and date: the exclusion
-- below refuses overlapping windows, and the setup write path refuses
-- them first with a named remedy. The pay_stub_lines evidence check gains
-- the department source; no money column and no historical stamp moves.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.pay_component_department_expenses (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  department_id uuid NOT NULL,
  expense_account_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT pay_component_department_expenses_pkey PRIMARY KEY (id),
  CONSTRAINT pay_component_department_expenses_component_fkey
    FOREIGN KEY (org_id, pay_component_id)
    REFERENCES public.pay_components (org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT pay_component_department_expenses_department_fkey
    FOREIGN KEY (department_id) REFERENCES public.departments (id)
    ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT pay_component_department_expenses_account_tenant_fkey
    FOREIGN KEY (org_id, expense_account_id) REFERENCES public.accounts (org_id, id)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pay_component_department_expenses_effective_pair
    CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT pay_component_department_expenses_effective_range_exclusion
    EXCLUDE USING gist (
      org_id WITH =,
      pay_component_id WITH =,
      department_id WITH =,
      (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
    ) WHERE (is_active)
);

CREATE INDEX pay_component_department_expenses_component
  ON public.pay_component_department_expenses (org_id, pay_component_id);
CREATE INDEX pay_component_department_expenses_lookup
  ON public.pay_component_department_expenses (org_id, pay_component_id, department_id)
  WHERE is_active;

ALTER TABLE ONLY public.pay_component_department_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.pay_component_department_expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pay_component_department_expenses
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.pay_component_department_expenses IS
  'Per-component department override of the payroll expense (debit) account: one active expense account per component, department and date. Resolution at calculate prefers the line''s department mapping over the component default; the liability side is unchanged.';
COMMENT ON CONSTRAINT pay_component_department_expenses_effective_range_exclusion
  ON public.pay_component_department_expenses IS
  'openbooks:pay_component_department_expense_range_exclusion:v1 - one active window per organization, component and department; inclusive date windows may not overlap and a null end is open-ended';

-- The stub-line evidence check gains the department source. Every stamped
-- row still names the rung that answered and carries evidence explaining
-- it; unstamped history ('unknown') resolves live as before.
ALTER TABLE ONLY public.pay_stub_lines DROP CONSTRAINT pay_stub_lines_expense_account_evidence;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_expense_account_evidence CHECK (
  (expense_account_source = 'unknown' AND expense_account_id IS NULL AND expense_account_evidence IS NULL) OR
  (expense_account_source IN ('item', 'component', 'department', 'org_default') AND expense_account_id IS NOT NULL
    AND expense_account_evidence IS NOT NULL AND jsonb_typeof(expense_account_evidence) = 'object')
);
COMMENT ON COLUMN public.pay_stub_lines.expense_account_source IS
  'item = the line''s item declared an account; department = the component''s department mapping for the line''s department answered; component = fell through to the pay component''s expense account; org_default = fell through to the org wage/burden default; unknown = unstamped history resolving live as before.';

SELECT public.openbooks_refresh_query_catalog();
