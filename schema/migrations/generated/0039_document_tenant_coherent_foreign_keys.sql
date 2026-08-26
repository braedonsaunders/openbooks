-- OpenBooks forward migration 0039_document_tenant_coherent_foreign_keys.
--
-- Document headers, lines, and lineage edges carried org_id but most of their
-- financial foreign keys referenced a globally unique id alone. That allowed
-- a row owned by one tenant to cite another tenant's party, account, document,
-- dimension, tax profile, inventory location, or posting evidence. RLS could
-- hide the cited row later, leaving financial evidence that ordinary reports
-- and posting code could not resolve.
--
-- This migration does not rewrite, null, or delete history. It first inspects
-- every affected reference and aborts with the exact child row, tenant, value,
-- and referenced tenant when legacy evidence is incoherent. Once that
-- preflight passes, composite (org_id, id) keys make cross-tenant references
-- unrepresentable and the replacement constraints are validated in place.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Fail closed before changing constraints. A missing target is reported by
-- the same preflight (referenced_org_id = null), which is more actionable than
-- a bare validation error after the DDL has started.
DO $preflight$
DECLARE
  reference record;
  child_id text;
  child_org_id uuid;
  reference_id uuid;
  referenced_org_id uuid;
BEGIN
  FOR reference IN
    SELECT *
      FROM (VALUES
        ('documents', 'id', 'party_id', 'parties', 'id'),
        ('documents', 'id', 'payment_card_id', 'payment_cards', 'id'),
        ('documents', 'id', 'subsidiary_id', 'subsidiaries', 'id'),
        ('documents', 'id', 'department_id', 'departments', 'id'),
        ('documents', 'id', 'project_id', 'projects', 'id'),
        ('documents', 'id', 'location_id', 'locations', 'id'),
        ('documents', 'id', 'class_id', 'classes', 'id'),
        ('documents', 'id', 'posted_entry_id', 'journal_entries', 'id'),
        ('documents', 'id', 'reversal_entry_id', 'journal_entries', 'id'),
        ('document_lines', 'id', 'document_id', 'documents', 'id'),
        ('document_lines', 'id', 'item_id', 'items', 'id'),
        ('document_lines', 'id', 'account_id', 'accounts', 'id'),
        ('document_lines', 'id', 'tax_code_id', 'tax_codes', 'id'),
        ('document_lines', 'id', 'tax_group_id', 'tax_groups', 'id'),
        ('document_lines', 'id', 'party_id', 'parties', 'id'),
        ('document_lines', 'id', 'department_id', 'departments', 'id'),
        ('document_lines', 'id', 'project_id', 'projects', 'id'),
        ('document_lines', 'id', 'location_id', 'locations', 'id'),
        ('document_lines', 'id', 'class_id', 'classes', 'id'),
        ('document_lines', 'id', 'subsidiary_id', 'subsidiaries', 'id'),
        ('document_lines', 'id', 'employee_id', 'parties', 'id'),
        ('document_lines', 'id', 'time_entry_id', 'time_entries', 'id'),
        ('document_lines', 'id', 'time_type_id', 'time_types', 'id'),
        ('document_lines', 'id', 'billed_by_line_id', 'document_lines', 'id'),
        ('document_lines', 'id', 'field_ticket_id', 'field_tickets', 'document_id'),
        ('document_lines', 'id', 'equipment_unit_id', 'equipment_units', 'id'),
        ('document_lines', 'id', 'rate_version_id', 'item_rate_versions', 'id'),
        ('document_lines', 'id', 'recovery_account_id', 'accounts', 'id'),
        ('document_lines', 'id', 'stock_location_id', 'stock_locations', 'id'),
        ('document_links', 'id', 'from_document_id', 'documents', 'id'),
        ('document_links', 'id', 'to_document_id', 'documents', 'id')
      ) AS refs(child_table, child_key, child_column, parent_table, parent_key)
  LOOP
    child_id := null;
    EXECUTE format(
      'SELECT c.%1$I::text, c.org_id, c.%2$I, p.org_id
         FROM public.%3$I c
         LEFT JOIN public.%4$I p ON p.%5$I = c.%2$I
        WHERE c.%2$I IS NOT NULL
          AND p.org_id IS DISTINCT FROM c.org_id
        ORDER BY c.%1$I
        LIMIT 1',
      reference.child_key,
      reference.child_column,
      reference.child_table,
      reference.parent_table,
      reference.parent_key
    )
      INTO child_id, child_org_id, reference_id, referenced_org_id;

    IF child_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'legacy data violates tenant coherence: public.%I.%I',
          reference.child_table,
          reference.child_column
        ),
        DETAIL = jsonb_build_object(
          'table', reference.child_table,
          'row_id', child_id,
          'org_id', child_org_id,
          'column', reference.child_column,
          'reference_id', reference_id,
          'referenced_table', reference.parent_table,
          'referenced_org_id', referenced_org_id
        )::text,
        HINT = 'Reconcile the source evidence to a reference owned by the same organization, then retry the upgrade. This migration will not rewrite financial history.';
    END IF;
  END LOOP;
END
$preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- Some existed in the canonical baseline already; IF NOT EXISTS keeps the
-- migration correct for both fresh and upgraded installations.
CREATE UNIQUE INDEX IF NOT EXISTS accounting_periods_org_id_id_unique
  ON public.accounting_periods (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique
  ON public.accounts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS classes_org_id_id_unique
  ON public.classes (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_id_id_unique
  ON public.departments (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS document_lines_org_id_id_unique
  ON public.document_lines (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique
  ON public.documents (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS equipment_units_org_id_id_unique
  ON public.equipment_units (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS field_tickets_org_id_document_id_unique
  ON public.field_tickets (org_id, document_id);
CREATE UNIQUE INDEX IF NOT EXISTS items_org_id_id_unique
  ON public.items (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS item_rate_versions_org_id_id_unique
  ON public.item_rate_versions (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_org_id_id_unique
  ON public.journal_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS locations_org_id_id_unique
  ON public.locations (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique
  ON public.parties (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_cards_org_id_id_unique
  ON public.payment_cards (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_unique
  ON public.projects (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_org_id_id_unique
  ON public.stock_locations (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subsidiaries_org_id_id_unique
  ON public.subsidiaries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_codes_org_id_id_unique
  ON public.tax_codes (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS tax_groups_org_id_id_unique
  ON public.tax_groups (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_org_id_id_unique
  ON public.time_entries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS time_types_org_id_id_unique
  ON public.time_types (org_id, id);

-- Replace the global-id header references with tenant-coherent equivalents.
ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_party_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_payment_card_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_subsidiary_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_department_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_project_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_location_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_class_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_posted_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS documents_reversal_entry_id_fkey;

ALTER TABLE public.documents ADD CONSTRAINT documents_party_id_fkey
  FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_payment_card_id_fkey
  FOREIGN KEY (org_id, payment_card_id) REFERENCES public.payment_cards(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_subsidiary_id_fkey
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_department_id_fkey
  FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_project_id_fkey
  FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_location_id_fkey
  FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_class_id_fkey
  FOREIGN KEY (org_id, class_id) REFERENCES public.classes(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_posted_entry_id_fkey
  FOREIGN KEY (org_id, posted_entry_id) REFERENCES public.journal_entries(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.documents ADD CONSTRAINT documents_reversal_entry_id_fkey
  FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id)
  DEFERRABLE NOT VALID;

-- Lines carry the densest financial reference set. Every tenant-owned target,
-- including dimension overrides and operational provenance used to price or
-- bill the line, is pinned to the line's org_id.
ALTER TABLE public.document_lines
  DROP CONSTRAINT IF EXISTS document_lines_document_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_item_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_account_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_tax_code_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_tax_group_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_party_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_department_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_project_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_location_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_class_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_subsidiary_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_employee_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_time_entry_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_time_type_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_billed_by_line_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_field_ticket_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_equipment_unit_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_rate_version_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_recovery_account_id_fkey,
  DROP CONSTRAINT IF EXISTS document_lines_stock_location_id_fkey;

ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_document_id_fkey
  FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_item_id_fkey
  FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_account_id_fkey
  FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_tax_code_id_fkey
  FOREIGN KEY (org_id, tax_code_id) REFERENCES public.tax_codes(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_tax_group_id_fkey
  FOREIGN KEY (org_id, tax_group_id) REFERENCES public.tax_groups(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_party_id_fkey
  FOREIGN KEY (org_id, party_id) REFERENCES public.parties(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_department_id_fkey
  FOREIGN KEY (org_id, department_id) REFERENCES public.departments(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_project_id_fkey
  FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_location_id_fkey
  FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_class_id_fkey
  FOREIGN KEY (org_id, class_id) REFERENCES public.classes(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_subsidiary_id_fkey
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_employee_id_fkey
  FOREIGN KEY (org_id, employee_id) REFERENCES public.parties(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_time_entry_id_fkey
  FOREIGN KEY (org_id, time_entry_id) REFERENCES public.time_entries(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_time_type_id_fkey
  FOREIGN KEY (org_id, time_type_id) REFERENCES public.time_types(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_billed_by_line_id_fkey
  FOREIGN KEY (org_id, billed_by_line_id) REFERENCES public.document_lines(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_field_ticket_id_fkey
  FOREIGN KEY (org_id, field_ticket_id) REFERENCES public.field_tickets(org_id, document_id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_equipment_unit_id_fkey
  FOREIGN KEY (org_id, equipment_unit_id) REFERENCES public.equipment_units(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_rate_version_id_fkey
  FOREIGN KEY (org_id, rate_version_id) REFERENCES public.item_rate_versions(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_recovery_account_id_fkey
  FOREIGN KEY (org_id, recovery_account_id) REFERENCES public.accounts(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_lines ADD CONSTRAINT document_lines_stock_location_id_fkey
  FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id)
  DEFERRABLE NOT VALID;

-- Lineage edges must remain inside one tenant aggregate on both ends.
ALTER TABLE public.document_links
  DROP CONSTRAINT IF EXISTS document_links_from_document_id_fkey,
  DROP CONSTRAINT IF EXISTS document_links_to_document_id_fkey;

ALTER TABLE public.document_links ADD CONSTRAINT document_links_from_document_id_fkey
  FOREIGN KEY (org_id, from_document_id) REFERENCES public.documents(org_id, id)
  DEFERRABLE NOT VALID;
ALTER TABLE public.document_links ADD CONSTRAINT document_links_to_document_id_fkey
  FOREIGN KEY (org_id, to_document_id) REFERENCES public.documents(org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.documents VALIDATE CONSTRAINT documents_party_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_payment_card_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_subsidiary_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_department_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_project_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_location_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_class_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_posted_entry_id_fkey;
ALTER TABLE public.documents VALIDATE CONSTRAINT documents_reversal_entry_id_fkey;

ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_document_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_item_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_account_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_tax_code_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_tax_group_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_party_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_department_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_project_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_location_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_class_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_subsidiary_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_employee_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_time_entry_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_time_type_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_billed_by_line_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_field_ticket_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_equipment_unit_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_rate_version_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_recovery_account_id_fkey;
ALTER TABLE public.document_lines VALIDATE CONSTRAINT document_lines_stock_location_id_fkey;

ALTER TABLE public.document_links VALIDATE CONSTRAINT document_links_from_document_id_fkey;
ALTER TABLE public.document_links VALIDATE CONSTRAINT document_links_to_document_id_fkey;
