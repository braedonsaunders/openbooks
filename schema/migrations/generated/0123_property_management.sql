BEGIN;

CREATE TABLE IF NOT EXISTS managed_properties (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
  location_id uuid, fixed_asset_id uuid, code text NOT NULL, name text NOT NULL, property_type text NOT NULL,
  status text NOT NULL DEFAULT 'active', currency text NOT NULL, address jsonb NOT NULL DEFAULT '{}'::jsonb,
  rent_income_account_id uuid, cam_income_account_id uuid, deposit_liability_account_id uuid, default_bank_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT managed_properties_type_chk CHECK (property_type IN ('residential','commercial','mixed_use','industrial','other')),
  CONSTRAINT managed_properties_status_chk CHECK (status IN ('active','inactive','sold'))
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_properties_org_code ON managed_properties(org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS managed_properties_org_id_unique ON managed_properties(org_id, id);
CREATE INDEX IF NOT EXISTS managed_properties_subsidiary_status ON managed_properties(org_id, subsidiary_id, status);

CREATE TABLE IF NOT EXISTS property_units (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, property_id uuid NOT NULL,
  code text NOT NULL, name text, unit_type text, rentable_area numeric(19,4), bedrooms integer,
  status text NOT NULL DEFAULT 'vacant', created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT property_units_status_chk CHECK (status IN ('vacant','occupied','notice','offline')),
  CONSTRAINT property_units_area_positive CHECK (rentable_area IS NULL OR rentable_area > 0),
  CONSTRAINT property_units_bedrooms_nonnegative CHECK (bedrooms IS NULL OR bedrooms >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS property_units_property_code ON property_units(org_id, property_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS property_units_org_id_unique ON property_units(org_id, id);
CREATE INDEX IF NOT EXISTS property_units_property_status ON property_units(org_id, property_id, status);

CREATE TABLE IF NOT EXISTS property_leases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, property_id uuid NOT NULL, unit_id uuid,
  tenant_id uuid NOT NULL, lease_number text NOT NULL, status text NOT NULL DEFAULT 'draft', starts_on date NOT NULL,
  ends_on date, move_in_on date, move_out_on date, billing_day integer NOT NULL DEFAULT 1,
  payment_terms_days integer NOT NULL DEFAULT 0, security_deposit_required numeric(19,4) NOT NULL DEFAULT 0,
  cam_method text NOT NULL DEFAULT 'none', cam_share_percent numeric(19,4), late_fee_type text NOT NULL DEFAULT 'none',
  late_fee_value numeric(19,4) NOT NULL DEFAULT 0, grace_days integer NOT NULL DEFAULT 0,
  auto_invoice boolean NOT NULL DEFAULT true, auto_post boolean NOT NULL DEFAULT false,
  activated_at timestamptz, activated_by uuid, terminated_at timestamptz, terminated_by uuid, termination_reason text,
  notes text, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT property_leases_status_chk CHECK (status IN ('draft','active','notice','expired','terminated','cancelled')),
  CONSTRAINT property_leases_window CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT property_leases_billing_day CHECK (billing_day BETWEEN 1 AND 31),
  CONSTRAINT property_leases_terms CHECK (payment_terms_days >= 0 AND grace_days >= 0),
  CONSTRAINT property_leases_deposit CHECK (security_deposit_required >= 0),
  CONSTRAINT property_leases_cam_method_chk CHECK (cam_method IN ('none','fixed','pro_rata')),
  CONSTRAINT property_leases_cam_share CHECK (cam_share_percent IS NULL OR cam_share_percent BETWEEN 0 AND 100),
  CONSTRAINT property_leases_late_fee_type_chk CHECK (late_fee_type IN ('none','fixed','percent')),
  CONSTRAINT property_leases_late_fee CHECK (
    (late_fee_type = 'none' AND late_fee_value = 0)
    OR (late_fee_type = 'fixed' AND late_fee_value > 0)
    OR (late_fee_type = 'percent' AND late_fee_value > 0 AND late_fee_value <= 100)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS property_leases_org_number ON property_leases(org_id, lease_number);
CREATE UNIQUE INDEX IF NOT EXISTS property_leases_org_id_unique ON property_leases(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS property_leases_one_active_unit ON property_leases(org_id, unit_id)
  WHERE unit_id IS NOT NULL AND status IN ('active','notice');
CREATE INDEX IF NOT EXISTS property_leases_property_status ON property_leases(org_id, property_id, status);
CREATE INDEX IF NOT EXISTS property_leases_tenant_status ON property_leases(org_id, tenant_id, status);

CREATE TABLE IF NOT EXISTS lease_charges (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, lease_id uuid NOT NULL,
  charge_type text NOT NULL, description text NOT NULL, amount numeric(19,4) NOT NULL, frequency text NOT NULL DEFAULT 'monthly',
  effective_from date NOT NULL, effective_to date, income_account_id uuid, item_id uuid, tax_code_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT lease_charges_type_chk CHECK (charge_type IN ('base_rent','cam','parking','storage','utility','late_fee','other')),
  CONSTRAINT lease_charges_frequency_chk CHECK (frequency IN ('monthly','quarterly','annually','one_time')),
  CONSTRAINT lease_charges_amount_positive CHECK (amount > 0),
  CONSTRAINT lease_charges_window CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS lease_charges_org_id_unique ON lease_charges(org_id, id);
CREATE INDEX IF NOT EXISTS lease_charges_effective ON lease_charges(org_id, lease_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS lease_escalations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, lease_id uuid NOT NULL, effective_on date NOT NULL,
  method text NOT NULL, value numeric(19,4) NOT NULL, previous_amount numeric(19,4), new_amount numeric(19,4),
  status text NOT NULL DEFAULT 'scheduled', applied_at timestamptz, applied_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT lease_escalations_method_chk CHECK (method IN ('percent','fixed','new_amount')),
  CONSTRAINT lease_escalations_status_chk CHECK (status IN ('scheduled','applied','cancelled')),
  CONSTRAINT lease_escalations_value_positive CHECK (value > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS lease_escalations_once ON lease_escalations(org_id, lease_id, effective_on);
CREATE UNIQUE INDEX IF NOT EXISTS lease_escalations_org_id_unique ON lease_escalations(org_id, id);

CREATE TABLE IF NOT EXISTS lease_schedule_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, lease_id uuid NOT NULL, charge_id uuid NOT NULL,
  period_starts_on date NOT NULL, period_ends_on date NOT NULL, due_on date NOT NULL, amount numeric(19,4) NOT NULL,
  status text NOT NULL DEFAULT 'scheduled', invoice_document_id uuid, source_schedule_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT lease_schedule_status_chk CHECK (status IN ('scheduled','invoiced','credited','cancelled')),
  CONSTRAINT lease_schedule_window CHECK (period_ends_on >= period_starts_on),
  CONSTRAINT lease_schedule_amount_positive CHECK (amount > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS lease_schedule_period_once ON lease_schedule_lines(org_id, charge_id, period_starts_on);
CREATE UNIQUE INDEX IF NOT EXISTS lease_schedule_late_fee_once ON lease_schedule_lines(org_id, source_schedule_id) WHERE source_schedule_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lease_schedule_org_id_unique ON lease_schedule_lines(org_id, id);
CREATE INDEX IF NOT EXISTS lease_schedule_due ON lease_schedule_lines(org_id, status, due_on);

CREATE TABLE IF NOT EXISTS security_deposit_transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, lease_id uuid NOT NULL, kind text NOT NULL,
  occurred_on date NOT NULL, amount numeric(19,4) NOT NULL, bank_account_id uuid, offset_account_id uuid,
  applied_document_id uuid, journal_entry_id uuid NOT NULL, memo text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT security_deposits_kind_chk CHECK (kind IN ('received','interest','applied','refunded','adjustment_increase','adjustment_decrease')),
  CONSTRAINT security_deposits_amount_positive CHECK (amount > 0),
  CONSTRAINT security_deposits_application_shape CHECK ((kind = 'applied') = (applied_document_id IS NOT NULL)),
  CONSTRAINT security_deposits_account_shape CHECK (
    (kind NOT IN ('received','refunded') OR bank_account_id IS NOT NULL)
    AND (kind NOT IN ('interest','adjustment_increase','adjustment_decrease','applied') OR offset_account_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS security_deposits_entry ON security_deposit_transactions(org_id, journal_entry_id);
CREATE INDEX IF NOT EXISTS security_deposits_lease_date ON security_deposit_transactions(org_id, lease_id, occurred_on);

CREATE TABLE IF NOT EXISTS cam_pools (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, property_id uuid NOT NULL, name text NOT NULL,
  fiscal_year integer NOT NULL, period_starts_on date NOT NULL, period_ends_on date NOT NULL,
  allocation_basis text NOT NULL DEFAULT 'rentable_area', budget_amount numeric(19,4) NOT NULL DEFAULT 0,
  actual_amount numeric(19,4), expense_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft', finalized_at timestamptz, finalized_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT cam_pools_basis_chk CHECK (allocation_basis IN ('rentable_area','equal','custom')),
  CONSTRAINT cam_pools_status_chk CHECK (status IN ('draft','open','finalized','invoiced')),
  CONSTRAINT cam_pools_window CHECK (period_ends_on >= period_starts_on),
  CONSTRAINT cam_pools_budget_nonnegative CHECK (budget_amount >= 0),
  CONSTRAINT cam_pools_expense_accounts_array CHECK (jsonb_typeof(expense_account_ids) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS cam_pools_property_year_name ON cam_pools(org_id, property_id, fiscal_year, name);
CREATE UNIQUE INDEX IF NOT EXISTS cam_pools_org_id_unique ON cam_pools(org_id, id);

CREATE TABLE IF NOT EXISTS cam_allocations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, pool_id uuid NOT NULL, lease_id uuid NOT NULL,
  share_percent numeric(19,4) NOT NULL, budget_allocation numeric(19,4) NOT NULL DEFAULT 0,
  actual_allocation numeric(19,4), billed_estimate numeric(19,4) NOT NULL DEFAULT 0,
  reconciliation_amount numeric(19,4), invoice_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT cam_allocations_share CHECK (share_percent BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS cam_allocations_pool_lease ON cam_allocations(org_id, pool_id, lease_id);

-- Composite parent keys make every foreign key tenant-scoped.
CREATE UNIQUE INDEX IF NOT EXISTS subsidiaries_org_id_id_unique ON subsidiaries(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS locations_org_id_id_unique ON locations(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_org_id_id_unique ON fixed_assets(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique ON parties(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique ON accounts(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS items_org_id_id_unique ON items(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_org_id_id_unique ON tax_codes(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique ON documents(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_id_id_unique ON journal_entries(org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_property_billing_key
  ON documents(org_id, ((custom->'propertyManagement'->>'billingKey')))
  WHERE custom->'propertyManagement'->>'billingKey' IS NOT NULL;

DO $$ DECLARE fk record; BEGIN
  FOR fk IN SELECT * FROM (VALUES
    ('managed_properties','managed_properties_sub_org_fk','org_id, subsidiary_id','subsidiaries'),
    ('managed_properties','managed_properties_location_org_fk','org_id, location_id','locations'),
    ('managed_properties','managed_properties_asset_org_fk','org_id, fixed_asset_id','fixed_assets'),
    ('managed_properties','managed_properties_rent_income_org_fk','org_id, rent_income_account_id','accounts'),
    ('managed_properties','managed_properties_cam_income_org_fk','org_id, cam_income_account_id','accounts'),
    ('managed_properties','managed_properties_deposit_org_fk','org_id, deposit_liability_account_id','accounts'),
    ('managed_properties','managed_properties_bank_org_fk','org_id, default_bank_account_id','accounts'),
    ('property_units','property_units_property_org_fk','org_id, property_id','managed_properties'),
    ('property_leases','property_leases_property_org_fk','org_id, property_id','managed_properties'),
    ('property_leases','property_leases_unit_org_fk','org_id, unit_id','property_units'),
    ('property_leases','property_leases_tenant_org_fk','org_id, tenant_id','parties'),
    ('lease_charges','lease_charges_lease_org_fk','org_id, lease_id','property_leases'),
    ('lease_charges','lease_charges_income_org_fk','org_id, income_account_id','accounts'),
    ('lease_charges','lease_charges_item_org_fk','org_id, item_id','items'),
    ('lease_charges','lease_charges_tax_org_fk','org_id, tax_code_id','tax_codes'),
    ('lease_escalations','lease_escalations_lease_org_fk','org_id, lease_id','property_leases'),
    ('lease_schedule_lines','lease_schedule_lease_org_fk','org_id, lease_id','property_leases'),
    ('lease_schedule_lines','lease_schedule_charge_org_fk','org_id, charge_id','lease_charges'),
    ('lease_schedule_lines','lease_schedule_invoice_org_fk','org_id, invoice_document_id','documents'),
    ('lease_schedule_lines','lease_schedule_source_org_fk','org_id, source_schedule_id','lease_schedule_lines'),
    ('security_deposit_transactions','security_deposits_lease_org_fk','org_id, lease_id','property_leases'),
    ('security_deposit_transactions','security_deposits_bank_org_fk','org_id, bank_account_id','accounts'),
    ('security_deposit_transactions','security_deposits_offset_org_fk','org_id, offset_account_id','accounts'),
    ('security_deposit_transactions','security_deposits_document_org_fk','org_id, applied_document_id','documents'),
    ('security_deposit_transactions','security_deposits_entry_org_fk','org_id, journal_entry_id','journal_entries'),
    ('cam_pools','cam_pools_property_org_fk','org_id, property_id','managed_properties'),
    ('cam_allocations','cam_allocations_pool_org_fk','org_id, pool_id','cam_pools'),
    ('cam_allocations','cam_allocations_lease_org_fk','org_id, lease_id','property_leases'),
    ('cam_allocations','cam_allocations_invoice_org_fk','org_id, invoice_document_id','documents')
  ) AS refs(child_table,constraint_name,child_columns,parent_table)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=fk.constraint_name AND conrelid=fk.child_table::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I(org_id,id) DEFERRABLE INITIALLY IMMEDIATE',
        fk.child_table,fk.constraint_name,fk.child_columns,fk.parent_table);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION property_financial_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF openbooks_sandbox_wipe_allowed(CASE WHEN TG_OP='DELETE' THEN OLD.org_id ELSE NEW.org_id END) THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'property financial evidence is append-only';
END $$;
DROP TRIGGER IF EXISTS security_deposits_append_only ON security_deposit_transactions;
CREATE TRIGGER security_deposits_append_only BEFORE UPDATE OR DELETE ON security_deposit_transactions
  FOR EACH ROW EXECUTE FUNCTION property_financial_evidence_guard();
DROP TRIGGER IF EXISTS lease_escalations_applied_append_only ON lease_escalations;
CREATE TRIGGER lease_escalations_applied_append_only BEFORE UPDATE OR DELETE ON lease_escalations
  FOR EACH ROW WHEN (OLD.status='applied') EXECUTE FUNCTION property_financial_evidence_guard();

DO $$ DECLARE tbl text; body text := $policy$(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))$policy$;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['managed_properties','property_units','property_leases','lease_charges','lease_escalations',
    'lease_schedule_lines','security_deposit_transactions','cam_pools','cam_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',tbl,body,body);
    EXECUTE format('GRANT SELECT ON %I TO openbooks_read',tbl);
  END LOOP;
END $$;

COMMIT;
