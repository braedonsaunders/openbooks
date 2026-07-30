BEGIN;

-- Forward-only supplement for constraints added to referential-integrity.sql
-- after some clusters had already recorded that file's digest. A fresh install
-- already has these relations; existing clusters receive and validate only the
-- missing constraints.
CREATE TABLE IF NOT EXISTS _migration_control_exceptions (
  migration_filename text NOT NULL,
  control_key text NOT NULL,
  affected_rows bigint NOT NULL CHECK (affected_rows >= 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (migration_filename, control_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_created_by_fkey') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_org_id_fkey') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_party_id_fkey') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_updated_by_fkey') THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id) DEFERRABLE NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_collected_account_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_collected_account_id_fkey
      FOREIGN KEY (collected_account_id) REFERENCES accounts(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_created_by_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_document_line_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_document_line_id_fkey
      FOREIGN KEY (document_line_id) REFERENCES document_lines(id) ON DELETE CASCADE DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_org_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_paid_account_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_paid_account_id_fkey
      FOREIGN KEY (paid_account_id) REFERENCES accounts(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_tax_code_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_tax_code_id_fkey
      FOREIGN KEY (tax_code_id) REFERENCES tax_codes(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_updated_by_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES users(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_line_tax_components_withholding_account_id_fkey') THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_withholding_account_id_fkey
      FOREIGN KEY (withholding_account_id) REFERENCES accounts(id) DEFERRABLE NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_lines_tax_group_id_fkey') THEN
    ALTER TABLE document_lines ADD CONSTRAINT document_lines_tax_group_id_fkey
      FOREIGN KEY (tax_group_id) REFERENCES tax_groups(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_instructions_mandate_id_fkey') THEN
    ALTER TABLE payment_instructions ADD CONSTRAINT payment_instructions_mandate_id_fkey
      FOREIGN KEY (mandate_id) REFERENCES payment_mandates(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_codes_jurisdiction_id_fkey') THEN
    ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_jurisdiction_id_fkey
      FOREIGN KEY (jurisdiction_id) REFERENCES tax_jurisdictions(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_codes_withholding_account_id_fkey') THEN
    ALTER TABLE tax_codes ADD CONSTRAINT tax_codes_withholding_account_id_fkey
      FOREIGN KEY (withholding_account_id) REFERENCES accounts(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_depreciation_pools_book_id_fkey') THEN
    ALTER TABLE tax_depreciation_pools ADD CONSTRAINT tax_depreciation_pools_book_id_fkey
      FOREIGN KEY (book_id) REFERENCES accounting_books(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_depreciation_pools_subsidiary_id_fkey') THEN
    ALTER TABLE tax_depreciation_pools ADD CONSTRAINT tax_depreciation_pools_subsidiary_id_fkey
      FOREIGN KEY (subsidiary_id) REFERENCES subsidiaries(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_return_forms_jurisdiction_id_fkey') THEN
    ALTER TABLE tax_return_forms ADD CONSTRAINT tax_return_forms_jurisdiction_id_fkey
      FOREIGN KEY (jurisdiction_id) REFERENCES tax_jurisdictions(id) DEFERRABLE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'time_entries_bill_rate_version_id_fkey') THEN
    ALTER TABLE time_entries ADD CONSTRAINT time_entries_bill_rate_version_id_fkey
      FOREIGN KEY (bill_rate_version_id) REFERENCES item_rate_versions(id) DEFERRABLE NOT VALID;
  END IF;
END
$$;

ALTER TABLE contacts VALIDATE CONSTRAINT contacts_created_by_fkey;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_org_id_fkey;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_party_id_fkey;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_updated_by_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_collected_account_id_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_created_by_fkey;
-- Historical source-owned tax evidence may predate its local document line.
-- Preserve and quantify it; the NOT VALID FK still rejects every new orphan.
INSERT INTO _migration_control_exceptions (
  migration_filename,
  control_key,
  affected_rows,
  details
)
SELECT
  'referential-integrity-v2.sql',
  'document_line_tax_components_document_line_fk',
  count(*),
  jsonb_build_object(
    'reason', 'historical tax component references a document line absent before the FK was introduced',
    'enforcement', 'NOT VALID foreign key enforces all new and changed rows',
    'remediation', 'preserve evidence and reconstruct or explicitly archive source lineage before validation'
  )
FROM document_line_tax_components component
WHERE NOT EXISTS (
  SELECT 1
    FROM document_lines line
   WHERE line.id = component.document_line_id
)
ON CONFLICT (migration_filename, control_key) DO UPDATE
  SET affected_rows = excluded.affected_rows,
      detected_at = now(),
      details = excluded.details;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_org_id_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_paid_account_id_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_tax_code_id_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_updated_by_fkey;
ALTER TABLE document_line_tax_components VALIDATE CONSTRAINT document_line_tax_components_withholding_account_id_fkey;
ALTER TABLE document_lines VALIDATE CONSTRAINT document_lines_tax_group_id_fkey;
ALTER TABLE payment_instructions VALIDATE CONSTRAINT payment_instructions_mandate_id_fkey;
ALTER TABLE tax_codes VALIDATE CONSTRAINT tax_codes_jurisdiction_id_fkey;
ALTER TABLE tax_codes VALIDATE CONSTRAINT tax_codes_withholding_account_id_fkey;
ALTER TABLE tax_depreciation_pools VALIDATE CONSTRAINT tax_depreciation_pools_book_id_fkey;
ALTER TABLE tax_depreciation_pools VALIDATE CONSTRAINT tax_depreciation_pools_subsidiary_id_fkey;
ALTER TABLE tax_return_forms VALIDATE CONSTRAINT tax_return_forms_jurisdiction_id_fkey;
ALTER TABLE time_entries VALIDATE CONSTRAINT time_entries_bill_rate_version_id_fkey;

CREATE INDEX IF NOT EXISTS inventory_provisional_issue
  ON inventory_provisional_costs (issue_movement_id);
CREATE INDEX IF NOT EXISTS inventory_provisional_settlement_entry
  ON inventory_provisional_settlements (correction_journal_entry_id);
CREATE INDEX IF NOT EXISTS recognition_lines_journal_entry
  ON recognition_schedule_lines (journal_entry_id);

COMMIT;
