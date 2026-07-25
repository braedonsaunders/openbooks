-- Localization packs (tax rate providers + locale meta), subscription lifecycle,
-- PSP settlements, transfer orders, multi-target landed cost, lot weights.

CREATE TABLE IF NOT EXISTS tax_rate_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  display_name text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets text,
  prefer_provider boolean NOT NULL DEFAULT true,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT tax_rate_provider_configs_provider_chk CHECK (provider IN ('avalara', 'taxjar', 'custom_http', 'manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_rate_provider_configs_org ON tax_rate_provider_configs (org_id);

CREATE TABLE IF NOT EXISTS tax_rate_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider_config_id uuid NOT NULL,
  provider text NOT NULL,
  quoted_on date NOT NULL,
  currency text,
  ship_from jsonb NOT NULL DEFAULT '{}'::jsonb,
  ship_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  taxable_amount numeric(19,4) NOT NULL,
  tax_amount numeric(19,4) NOT NULL,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_ref text,
  document_line_id uuid,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS tax_rate_quotes_org_date ON tax_rate_quotes (org_id, quoted_on);
CREATE INDEX IF NOT EXISTS tax_rate_quotes_line ON tax_rate_quotes (document_line_id);

CREATE TABLE IF NOT EXISTS tax_locale_pack_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  pack_code text NOT NULL,
  country text NOT NULL,
  filing_channel text,
  digital_submission_ready boolean NOT NULL DEFAULT false,
  rate_bands jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_locale_pack_meta_org_pack ON tax_locale_pack_meta (org_id, pack_code);

-- Subscription lifecycle extensions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS paused_on date;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS resume_on date;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS prorate_tax boolean NOT NULL DEFAULT true;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS dunning_state text NOT NULL DEFAULT 'current';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS dunning_stage_id uuid;

DO $$ BEGIN
  ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Expand status check if present as a table check from drizzle (best-effort)
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
-- no-op when drizzle used text enum without CHECK

CREATE TABLE IF NOT EXISTS subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  kind text NOT NULL,
  occurred_on date NOT NULL,
  payload text,
  invoice_id uuid,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS subscription_events_sub ON subscription_events (subscription_id, created_at);

-- Link invoices to subscriptions for dunning state machine
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subscription_id uuid;
CREATE INDEX IF NOT EXISTS documents_subscription ON documents (subscription_id) WHERE subscription_id IS NOT NULL;

-- PSP settlements
CREATE TABLE IF NOT EXISTS psp_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  display_name text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT false,
  default_bank_account_id uuid,
  default_fee_account_id uuid,
  default_dispute_account_id uuid,
  default_fx_account_id uuid,
  default_clearing_account_id uuid,
  secrets text,
  last_import_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT psp_provider_configs_provider_chk CHECK (provider IN ('stripe', 'recurly', 'chargebee'))
);
CREATE UNIQUE INDEX IF NOT EXISTS psp_provider_configs_org_provider ON psp_provider_configs (org_id, provider);

CREATE TABLE IF NOT EXISTS psp_settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  provider text NOT NULL,
  external_ref text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  currency text NOT NULL,
  gross_amount numeric(19,4) NOT NULL DEFAULT 0,
  fee_amount numeric(19,4) NOT NULL DEFAULT 0,
  refund_amount numeric(19,4) NOT NULL DEFAULT 0,
  dispute_amount numeric(19,4) NOT NULL DEFAULT 0,
  net_amount numeric(19,4) NOT NULL DEFAULT 0,
  fx_amount numeric(19,4) NOT NULL DEFAULT 0,
  settlement_date date NOT NULL,
  bank_account_id uuid,
  fee_account_id uuid,
  dispute_account_id uuid,
  fx_account_id uuid,
  clearing_account_id uuid,
  subsidiary_id uuid,
  journal_entry_id uuid,
  source_payload jsonb,
  line_count integer NOT NULL DEFAULT 0,
  posted_at timestamptz,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT psp_settlement_batches_status_chk CHECK (status IN ('draft', 'posted', 'void')),
  CONSTRAINT psp_settlement_batches_provider_chk CHECK (provider IN ('stripe', 'recurly', 'chargebee'))
);
CREATE UNIQUE INDEX IF NOT EXISTS psp_settlement_batches_org_ext ON psp_settlement_batches (org_id, provider, external_ref);
CREATE INDEX IF NOT EXISTS psp_settlement_batches_org_date ON psp_settlement_batches (org_id, settlement_date);

CREATE TABLE IF NOT EXISTS psp_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  line_number integer NOT NULL,
  kind text NOT NULL,
  external_ref text,
  description text,
  amount numeric(19,4) NOT NULL,
  currency text,
  party_id uuid,
  document_id uuid,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT psp_settlement_lines_kind_chk CHECK (kind IN (
    'charge', 'refund', 'fee', 'dispute', 'dispute_reversal', 'fx_adjustment', 'transfer', 'other'
  ))
);
CREATE INDEX IF NOT EXISTS psp_settlement_lines_batch ON psp_settlement_lines (batch_id);
CREATE INDEX IF NOT EXISTS psp_settlement_lines_doc ON psp_settlement_lines (document_id);

-- Transfer orders + landed cost vouchers
CREATE TABLE IF NOT EXISTS transfer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  document_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  from_stock_location_id uuid NOT NULL,
  to_stock_location_id uuid NOT NULL,
  transit_stock_location_id uuid,
  in_transit_account_id uuid,
  subsidiary_id uuid NOT NULL,
  ordered_on date NOT NULL,
  shipped_on date,
  received_on date,
  ship_journal_entry_id uuid,
  receive_journal_entry_id uuid,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT transfer_orders_status_chk CHECK (status IN ('draft', 'in_transit', 'received', 'cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS transfer_orders_org_number ON transfer_orders (org_id, document_number);
CREATE INDEX IF NOT EXISTS transfer_orders_org_status ON transfer_orders (org_id, status);

CREATE TABLE IF NOT EXISTS transfer_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  transfer_order_id uuid NOT NULL,
  line_number integer NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(19,4) NOT NULL,
  quantity_shipped numeric(19,4) NOT NULL DEFAULT 0,
  quantity_received numeric(19,4) NOT NULL DEFAULT 0,
  lot_id uuid,
  serial_id uuid,
  unit_cost numeric(19,4),
  ship_movement_id uuid,
  receive_movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS transfer_order_lines_order ON transfer_order_lines (transfer_order_id);

CREATE TABLE IF NOT EXISTS cost_layer_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  cost_layer_id uuid NOT NULL,
  weight numeric(19,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_layer_weights_layer_uid ON cost_layer_weights (cost_layer_id);
CREATE INDEX IF NOT EXISTS cost_layer_weights_layer ON cost_layer_weights (cost_layer_id);

CREATE TABLE IF NOT EXISTS landed_cost_vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  document_number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  amount numeric(19,4) NOT NULL,
  basis text NOT NULL DEFAULT 'value',
  freight_account_id uuid NOT NULL,
  source_document_line_id uuid,
  subsidiary_id uuid NOT NULL,
  voucher_date date NOT NULL,
  journal_entry_id uuid,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT landed_cost_vouchers_status_chk CHECK (status IN ('draft', 'posted', 'void')),
  CONSTRAINT landed_cost_vouchers_basis_chk CHECK (basis IN ('value', 'quantity', 'weight', 'manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS landed_cost_vouchers_org_number ON landed_cost_vouchers (org_id, document_number);

CREATE TABLE IF NOT EXISTS landed_cost_voucher_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  item_id uuid NOT NULL,
  stock_location_id uuid NOT NULL,
  manual_amount numeric(19,4),
  allocated_amount numeric(19,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS landed_cost_voucher_targets_voucher ON landed_cost_voucher_targets (voucher_id);

-- ---------------------------------------------------------------------------
-- Tenant isolation + read role (standard pattern, matches 0041 et al.)
-- ---------------------------------------------------------------------------

do $$
declare
  tbl text;
  body text := $pol$
    (
      current_setting('app.bypass_rls', true) = 'on'
      or org_id::text = current_setting('app.current_org', true)
    )
  $pol$;
begin
  foreach tbl in array array[
    'tax_rate_provider_configs',
    'tax_rate_quotes',
    'tax_locale_pack_meta',
    'subscription_events',
    'psp_provider_configs',
    'psp_settlement_batches',
    'psp_settlement_lines',
    'transfer_orders',
    'transfer_order_lines',
    'cost_layer_weights',
    'landed_cost_vouchers',
    'landed_cost_voucher_targets'
  ]
  loop
    execute format('grant select on %I to openbooks_read', tbl);
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format('drop policy if exists org_isolation on %I', tbl);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', tbl, body, body);
  end loop;
end $$;
