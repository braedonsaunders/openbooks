-- Item-native rate books and financial equipment charge-out.
ALTER TABLE items ADD COLUMN IF NOT EXISTS description text;
CREATE TABLE IF NOT EXISTS item_rate_books (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
  currency text NOT NULL, is_default boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_books_org_code ON item_rate_books (org_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_books_one_default ON item_rate_books (org_id) WHERE is_default AND is_active;
CREATE TABLE IF NOT EXISTS item_rate_versions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, rate_book_id uuid NOT NULL,
  effective_from date NOT NULL, effective_to date, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT item_rate_versions_valid_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_versions_book_from ON item_rate_versions (rate_book_id, effective_from);
CREATE INDEX IF NOT EXISTS item_rate_versions_effective ON item_rate_versions (org_id, effective_from, effective_to);
CREATE TABLE IF NOT EXISTS item_rate_profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, item_id uuid NOT NULL, base_unit text NOT NULL,
  pricing_policy text NOT NULL DEFAULT 'capped_ladder' CHECK (pricing_policy IN ('explicit','capped_ladder','lowest_cost')),
  invoice_presentation text NOT NULL DEFAULT 'rate_components' CHECK (invoice_presentation IN ('summary','rate_components')),
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_profiles_item ON item_rate_profiles (org_id, item_id);
CREATE TABLE IF NOT EXISTS item_rate_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, version_id uuid NOT NULL, item_id uuid NOT NULL,
  unit_code text NOT NULL, unit_name text NOT NULL, base_quantity numeric(19,4) NOT NULL CHECK (base_quantity > 0),
  cost_rate numeric(19,4) CHECK (cost_rate IS NULL OR cost_rate >= 0), bill_rate numeric(19,4) CHECK (bill_rate IS NULL OR bill_rate >= 0),
  sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_lines_version_item_unit ON item_rate_lines (version_id, item_id, unit_code);
CREATE INDEX IF NOT EXISTS item_rate_lines_item ON item_rate_lines (org_id, item_id);
CREATE TABLE IF NOT EXISTS item_rate_book_assignments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, rate_book_id uuid NOT NULL, customer_id uuid, project_id uuid,
  effective_from date, effective_to date, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT item_rate_assignment_one_scope CHECK (NOT (customer_id IS NOT NULL AND project_id IS NOT NULL)),
  CONSTRAINT item_rate_assignment_valid_range CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS item_rate_assignments_customer ON item_rate_book_assignments (org_id, customer_id);
CREATE INDEX IF NOT EXISTS item_rate_assignments_project ON item_rate_book_assignments (org_id, project_id);
CREATE TABLE IF NOT EXISTS equipment_units (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
  unit_number text NOT NULL, name text NOT NULL, description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','inactive','retired')),
  charge_item_id uuid, fixed_asset_id uuid, rate_book_id uuid, purchase_price numeric(19,4) NOT NULL DEFAULT 0,
  acquired_on date, in_service_on date, serial_number text, capacity_quantity numeric(19,4), capacity_unit text,
  CONSTRAINT equipment_units_nonnegative_purchase CHECK (purchase_price >= 0),
  CONSTRAINT equipment_units_positive_capacity CHECK (capacity_quantity IS NULL OR capacity_quantity > 0),
  CONSTRAINT equipment_units_valid_dates CHECK (acquired_on IS NULL OR in_service_on IS NULL OR in_service_on >= acquired_on),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_org_number ON equipment_units (org_id, unit_number);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_fixed_asset ON equipment_units (fixed_asset_id);
CREATE INDEX IF NOT EXISTS equipment_units_org_status ON equipment_units (org_id, status);
CREATE INDEX IF NOT EXISTS equipment_units_charge_item ON equipment_units (org_id, charge_item_id);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS equipment_unit_id uuid;
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS rate_version_id uuid;
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS rate_presentation text CHECK (rate_presentation IS NULL OR rate_presentation IN ('summary','rate_components'));
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS base_quantity numeric(19,4);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS base_unit text;
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS cost_rate numeric(19,4);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS bill_rate numeric(19,4);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS cost_amount numeric(19,4);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS bill_amount numeric(19,4);
ALTER TABLE document_lines ADD COLUMN IF NOT EXISTS recovery_account_id uuid;
UPDATE document_lines dl SET
  base_quantity = dl.quantity,
  base_unit = dl.unit,
  cost_rate = dl.unit_price,
  cost_amount = dl.amount,
  bill_rate = COALESCE(NULLIF(dl.custom->>'billRate', '')::numeric, CASE WHEN dl.quantity <> 0
    THEN (dl.amount * COALESCE(NULLIF(dl.cost_multiplier, 0), 1)) / dl.quantity ELSE 0 END),
  bill_amount = dl.quantity * COALESCE(NULLIF(dl.custom->>'billRate', '')::numeric,
    CASE WHEN dl.quantity <> 0 THEN (dl.amount * COALESCE(NULLIF(dl.cost_multiplier, 0), 1)) / dl.quantity ELSE 0 END),
  recovery_account_id = NULLIF(dl.custom->>'recoveryAccountId', '')::uuid
FROM documents d
WHERE d.id = dl.document_id AND d.kind = 'project_charge';
UPDATE document_lines dl SET rate_presentation = 'summary'
FROM documents d WHERE d.id = dl.document_id AND d.kind = 'project_charge' AND dl.rate_presentation IS NULL;
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS equipment_unit_id uuid;
CREATE TABLE IF NOT EXISTS charge_rate_components (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(), org_id uuid NOT NULL, document_line_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('cost','bill')), rate_line_id uuid, unit_code text NOT NULL, unit_name text NOT NULL,
  quantity numeric(19,4) NOT NULL CHECK (quantity > 0), rate numeric(19,4) NOT NULL CHECK (rate >= 0),
  amount numeric(19,4) NOT NULL CHECK (amount >= 0), sequence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid
);
CREATE INDEX IF NOT EXISTS charge_rate_components_line ON charge_rate_components (document_line_id, role, sequence);
GRANT SELECT ON item_rate_books, item_rate_versions, item_rate_profiles, item_rate_lines,
  item_rate_book_assignments, equipment_units, charge_rate_components TO openbooks_read;
