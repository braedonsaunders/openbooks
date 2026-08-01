BEGIN;

-- Three independently switchable vertical capabilities:
--   1. vendor-side subcontract commitments and AP progress billing;
--   2. controller-reviewed WIP/prebilling;
--   3. versioned, multi-component subscription lifecycle management.
--
-- Operational records stay in their native subledgers. Bills and invoices still
-- flow through the standard documents/posting kernel, preserving one accounting
-- truth and the existing approval/open-item machinery.

-- ---------------------------------------------------------------------------
-- Subcontracts and AP progress billing
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subcontracts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  number text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  original_commitment numeric(19,4) NOT NULL DEFAULT 0,
  default_retainage_percent numeric(19,4) NOT NULL DEFAULT 10,
  purchase_order_id uuid,
  starts_on date,
  ends_on date,
  payment_hold_reason text,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subcontracts_status_chk CHECK (status IN ('draft','pending_approval','active','substantially_complete','closed','void')),
  CONSTRAINT subcontracts_original_nonnegative CHECK (original_commitment >= 0),
  CONSTRAINT subcontracts_retainage_range CHECK (default_retainage_percent BETWEEN 0 AND 100),
  CONSTRAINT subcontracts_date_window CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT subcontracts_approval_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS subcontracts_org_number ON subcontracts (org_id, number);
CREATE INDEX IF NOT EXISTS subcontracts_project_status ON subcontracts (org_id, project_id, status);
CREATE INDEX IF NOT EXISTS subcontracts_vendor_status ON subcontracts (org_id, vendor_id, status);

CREATE TABLE IF NOT EXISTS subcontract_sov_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subcontract_id uuid NOT NULL,
  item_no text,
  description text NOT NULL,
  scheduled_value numeric(19,4) NOT NULL DEFAULT 0,
  retainage_percent numeric(19,4),
  expense_account_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  change_order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subcontract_sov_value_positive CHECK (scheduled_value > 0),
  CONSTRAINT subcontract_sov_retainage_range CHECK (retainage_percent IS NULL OR retainage_percent BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS subcontract_sov_subcontract ON subcontract_sov_lines (org_id, subcontract_id, sort_order);

CREATE TABLE IF NOT EXISTS subcontract_change_orders (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subcontract_id uuid NOT NULL,
  number text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  amount numeric(19,4) NOT NULL,
  target_sov_line_id uuid,
  approved_on date,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subcontract_changes_status_chk CHECK (status IN ('draft','approved','void')),
  CONSTRAINT subcontract_changes_nonzero CHECK (amount <> 0),
  CONSTRAINT subcontract_changes_approval_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS subcontract_changes_number ON subcontract_change_orders (org_id, subcontract_id, number);
CREATE INDEX IF NOT EXISTS subcontract_changes_subcontract ON subcontract_change_orders (org_id, subcontract_id, status);

CREATE TABLE IF NOT EXISTS vendor_pay_applications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subcontract_id uuid NOT NULL,
  application_number integer NOT NULL,
  period_end date NOT NULL,
  vendor_invoice_number text,
  status text NOT NULL DEFAULT 'draft',
  default_retainage_percent numeric(19,4) NOT NULL DEFAULT 10,
  gross_this_period numeric(19,4) NOT NULL DEFAULT 0,
  retainage_this_period numeric(19,4) NOT NULL DEFAULT 0,
  net_due numeric(19,4) NOT NULL DEFAULT 0,
  vendor_bill_document_id uuid,
  memo text,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT vendor_pay_apps_status_chk CHECK (status IN ('draft','submitted','approved','billed','void')),
  CONSTRAINT vendor_pay_apps_amounts_nonnegative CHECK (gross_this_period >= 0 AND retainage_this_period >= 0 AND net_due >= 0),
  CONSTRAINT vendor_pay_apps_net CHECK (net_due = gross_this_period - retainage_this_period),
  CONSTRAINT vendor_pay_apps_retainage_range CHECK (default_retainage_percent BETWEEN 0 AND 100),
  CONSTRAINT vendor_pay_apps_approval_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_apps_number ON vendor_pay_applications (org_id, subcontract_id, application_number);
CREATE INDEX IF NOT EXISTS vendor_pay_apps_subcontract ON vendor_pay_applications (org_id, subcontract_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_apps_bill ON vendor_pay_applications (org_id, vendor_bill_document_id);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_apps_one_open
  ON vendor_pay_applications (org_id, subcontract_id)
  WHERE status IN ('draft','submitted','approved');

CREATE TABLE IF NOT EXISTS vendor_pay_application_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  pay_application_id uuid NOT NULL,
  sov_line_id uuid NOT NULL,
  previous_earned numeric(19,4) NOT NULL DEFAULT 0,
  previous_materials_stored numeric(19,4) NOT NULL DEFAULT 0,
  work_completed_this_period numeric(19,4) NOT NULL DEFAULT 0,
  materials_stored_current numeric(19,4) NOT NULL DEFAULT 0,
  retainage_percent numeric(19,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT vendor_pay_app_lines_nonnegative CHECK (
    previous_earned >= 0 AND previous_materials_stored >= 0
    AND work_completed_this_period >= 0 AND materials_stored_current >= 0
  ),
  CONSTRAINT vendor_pay_app_lines_retainage_range CHECK (retainage_percent BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_app_lines_app_sov ON vendor_pay_application_lines (pay_application_id, sov_line_id);
CREATE INDEX IF NOT EXISTS vendor_pay_app_lines_app ON vendor_pay_application_lines (org_id, pay_application_id);

CREATE TABLE IF NOT EXISTS vendor_retainage_releases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subcontract_id uuid NOT NULL,
  period_end date NOT NULL,
  amount numeric(19,4) NOT NULL,
  vendor_bill_document_id uuid NOT NULL,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT vendor_retainage_releases_positive CHECK (amount > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_retainage_releases_bill ON vendor_retainage_releases (org_id, vendor_bill_document_id);
CREATE INDEX IF NOT EXISTS vendor_retainage_releases_subcontract ON vendor_retainage_releases (org_id, subcontract_id);

CREATE TABLE IF NOT EXISTS subcontract_payment_controls (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subcontract_id uuid NOT NULL,
  pay_application_id uuid,
  vendor_bill_document_id uuid,
  control_type text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  joint_payee_party_id uuid,
  amount_limit numeric(19,4),
  reason text NOT NULL,
  effective_on date NOT NULL,
  expires_on date,
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subcontract_payment_controls_type_chk CHECK (control_type IN ('joint_check','payment_hold')),
  CONSTRAINT subcontract_payment_controls_status_chk CHECK (status IN ('active','released','void')),
  CONSTRAINT subcontract_payment_controls_limit CHECK (amount_limit IS NULL OR amount_limit > 0),
  CONSTRAINT subcontract_payment_controls_window CHECK (expires_on IS NULL OR expires_on >= effective_on),
  CONSTRAINT subcontract_payment_controls_reason CHECK (length(btrim(reason)) > 0),
  CONSTRAINT subcontract_payment_controls_joint_payee CHECK ((control_type = 'joint_check') = (joint_payee_party_id IS NOT NULL)),
  CONSTRAINT subcontract_payment_controls_release CHECK (
    (status = 'released') = (released_at IS NOT NULL AND released_by IS NOT NULL AND nullif(btrim(release_reason), '') IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS subcontract_payment_controls_active ON subcontract_payment_controls (org_id, subcontract_id, status);
CREATE INDEX IF NOT EXISTS subcontract_payment_controls_bill ON subcontract_payment_controls (org_id, vendor_bill_document_id, status);

-- ---------------------------------------------------------------------------
-- WIP and prebilling
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wip_prebills (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  worksheet_number text NOT NULL,
  period_start date,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  notes text,
  original_bill_amount numeric(19,4) NOT NULL DEFAULT 0,
  proposed_bill_amount numeric(19,4) NOT NULL DEFAULT 0,
  cost_amount numeric(19,4) NOT NULL DEFAULT 0,
  adjustment_amount numeric(19,4) NOT NULL DEFAULT 0,
  billing_request_id uuid,
  invoice_document_id uuid,
  submitted_at timestamptz,
  submitted_by uuid,
  approved_at timestamptz,
  approved_by uuid,
  converted_at timestamptz,
  converted_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT wip_prebills_status_chk CHECK (status IN ('draft','review','approved','converted','void')),
  CONSTRAINT wip_prebills_period_chk CHECK (period_start IS NULL OR period_end >= period_start),
  CONSTRAINT wip_prebills_amounts_chk CHECK (
    original_bill_amount >= 0 AND proposed_bill_amount >= 0 AND cost_amount >= 0
    AND adjustment_amount = proposed_bill_amount - original_bill_amount
  ),
  CONSTRAINT wip_prebills_conversion_chk CHECK (
    (status = 'converted') = (billing_request_id IS NOT NULL AND invoice_document_id IS NOT NULL AND converted_at IS NOT NULL AND converted_by IS NOT NULL)
  ),
  CONSTRAINT wip_prebills_void_chk CHECK (
    status <> 'void' OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND nullif(btrim(void_reason), '') IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebills_org_number ON wip_prebills (org_id, worksheet_number);
CREATE INDEX IF NOT EXISTS wip_prebills_project_status ON wip_prebills (org_id, project_id, status);
CREATE INDEX IF NOT EXISTS wip_prebills_period ON wip_prebills (org_id, period_end);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebills_billing_request ON wip_prebills (org_id, billing_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebills_invoice ON wip_prebills (org_id, invoice_document_id);

CREATE TABLE IF NOT EXISTS wip_prebill_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  prebill_id uuid NOT NULL,
  project_id uuid NOT NULL,
  line_number integer NOT NULL,
  source_type text NOT NULL,
  time_entry_id uuid,
  document_line_id uuid,
  source_document_id uuid,
  source_date date NOT NULL,
  description text,
  quantity numeric(19,4) NOT NULL DEFAULT 1,
  unit text,
  item_id uuid,
  income_account_id uuid,
  tax_code_id uuid,
  employee_party_id uuid,
  time_type_id uuid,
  department_id uuid,
  cost_amount numeric(19,4) NOT NULL DEFAULT 0,
  original_bill_amount numeric(19,4) NOT NULL DEFAULT 0,
  proposed_bill_amount numeric(19,4) NOT NULL DEFAULT 0,
  adjustment_amount numeric(19,4) NOT NULL DEFAULT 0,
  adjustment_reason text,
  adjustment_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  disposition text NOT NULL DEFAULT 'bill',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT wip_prebill_lines_source_type_chk CHECK (source_type IN ('time_entry','document_line')),
  CONSTRAINT wip_prebill_lines_disposition_chk CHECK (disposition IN ('bill','hold')),
  CONSTRAINT wip_prebill_lines_source_shape_chk CHECK (
    (source_type = 'time_entry' AND time_entry_id IS NOT NULL AND document_line_id IS NULL)
    OR (source_type = 'document_line' AND document_line_id IS NOT NULL AND time_entry_id IS NULL)
  ),
  CONSTRAINT wip_prebill_lines_amounts_chk CHECK (
    quantity > 0 AND cost_amount >= 0 AND original_bill_amount >= 0 AND proposed_bill_amount >= 0
    AND adjustment_amount = proposed_bill_amount - original_bill_amount
  ),
  CONSTRAINT wip_prebill_lines_evidence_array_chk CHECK (jsonb_typeof(adjustment_evidence) = 'array'),
  CONSTRAINT wip_prebill_lines_adjustment_support_chk CHECK (
    adjustment_amount = 0
    OR (nullif(btrim(adjustment_reason), '') IS NOT NULL AND jsonb_array_length(adjustment_evidence) > 0)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebill_lines_number ON wip_prebill_lines (org_id, prebill_id, line_number);
CREATE INDEX IF NOT EXISTS wip_prebill_lines_prebill ON wip_prebill_lines (org_id, prebill_id);
CREATE INDEX IF NOT EXISTS wip_prebill_lines_time_source ON wip_prebill_lines (org_id, time_entry_id) WHERE time_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wip_prebill_lines_cost_source ON wip_prebill_lines (org_id, document_line_id) WHERE document_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wip_holds (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  held_at timestamptz NOT NULL DEFAULT now(),
  held_by uuid NOT NULL,
  released_at timestamptz,
  released_by uuid,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT wip_holds_source_type_chk CHECK (source_type IN ('time_entry','document_line')),
  CONSTRAINT wip_holds_reason_chk CHECK (length(btrim(reason)) > 0),
  CONSTRAINT wip_holds_evidence_array_chk CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT wip_holds_release_chk CHECK (
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND nullif(btrim(release_reason), '') IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS wip_holds_active_source ON wip_holds (org_id, source_type, source_id, released_at);
CREATE INDEX IF NOT EXISTS wip_holds_project ON wip_holds (org_id, project_id, released_at);
CREATE UNIQUE INDEX IF NOT EXISTS wip_holds_one_active_source
  ON wip_holds (org_id, source_type, source_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS wip_prebill_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  prebill_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wip_prebill_events_type_chk CHECK (
    event_type IN ('created','line_updated','hold_created','hold_released','submitted','returned','approved','converted','voided')
  )
);
CREATE INDEX IF NOT EXISTS wip_prebill_events_timeline ON wip_prebill_events (org_id, prebill_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Advanced subscription lifecycle
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_plan_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  version_number integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  effective_from date NOT NULL,
  effective_to date,
  name text NOT NULL,
  description text,
  currency_code text,
  interval text NOT NULL,
  interval_count integer NOT NULL DEFAULT 1,
  billing_timing text NOT NULL DEFAULT 'advance',
  change_summary text,
  published_at timestamptz,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_plan_versions_status_chk CHECK (status IN ('draft','published','superseded')),
  CONSTRAINT subscription_plan_versions_interval_chk CHECK (interval IN ('weekly','monthly','quarterly','annually')),
  CONSTRAINT subscription_plan_versions_interval_count_chk CHECK (interval_count > 0),
  CONSTRAINT subscription_plan_versions_timing_chk CHECK (billing_timing IN ('advance','arrears')),
  CONSTRAINT subscription_plan_versions_window_chk CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT subscription_plan_versions_publish_chk CHECK (
    (status = 'draft' AND published_at IS NULL AND published_by IS NULL)
    OR (status IN ('published','superseded') AND published_at IS NOT NULL AND published_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_versions_number ON subscription_plan_versions (org_id, plan_id, version_number);
CREATE INDEX IF NOT EXISTS subscription_plan_versions_effective ON subscription_plan_versions (org_id, plan_id, effective_from, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_versions_published_effective
  ON subscription_plan_versions (org_id, plan_id, effective_from)
  WHERE status IN ('published','superseded');

CREATE TABLE IF NOT EXISTS subscription_plan_version_components (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  version_id uuid NOT NULL,
  component_key text NOT NULL,
  name text NOT NULL,
  description text,
  quantity numeric(19,4) NOT NULL DEFAULT 1,
  unit_price numeric(19,4) NOT NULL DEFAULT 0,
  income_account_id uuid,
  item_id uuid,
  tax_code_id uuid,
  is_optional boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_plan_version_components_key_chk CHECK (length(btrim(component_key)) > 0),
  CONSTRAINT subscription_plan_version_components_amount_chk CHECK (quantity > 0 AND unit_price >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_version_component_key ON subscription_plan_version_components (version_id, component_key);
CREATE INDEX IF NOT EXISTS subscription_plan_version_components_org ON subscription_plan_version_components (org_id, version_id);

CREATE TABLE IF NOT EXISTS subscription_lifecycles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  plan_version_id uuid NOT NULL,
  contract_revision integer NOT NULL DEFAULT 1,
  term_starts_on date NOT NULL,
  term_ends_on date,
  trial_ends_on date,
  billing_timing text NOT NULL DEFAULT 'advance',
  renewal_policy text NOT NULL DEFAULT 'auto',
  renewal_term_months integer,
  renewal_on date,
  coterm_anchor_subscription_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_lifecycles_revision_chk CHECK (contract_revision > 0),
  CONSTRAINT subscription_lifecycles_timing_chk CHECK (billing_timing IN ('advance','arrears')),
  CONSTRAINT subscription_lifecycles_renewal_chk CHECK (renewal_policy IN ('auto','manual','none')),
  CONSTRAINT subscription_lifecycles_term_chk CHECK (term_ends_on IS NULL OR term_ends_on >= term_starts_on),
  CONSTRAINT subscription_lifecycles_trial_chk CHECK (trial_ends_on IS NULL OR trial_ends_on >= term_starts_on),
  CONSTRAINT subscription_lifecycles_renewal_months_chk CHECK (renewal_term_months IS NULL OR renewal_term_months > 0),
  CONSTRAINT subscription_lifecycles_coterm_self_chk CHECK (coterm_anchor_subscription_id IS NULL OR coterm_anchor_subscription_id <> subscription_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_lifecycle_subscription ON subscription_lifecycles (subscription_id);
CREATE INDEX IF NOT EXISTS subscription_lifecycles_renewal ON subscription_lifecycles (org_id, renewal_on, renewal_policy);

CREATE TABLE IF NOT EXISTS subscription_components (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  source_version_component_id uuid,
  component_key text NOT NULL,
  name text NOT NULL,
  description text,
  quantity numeric(19,4) NOT NULL DEFAULT 1,
  unit_price numeric(19,4) NOT NULL DEFAULT 0,
  income_account_id uuid,
  item_id uuid,
  tax_code_id uuid,
  effective_from date NOT NULL,
  effective_to date,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_components_key_chk CHECK (length(btrim(component_key)) > 0),
  CONSTRAINT subscription_components_amount_chk CHECK (quantity > 0 AND unit_price >= 0),
  CONSTRAINT subscription_components_window_chk CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS subscription_components_effective ON subscription_components (org_id, subscription_id, effective_from, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_components_effective_key
  ON subscription_components (org_id, subscription_id, component_key, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_components_one_open
  ON subscription_components (org_id, subscription_id, component_key)
  WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS subscription_amendments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  amendment_number integer NOT NULL,
  amendment_type text NOT NULL,
  effective_on date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  idempotency_key text NOT NULL,
  reason text,
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz,
  applied_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_amendments_number_chk CHECK (amendment_number > 0),
  CONSTRAINT subscription_amendments_type_chk CHECK (
    amendment_type IN ('add_component','remove_component','change_component','change_term','change_timing','renew','coterm')
  ),
  CONSTRAINT subscription_amendments_status_chk CHECK (status IN ('pending','applied','voided')),
  CONSTRAINT subscription_amendments_idempotency_chk CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT subscription_amendments_apply_chk CHECK (
    status <> 'applied' OR (applied_at IS NOT NULL AND applied_by IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_amendment_idempotency ON subscription_amendments (org_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_amendment_number ON subscription_amendments (subscription_id, amendment_number);
CREATE INDEX IF NOT EXISTS subscription_amendments_history ON subscription_amendments (org_id, subscription_id, effective_on);

CREATE TABLE IF NOT EXISTS subscription_period_invoices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  period_starts_on date NOT NULL,
  period_ends_on date NOT NULL,
  contract_revision integer NOT NULL,
  invoice_id uuid NOT NULL,
  billed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT subscription_period_invoices_window_chk CHECK (period_ends_on > period_starts_on),
  CONSTRAINT subscription_period_invoices_revision_chk CHECK (contract_revision > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_period_invoice_once
  ON subscription_period_invoices (subscription_id, period_starts_on, period_ends_on, contract_revision);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_period_invoice_document ON subscription_period_invoices (invoice_id);

-- ---------------------------------------------------------------------------
-- Tenant-scoped referential integrity
-- ---------------------------------------------------------------------------

-- A composite parent key prevents a globally valid id from being paired with
-- the wrong tenant. Existing ids remain the primary keys used by application
-- code; these indexes exist solely for org-scoped foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_unique ON projects (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique ON parties (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique ON documents (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS document_lines_org_id_id_unique ON document_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique ON accounts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS items_org_id_id_unique ON items (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_org_id_id_unique ON tax_codes (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_id_id_unique ON departments (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_org_id_id_unique ON time_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_types_org_id_id_unique ON time_types (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS billing_requests_org_id_id_unique ON billing_requests (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plans_org_id_id_unique ON subscription_plans (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_id_id_unique ON subscriptions (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontracts_org_id_id_unique ON subcontracts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontract_sov_lines_org_id_id_unique ON subcontract_sov_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subcontract_change_orders_org_id_id_unique ON subcontract_change_orders (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_pay_applications_org_id_id_unique ON vendor_pay_applications (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS wip_prebills_org_id_id_unique ON wip_prebills (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_versions_org_id_id_unique ON subscription_plan_versions (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_plan_version_components_org_id_id_unique ON subscription_plan_version_components (org_id, id);

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('subcontracts','subcontracts_project_org_fk','org_id, project_id','projects','org_id, id'),
      ('subcontracts','subcontracts_vendor_org_fk','org_id, vendor_id','parties','org_id, id'),
      ('subcontracts','subcontracts_po_org_fk','org_id, purchase_order_id','documents','org_id, id'),
      ('subcontract_sov_lines','subcontract_sov_parent_org_fk','org_id, subcontract_id','subcontracts','org_id, id'),
      ('subcontract_sov_lines','subcontract_sov_account_org_fk','org_id, expense_account_id','accounts','org_id, id'),
      ('subcontract_sov_lines','subcontract_sov_change_org_fk','org_id, change_order_id','subcontract_change_orders','org_id, id'),
      ('subcontract_change_orders','subcontract_change_parent_org_fk','org_id, subcontract_id','subcontracts','org_id, id'),
      ('subcontract_change_orders','subcontract_change_sov_org_fk','org_id, target_sov_line_id','subcontract_sov_lines','org_id, id'),
      ('vendor_pay_applications','vendor_pay_app_parent_org_fk','org_id, subcontract_id','subcontracts','org_id, id'),
      ('vendor_pay_applications','vendor_pay_app_bill_org_fk','org_id, vendor_bill_document_id','documents','org_id, id'),
      ('vendor_pay_application_lines','vendor_pay_line_app_org_fk','org_id, pay_application_id','vendor_pay_applications','org_id, id'),
      ('vendor_pay_application_lines','vendor_pay_line_sov_org_fk','org_id, sov_line_id','subcontract_sov_lines','org_id, id'),
      ('vendor_retainage_releases','vendor_retainage_parent_org_fk','org_id, subcontract_id','subcontracts','org_id, id'),
      ('vendor_retainage_releases','vendor_retainage_bill_org_fk','org_id, vendor_bill_document_id','documents','org_id, id'),
      ('subcontract_payment_controls','subcontract_control_parent_org_fk','org_id, subcontract_id','subcontracts','org_id, id'),
      ('subcontract_payment_controls','subcontract_control_app_org_fk','org_id, pay_application_id','vendor_pay_applications','org_id, id'),
      ('subcontract_payment_controls','subcontract_control_bill_org_fk','org_id, vendor_bill_document_id','documents','org_id, id'),
      ('subcontract_payment_controls','subcontract_control_payee_org_fk','org_id, joint_payee_party_id','parties','org_id, id'),
      ('wip_prebills','wip_prebill_project_org_fk','org_id, project_id','projects','org_id, id'),
      ('wip_prebills','wip_prebill_request_org_fk','org_id, billing_request_id','billing_requests','org_id, id'),
      ('wip_prebills','wip_prebill_invoice_org_fk','org_id, invoice_document_id','documents','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_parent_org_fk','org_id, prebill_id','wip_prebills','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_project_org_fk','org_id, project_id','projects','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_time_org_fk','org_id, time_entry_id','time_entries','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_cost_org_fk','org_id, document_line_id','document_lines','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_source_doc_org_fk','org_id, source_document_id','documents','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_item_org_fk','org_id, item_id','items','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_income_org_fk','org_id, income_account_id','accounts','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_tax_org_fk','org_id, tax_code_id','tax_codes','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_employee_org_fk','org_id, employee_party_id','parties','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_time_type_org_fk','org_id, time_type_id','time_types','org_id, id'),
      ('wip_prebill_lines','wip_prebill_line_department_org_fk','org_id, department_id','departments','org_id, id'),
      ('wip_holds','wip_hold_project_org_fk','org_id, project_id','projects','org_id, id'),
      ('wip_prebill_events','wip_event_parent_org_fk','org_id, prebill_id','wip_prebills','org_id, id'),
      ('subscription_plan_versions','subscription_version_plan_org_fk','org_id, plan_id','subscription_plans','org_id, id'),
      ('subscription_plan_version_components','subscription_version_component_parent_org_fk','org_id, version_id','subscription_plan_versions','org_id, id'),
      ('subscription_plan_version_components','subscription_version_component_income_org_fk','org_id, income_account_id','accounts','org_id, id'),
      ('subscription_plan_version_components','subscription_version_component_item_org_fk','org_id, item_id','items','org_id, id'),
      ('subscription_plan_version_components','subscription_version_component_tax_org_fk','org_id, tax_code_id','tax_codes','org_id, id'),
      ('subscription_lifecycles','subscription_lifecycle_subscription_org_fk','org_id, subscription_id','subscriptions','org_id, id'),
      ('subscription_lifecycles','subscription_lifecycle_version_org_fk','org_id, plan_version_id','subscription_plan_versions','org_id, id'),
      ('subscription_lifecycles','subscription_lifecycle_anchor_org_fk','org_id, coterm_anchor_subscription_id','subscriptions','org_id, id'),
      ('subscription_components','subscription_component_subscription_org_fk','org_id, subscription_id','subscriptions','org_id, id'),
      ('subscription_components','subscription_component_source_org_fk','org_id, source_version_component_id','subscription_plan_version_components','org_id, id'),
      ('subscription_components','subscription_component_income_org_fk','org_id, income_account_id','accounts','org_id, id'),
      ('subscription_components','subscription_component_item_org_fk','org_id, item_id','items','org_id, id'),
      ('subscription_components','subscription_component_tax_org_fk','org_id, tax_code_id','tax_codes','org_id, id'),
      ('subscription_amendments','subscription_amendment_subscription_org_fk','org_id, subscription_id','subscriptions','org_id, id'),
      ('subscription_period_invoices','subscription_period_subscription_org_fk','org_id, subscription_id','subscriptions','org_id, id'),
      ('subscription_period_invoices','subscription_period_invoice_org_fk','org_id, invoice_id','documents','org_id, id')
    ) AS refs(child_table, constraint_name, child_columns, parent_table, parent_columns)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = fk.constraint_name
         AND conrelid = fk.child_table::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (%s) DEFERRABLE INITIALLY IMMEDIATE',
        fk.child_table, fk.constraint_name, fk.child_columns, fk.parent_table, fk.parent_columns
      );
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Lifecycle and evidence guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION wip_prebill_source_reservation_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  source_key uuid;
BEGIN
  SELECT status INTO parent_status
    FROM wip_prebills
   WHERE org_id = NEW.org_id AND id = NEW.prebill_id;
  IF parent_status NOT IN ('draft','review','approved') THEN
    RETURN NEW;
  END IF;
  source_key := coalesce(NEW.time_entry_id, NEW.document_line_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.org_id::text || ':' || NEW.source_type || ':' || source_key::text, 0
  ));
  IF EXISTS (
    SELECT 1
      FROM wip_prebill_lines line
      JOIN wip_prebills worksheet
        ON worksheet.org_id = line.org_id AND worksheet.id = line.prebill_id
     WHERE line.org_id = NEW.org_id
       AND line.id <> NEW.id
       AND line.source_type = NEW.source_type
       AND coalesce(line.time_entry_id, line.document_line_id) = source_key
       AND worksheet.status IN ('draft','review','approved')
  ) THEN
    RAISE EXCEPTION 'WIP source is already reserved by an active prebill';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS wip_prebill_source_reservation ON wip_prebill_lines;
CREATE TRIGGER wip_prebill_source_reservation
BEFORE INSERT OR UPDATE OF prebill_id, source_type, time_entry_id, document_line_id
ON wip_prebill_lines FOR EACH ROW EXECUTE FUNCTION wip_prebill_source_reservation_guard();

CREATE OR REPLACE FUNCTION wip_prebill_event_append_only_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;

DROP TRIGGER IF EXISTS wip_prebill_event_append_only ON wip_prebill_events;
CREATE TRIGGER wip_prebill_event_append_only
BEFORE UPDATE OR DELETE ON wip_prebill_events
FOR EACH ROW EXECUTE FUNCTION wip_prebill_event_append_only_guard();

CREATE OR REPLACE FUNCTION subscription_plan_version_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF OLD.status IN ('published','superseded') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'published subscription plan versions are immutable';
    END IF;
    IF ROW(OLD.plan_id, OLD.effective_from, OLD.name, OLD.description, OLD.currency_code,
           OLD.interval, OLD.interval_count, OLD.billing_timing, OLD.published_at, OLD.published_by)
       IS DISTINCT FROM
       ROW(NEW.plan_id, NEW.effective_from, NEW.name, NEW.description, NEW.currency_code,
           NEW.interval, NEW.interval_count, NEW.billing_timing, NEW.published_at, NEW.published_by) THEN
      RAISE EXCEPTION 'published subscription plan commercial terms are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS subscription_plan_version_immutable ON subscription_plan_versions;
CREATE TRIGGER subscription_plan_version_immutable
BEFORE UPDATE OR DELETE ON subscription_plan_versions
FOR EACH ROW EXECUTE FUNCTION subscription_plan_version_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_version_component_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_version uuid;
  parent_status text;
BEGIN
  IF current_setting('app.sandbox_wipe', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  parent_version := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  SELECT status INTO parent_status FROM subscription_plan_versions WHERE id = parent_version;
  IF parent_status IN ('published','superseded') THEN
    RAISE EXCEPTION 'components of published subscription plan versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS subscription_version_component_immutable ON subscription_plan_version_components;
CREATE TRIGGER subscription_version_component_immutable
BEFORE INSERT OR UPDATE OR DELETE ON subscription_plan_version_components
FOR EACH ROW EXECUTE FUNCTION subscription_version_component_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_amendment_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF OLD.status = 'applied' THEN
    RAISE EXCEPTION 'applied subscription amendments are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS subscription_amendment_immutable ON subscription_amendments;
CREATE TRIGGER subscription_amendment_immutable
BEFORE UPDATE OR DELETE ON subscription_amendments
FOR EACH ROW EXECUTE FUNCTION subscription_amendment_immutable_guard();

CREATE OR REPLACE FUNCTION subscription_period_invoice_immutable_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.sandbox_wipe', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'subscription period invoice lineage is immutable';
END $$;

DROP TRIGGER IF EXISTS subscription_period_invoice_immutable ON subscription_period_invoices;
CREATE TRIGGER subscription_period_invoice_immutable
BEFORE UPDATE OR DELETE ON subscription_period_invoices
FOR EACH ROW EXECUTE FUNCTION subscription_period_invoice_immutable_guard();

-- ---------------------------------------------------------------------------
-- Standard tenant isolation and reporting-role access
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
  body text := $policy$
    (
      current_setting('app.bypass_rls', true) = 'on'
      OR org_id::text = current_setting('app.current_org', true)
    )
  $policy$;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'subcontracts',
    'subcontract_sov_lines',
    'subcontract_change_orders',
    'vendor_pay_applications',
    'vendor_pay_application_lines',
    'vendor_retainage_releases',
    'subcontract_payment_controls',
    'wip_prebills',
    'wip_prebill_lines',
    'wip_holds',
    'wip_prebill_events',
    'subscription_plan_versions',
    'subscription_plan_version_components',
    'subscription_lifecycles',
    'subscription_components',
    'subscription_amendments',
    'subscription_period_invoices'
  ]
  LOOP
    EXECUTE format('grant select on %I to openbooks_read', tbl);
    EXECUTE format('alter table %I enable row level security', tbl);
    EXECUTE format('alter table %I force row level security', tbl);
    EXECUTE format('drop policy if exists org_isolation on %I', tbl);
    EXECUTE format('create policy org_isolation on %I using (%s) with check (%s)', tbl, body, body);
  END LOOP;
END $$;

COMMIT;
