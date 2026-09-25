-- OpenBooks forward migration 0375_payroll_roe_separation_facts.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE public.payroll_roe_component_classifications (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  block text NOT NULL,
  category_code text,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_roe_component_classifications_component_fkey
    FOREIGN KEY (org_id, pay_component_id)
    REFERENCES public.pay_components(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_roe_component_classifications_window
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_roe_component_classifications_code
    CHECK (
      (block = 'none' AND category_code IS NULL)
      OR (block = '17A' AND category_code IN ('1', '2', '3', '4'))
      OR (block = '17C' AND category_code ~ '^[A-Z][0-9]{2}$')
    ),
  CONSTRAINT payroll_roe_component_classifications_reason
    CHECK (length(btrim(change_reason)) > 0),
  CONSTRAINT payroll_roe_component_classifications_no_overlap
    EXCLUDE USING gist (
      org_id WITH =,
      pay_component_id WITH =,
      daterange(effective_from, effective_to, '[]') WITH &&
    )
);

CREATE INDEX payroll_roe_component_classifications_component_date
  ON public.payroll_roe_component_classifications(org_id, pay_component_id, effective_from);

ALTER TABLE public.payroll_roe_component_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_component_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_roe_component_classifications
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.payroll_roe_separation_events (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL,
  employee_party_id uuid NOT NULL,
  interruption_on date NOT NULL,
  last_insurable_earnings_on date NOT NULL,
  salary_continuance_end_on date,
  status text NOT NULL DEFAULT 'draft',
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_roe_separation_events_employee_fkey
    FOREIGN KEY (org_id, employee_party_id)
    REFERENCES public.parties(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_roe_separation_events_org_id_unique UNIQUE (org_id, id),
  CONSTRAINT payroll_roe_separation_events_status
    CHECK (status IN ('draft', 'confirmed', 'issued', 'cancelled')),
  CONSTRAINT payroll_roe_separation_events_dates
    CHECK (last_insurable_earnings_on <= interruption_on
      AND (salary_continuance_end_on IS NULL
        OR (salary_continuance_end_on >= last_insurable_earnings_on
          AND salary_continuance_end_on <= interruption_on))),
  CONSTRAINT payroll_roe_separation_events_reason
    CHECK (length(btrim(change_reason)) > 0)
);

CREATE UNIQUE INDEX payroll_roe_separation_events_one_open_per_employee
  ON public.payroll_roe_separation_events(org_id, employee_party_id)
  WHERE status IN ('draft', 'confirmed');
CREATE INDEX payroll_roe_separation_events_employee_date
  ON public.payroll_roe_separation_events(org_id, employee_party_id, interruption_on DESC);

ALTER TABLE public.payroll_roe_separation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_separation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_roe_separation_events
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

CREATE TABLE public.payroll_roe_separation_payments (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL,
  separation_event_id uuid NOT NULL,
  pay_component_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  payment_status text NOT NULL,
  expected_payment_on date NOT NULL,
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT payroll_roe_separation_payments_event_fkey
    FOREIGN KEY (org_id, separation_event_id)
    REFERENCES public.payroll_roe_separation_events(org_id, id) ON DELETE CASCADE,
  CONSTRAINT payroll_roe_separation_payments_component_fkey
    FOREIGN KEY (org_id, pay_component_id)
    REFERENCES public.pay_components(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_roe_separation_payments_amount
    CHECK (amount >= 0),
  CONSTRAINT payroll_roe_separation_payments_status
    CHECK (payment_status IN ('paid', 'will_pay')),
  CONSTRAINT payroll_roe_separation_payments_reason
    CHECK (length(btrim(change_reason)) > 0)
);

CREATE INDEX payroll_roe_separation_payments_event
  ON public.payroll_roe_separation_payments(org_id, separation_event_id, expected_payment_on);
ALTER TABLE public.payroll_roe_separation_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_roe_separation_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.payroll_roe_separation_payments
  USING (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true));

COMMENT ON TABLE public.payroll_roe_component_classifications IS
  'Effective-dated employer classifications for Service Canada ROE Block 17A/17C amounts; every earning component is explicitly separated or marked not applicable.';
COMMENT ON TABLE public.payroll_roe_separation_events IS
  'Audited interruption-of-earnings facts used to establish ROE Block 11 and its salary-continuance/paid-leave end.';
COMMENT ON TABLE public.payroll_roe_separation_payments IS
  'Audited separation amounts already paid or declared payable, independent of the pay date of the final committed payroll stub.';
