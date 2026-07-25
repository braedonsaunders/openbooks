-- Customer payment acceptance: provider configs (Stripe / Adyen / GoCardless),
-- surcharge rules, hosted payment links, and idempotent payment attempts.
-- Unifies with the PSP settlement tables from 0063 (same config table).

-- Widen provider enums to cover acceptance providers.
ALTER TABLE psp_provider_configs DROP CONSTRAINT IF EXISTS psp_provider_configs_provider_chk;
ALTER TABLE psp_provider_configs
  ADD CONSTRAINT psp_provider_configs_provider_chk
  CHECK (provider IN ('stripe', 'adyen', 'gocardless', 'recurly', 'chargebee'));

ALTER TABLE psp_settlement_batches DROP CONSTRAINT IF EXISTS psp_settlement_batches_provider_chk;
ALTER TABLE psp_settlement_batches
  ADD CONSTRAINT psp_settlement_batches_provider_chk
  CHECK (provider IN ('stripe', 'adyen', 'gocardless', 'recurly', 'chargebee'));

-- Acceptance configuration on the unified provider config row.
ALTER TABLE psp_provider_configs ADD COLUMN IF NOT EXISTS acceptance_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE psp_provider_configs ADD COLUMN IF NOT EXISTS publishable_key text;
ALTER TABLE psp_provider_configs ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE psp_provider_configs ADD COLUMN IF NOT EXISTS surcharge_rule_id uuid;

-- Surcharge rules: effective-dated, one scoped fee-income account per rule.
CREATE TABLE IF NOT EXISTS payment_surcharge_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  calculation text NOT NULL,
  percent numeric(19,4),
  fixed_amount numeric(19,4),
  cap_amount numeric(19,4),
  fee_income_account_id uuid NOT NULL,
  provider text,
  payment_method text NOT NULL DEFAULT 'all',
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT payment_surcharge_rules_calc_chk CHECK (calculation IN ('percent', 'fixed', 'percent_plus_fixed')),
  CONSTRAINT payment_surcharge_rules_method_chk CHECK (payment_method IN ('all', 'card', 'bank_debit')),
  CONSTRAINT payment_surcharge_rules_provider_chk CHECK (provider IS NULL OR provider IN ('stripe', 'adyen', 'gocardless')),
  CONSTRAINT payment_surcharge_rules_valid_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS payment_surcharge_rules_org ON payment_surcharge_rules (org_id, is_active, effective_from);

-- Hosted payment links on posted customer invoices. The token is a 192-bit
-- url-safe random bearer credential (possession-authenticated, like field-
-- ticket signing tokens).
CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  token text NOT NULL,
  document_id uuid NOT NULL,
  party_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  provider text NOT NULL,
  bank_account_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  surcharge_amount numeric(19,4) NOT NULL DEFAULT 0,
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_on date,
  memo text,
  paid_payment_document_id uuid,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT payment_links_provider_chk CHECK (provider IN ('stripe', 'adyen', 'gocardless')),
  CONSTRAINT payment_links_status_chk CHECK (status IN ('active', 'paid', 'void', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_token ON payment_links (token);
CREATE INDEX IF NOT EXISTS payment_links_doc ON payment_links (org_id, document_id, status);

-- One row per provider checkout attempt; the unique (org, provider,
-- external_ref) is the webhook idempotency key.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  link_id uuid NOT NULL,
  provider text NOT NULL,
  external_ref text NOT NULL,
  status text NOT NULL DEFAULT 'initiated',
  amount numeric(19,4),
  surcharge_amount numeric(19,4),
  fee_amount numeric(19,4),
  payment_document_id uuid,
  journal_entry_id uuid,
  event_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,
  CONSTRAINT payment_attempts_status_chk CHECK (status IN ('initiated', 'succeeded', 'failed', 'cancelled', 'refunded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_org_ext ON payment_attempts (org_id, provider, external_ref);
CREATE INDEX IF NOT EXISTS payment_attempts_link ON payment_attempts (link_id);

-- Tenant isolation + read role (standard pattern, matches 0041 et al.)
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
    'payment_surcharge_rules',
    'payment_links',
    'payment_attempts'
  ]
  loop
    execute format('grant select on %I to openbooks_read', tbl);
    execute format('alter table %I enable row level security', tbl);
    execute format('alter table %I force row level security', tbl);
    execute format('drop policy if exists org_isolation on %I', tbl);
    execute format('create policy org_isolation on %I using (%s) with check (%s)', tbl, body, body);
  end loop;
end $$;
