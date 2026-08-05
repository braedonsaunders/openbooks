-- 0127_payroll.sql — Payroll module core tables (feature `payroll`).
-- Wages stay in labor_cost_rates (one-table doctrine); statutory amounts come
-- from the versioned T4127 engine; a pay run is documents kind 'pay_run'.

CREATE TABLE public.pay_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    frequency text NOT NULL,
    periods_per_year integer NOT NULL,
    anchor_period_end date NOT NULL,
    pay_date_offset_days integer DEFAULT 0 NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_schedules_pkey PRIMARY KEY (id),
    CONSTRAINT pay_schedules_frequency CHECK (frequency IN ('weekly','biweekly','semi_monthly','monthly')),
    CONSTRAINT pay_schedules_periods CHECK (periods_per_year IN (12, 24, 26, 27, 52, 53)),
    CONSTRAINT pay_schedules_offset CHECK (pay_date_offset_days >= 0 AND pay_date_offset_days <= 31)
);
CREATE UNIQUE INDEX pay_schedules_org_name ON public.pay_schedules (org_id, name);

CREATE TABLE public.pay_components (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    system_key text,
    basis text DEFAULT 'fixed_amount' NOT NULL,
    value numeric(19,4),
    taxable boolean DEFAULT true NOT NULL,
    pensionable boolean DEFAULT true NOT NULL,
    insurable boolean DEFAULT true NOT NULL,
    vacationable boolean DEFAULT true NOT NULL,
    non_periodic boolean DEFAULT false NOT NULL,
    tax_treatment text DEFAULT 'none' NOT NULL,
    expense_account_id uuid,
    liability_account_id uuid,
    remittance_party_id uuid,
    sequence integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_components_pkey PRIMARY KEY (id),
    CONSTRAINT pay_components_kind CHECK (kind IN ('earning','deduction','employer_contribution')),
    CONSTRAINT pay_components_system_key CHECK (system_key IS NULL OR system_key IN
      ('base_pay','overtime','bonus','vacation_accrual','vacation_payout','cpp','cpp2','ei','qpip','income_tax')),
    CONSTRAINT pay_components_basis CHECK (basis IN ('fixed_amount','per_hour','percent_of_gross')),
    CONSTRAINT pay_components_tax_treatment CHECK (tax_treatment IN ('none','pension_f','union_dues','alimony'))
);
CREATE UNIQUE INDEX pay_components_org_code ON public.pay_components (org_id, code);
CREATE UNIQUE INDEX pay_components_org_system ON public.pay_components (org_id, system_key, kind);
CREATE INDEX pay_components_org_kind ON public.pay_components (org_id, kind);

CREATE TABLE public.employee_payroll_profiles (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    pay_schedule_id uuid NOT NULL,
    province text NOT NULL,
    pay_basis text DEFAULT 'hourly' NOT NULL,
    federal_claim_code integer,
    federal_claim_amount numeric(19,4),
    provincial_claim_code integer,
    provincial_claim_amount numeric(19,4),
    additional_tax_per_period numeric(19,4),
    prescribed_zone_deduction numeric(19,4),
    authorized_annual_deductions numeric(19,4),
    authorized_federal_credits numeric(19,4),
    authorized_provincial_credits numeric(19,4),
    cpp_exempt boolean DEFAULT false NOT NULL,
    ei_exempt boolean DEFAULT false NOT NULL,
    tax_exempt boolean DEFAULT false NOT NULL,
    vacation_percent numeric(7,4),
    vacation_method text DEFAULT 'accrue' NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT employee_payroll_profiles_pkey PRIMARY KEY (id),
    CONSTRAINT employee_payroll_profiles_pay_basis CHECK (pay_basis IN ('hourly','salary')),
    CONSTRAINT employee_payroll_profiles_vacation_method CHECK (vacation_method IN ('accrue','pay_each_period')),
    CONSTRAINT employee_payroll_profiles_fed_code CHECK (federal_claim_code IS NULL OR (federal_claim_code >= 0 AND federal_claim_code <= 10)),
    CONSTRAINT employee_payroll_profiles_prov_code CHECK (provincial_claim_code IS NULL OR (provincial_claim_code >= 0 AND provincial_claim_code <= 10)),
    CONSTRAINT employee_payroll_profiles_vacation CHECK (vacation_percent IS NULL OR vacation_percent >= 0)
);
CREATE UNIQUE INDEX employee_payroll_profiles_employee ON public.employee_payroll_profiles (org_id, employee_party_id);
CREATE INDEX employee_payroll_profiles_schedule ON public.employee_payroll_profiles (org_id, pay_schedule_id);

CREATE TABLE public.employee_pay_components (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    component_id uuid NOT NULL,
    value numeric(19,4),
    effective_from date NOT NULL,
    effective_to date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT employee_pay_components_pkey PRIMARY KEY (id),
    CONSTRAINT employee_pay_components_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX employee_pay_components_employee ON public.employee_pay_components (org_id, employee_party_id, effective_from);

CREATE TABLE public.pay_runs (
    document_id uuid NOT NULL,
    org_id uuid NOT NULL,
    pay_schedule_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    pay_date date NOT NULL,
    tax_year integer NOT NULL,
    run_status text DEFAULT 'draft' NOT NULL,
    gross_total numeric(19,4) DEFAULT 0 NOT NULL,
    net_total numeric(19,4) DEFAULT 0 NOT NULL,
    employer_cost_total numeric(19,4) DEFAULT 0 NOT NULL,
    employee_count integer DEFAULT 0 NOT NULL,
    calculated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_runs_pkey PRIMARY KEY (document_id),
    CONSTRAINT pay_runs_run_status CHECK (run_status IN ('draft','calculated','committed')),
    CONSTRAINT pay_runs_period_order CHECK (period_end >= period_start),
    CONSTRAINT pay_runs_pay_date CHECK (pay_date >= period_end)
);
CREATE INDEX pay_runs_org_period ON public.pay_runs (org_id, period_start, period_end);
CREATE UNIQUE INDEX pay_runs_schedule_period ON public.pay_runs (org_id, pay_schedule_id, period_end);

CREATE TABLE public.pay_stubs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    pay_run_document_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    province text NOT NULL,
    periods_per_year integer NOT NULL,
    pay_date date NOT NULL,
    tax_year integer NOT NULL,
    federal_claim numeric(19,4) DEFAULT 0 NOT NULL,
    provincial_claim numeric(19,4) DEFAULT 0 NOT NULL,
    currency_code text NOT NULL,
    gross numeric(19,4) DEFAULT 0 NOT NULL,
    pensionable_earnings numeric(19,4) DEFAULT 0 NOT NULL,
    insurable_earnings numeric(19,4) DEFAULT 0 NOT NULL,
    net_pay numeric(19,4) DEFAULT 0 NOT NULL,
    employer_cost numeric(19,4) DEFAULT 0 NOT NULL,
    vacation_accrued numeric(19,4) DEFAULT 0 NOT NULL,
    factors jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_stubs_pkey PRIMARY KEY (id),
    CONSTRAINT pay_stubs_net_nonnegative CHECK (net_pay >= 0)
);
CREATE UNIQUE INDEX pay_stubs_run_employee ON public.pay_stubs (pay_run_document_id, employee_party_id);
CREATE INDEX pay_stubs_employee_year ON public.pay_stubs (org_id, employee_party_id, tax_year, pay_date);

CREATE TABLE public.pay_stub_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    stub_id uuid NOT NULL,
    component_id uuid,
    kind text NOT NULL,
    description text NOT NULL,
    hours numeric(12,2),
    rate numeric(19,4),
    amount numeric(19,4) NOT NULL,
    project_id uuid,
    department_id uuid,
    time_type_id uuid,
    sequence integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT pay_stub_lines_pkey PRIMARY KEY (id),
    CONSTRAINT pay_stub_lines_kind CHECK (kind IN ('earning','deduction','employer_contribution'))
);
CREATE INDEX pay_stub_lines_stub ON public.pay_stub_lines (stub_id, sequence);
CREATE INDEX pay_stub_lines_project ON public.pay_stub_lines (org_id, project_id);

CREATE TABLE public.payroll_opening_balances (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    employee_party_id uuid NOT NULL,
    tax_year integer NOT NULL,
    pensionable_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    insurable_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    cpp_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    cpp2_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    ei_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    qpip_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    taxable_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    tax_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    non_periodic_ytd numeric(19,4) DEFAULT 0 NOT NULL,
    vacation_balance numeric(19,4) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT payroll_opening_balances_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX payroll_opening_balances_employee_year ON public.payroll_opening_balances (org_id, employee_party_id, tax_year);

-- Foreign keys (DEFERRABLE, per environments.sql doctrine) -------------------

ALTER TABLE public.pay_schedules
    ADD CONSTRAINT pay_schedules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_schedules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.pay_components
    ADD CONSTRAINT pay_components_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_components_expense_account_id_fkey FOREIGN KEY (expense_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_components_liability_account_id_fkey FOREIGN KEY (liability_account_id) REFERENCES public.accounts(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_components_remittance_party_id_fkey FOREIGN KEY (remittance_party_id) REFERENCES public.parties(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_components_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_components_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.employee_payroll_profiles
    ADD CONSTRAINT employee_payroll_profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT employee_payroll_profiles_employee_party_id_fkey FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT employee_payroll_profiles_pay_schedule_id_fkey FOREIGN KEY (pay_schedule_id) REFERENCES public.pay_schedules(id) DEFERRABLE,
    ADD CONSTRAINT employee_payroll_profiles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT employee_payroll_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.employee_pay_components
    ADD CONSTRAINT employee_pay_components_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT employee_pay_components_employee_party_id_fkey FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT employee_pay_components_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.pay_components(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT employee_pay_components_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT employee_pay_components_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.pay_runs
    ADD CONSTRAINT pay_runs_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_runs_pay_schedule_id_fkey FOREIGN KEY (pay_schedule_id) REFERENCES public.pay_schedules(id) DEFERRABLE,
    ADD CONSTRAINT pay_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_runs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.pay_stubs
    ADD CONSTRAINT pay_stubs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_stubs_pay_run_document_id_fkey FOREIGN KEY (pay_run_document_id) REFERENCES public.pay_runs(document_id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_stubs_employee_party_id_fkey FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_stubs_currency_code_fkey FOREIGN KEY (currency_code) REFERENCES public.currencies(code) DEFERRABLE,
    ADD CONSTRAINT pay_stubs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stubs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.pay_stub_lines
    ADD CONSTRAINT pay_stub_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_stub_id_fkey FOREIGN KEY (stub_id) REFERENCES public.pay_stubs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_component_id_fkey FOREIGN KEY (component_id) REFERENCES public.pay_components(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_time_type_id_fkey FOREIGN KEY (time_type_id) REFERENCES public.time_types(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT pay_stub_lines_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

ALTER TABLE public.payroll_opening_balances
    ADD CONSTRAINT payroll_opening_balances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT payroll_opening_balances_employee_party_id_fkey FOREIGN KEY (employee_party_id) REFERENCES public.parties(id) ON DELETE CASCADE DEFERRABLE,
    ADD CONSTRAINT payroll_opening_balances_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
    ADD CONSTRAINT payroll_opening_balances_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE;

-- SQL workbench views (security barrier + read grant, per house rule) --------

CREATE VIEW openbooks_query.pay_schedules WITH (security_barrier='true') AS
  SELECT * FROM public.pay_schedules;
GRANT SELECT ON TABLE openbooks_query.pay_schedules TO openbooks_read;

CREATE VIEW openbooks_query.pay_components WITH (security_barrier='true') AS
  SELECT * FROM public.pay_components;
GRANT SELECT ON TABLE openbooks_query.pay_components TO openbooks_read;

CREATE VIEW openbooks_query.employee_payroll_profiles WITH (security_barrier='true') AS
  SELECT * FROM public.employee_payroll_profiles;
GRANT SELECT ON TABLE openbooks_query.employee_payroll_profiles TO openbooks_read;

CREATE VIEW openbooks_query.employee_pay_components WITH (security_barrier='true') AS
  SELECT * FROM public.employee_pay_components;
GRANT SELECT ON TABLE openbooks_query.employee_pay_components TO openbooks_read;

CREATE VIEW openbooks_query.pay_runs WITH (security_barrier='true') AS
  SELECT * FROM public.pay_runs;
GRANT SELECT ON TABLE openbooks_query.pay_runs TO openbooks_read;

CREATE VIEW openbooks_query.pay_stubs WITH (security_barrier='true') AS
  SELECT * FROM public.pay_stubs;
GRANT SELECT ON TABLE openbooks_query.pay_stubs TO openbooks_read;

CREATE VIEW openbooks_query.pay_stub_lines WITH (security_barrier='true') AS
  SELECT * FROM public.pay_stub_lines;
GRANT SELECT ON TABLE openbooks_query.pay_stub_lines TO openbooks_read;

CREATE VIEW openbooks_query.payroll_opening_balances WITH (security_barrier='true') AS
  SELECT * FROM public.payroll_opening_balances;
GRANT SELECT ON TABLE openbooks_query.payroll_opening_balances TO openbooks_read;
