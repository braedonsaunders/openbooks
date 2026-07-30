-- Converge fresh and long-lived catalogs without losing historical evidence.
--
-- The retired columns below never became part of the authoritative schema.
-- Production profiling before this migration found only null/default values,
-- and no current code reads or writes them. Their removal eliminates dormant
-- parallel sources of project/rate policy.

ALTER TABLE item_rate_book_assignments
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS project_task_id,
  DROP COLUMN IF EXISTS priority;

ALTER TABLE project_types
  DROP COLUMN IF EXISTS labor_rate_book_id,
  DROP COLUMN IF EXISTS labor_rate_policy;

ALTER TABLE projects
  DROP COLUMN IF EXISTS labor_rate_book_id,
  DROP COLUMN IF EXISTS labor_rate_policy;

-- Long-lived databases received duplicate FK names from an early integrity
-- pass. Keep the canonical item_rate_assignments_* constraints installed by
-- 0065 and remove only the duplicate definitions.
ALTER TABLE item_rate_book_assignments
  DROP CONSTRAINT IF EXISTS item_rate_book_assignments_department_fk,
  DROP CONSTRAINT IF EXISTS item_rate_book_assignments_location_fk,
  DROP CONSTRAINT IF EXISTS item_rate_book_assignments_subsidiary_fk;

-- Stable NetSuite/customer identity is required for idempotent mirror imports.
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_netsuite_customer_identity
  ON parties (
    org_id,
    coalesce(
      nullif(custom->>'nsId', ''),
      case
        when custom->'source'->>'system' = 'adminapp2'
          then nullif(custom->'source'->>'externalId', '')
        else null
      end
    )
  )
  WHERE coalesce(
    nullif(custom->>'nsId', ''),
    case
      when custom->'source'->>'system' = 'adminapp2'
        then nullif(custom->'source'->>'externalId', '')
      else null
    end
  ) IS NOT NULL;

-- Orphaned component rows predate the parent FK. They cannot participate in a
-- current document calculation, but remain institutional evidence. Preserve
-- the complete row verbatim in an immutable tenant-scoped archive before
-- removing it from the active child table and validating the parent FK.
--
-- On a clean bootstrap the broad referential-integrity passes run after the
-- numbered migrations. Install this FK here when it is absent so the migration
-- is self-contained; NOT VALID protects new writes while permitting the
-- evidence-preserving legacy cleanup below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'document_line_tax_components'::regclass
       AND conname =
         'document_line_tax_components_document_line_id_fkey'
  ) THEN
    ALTER TABLE document_line_tax_components
      ADD CONSTRAINT document_line_tax_components_document_line_id_fkey
      FOREIGN KEY (document_line_id)
      REFERENCES document_lines(id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS orphaned_tax_component_evidence (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  original_document_line_id uuid NOT NULL,
  payload jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archive_reason text NOT NULL,
  migration_filename text NOT NULL,
  CONSTRAINT orphaned_tax_component_archive_reason
    CHECK (length(btrim(archive_reason)) BETWEEN 10 AND 500)
);

CREATE INDEX IF NOT EXISTS orphaned_tax_component_evidence_org
  ON orphaned_tax_component_evidence (org_id, archived_at);

GRANT SELECT ON orphaned_tax_component_evidence TO openbooks_read;
ALTER TABLE orphaned_tax_component_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE orphaned_tax_component_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON orphaned_tax_component_evidence;
CREATE POLICY org_isolation ON orphaned_tax_component_evidence
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

CREATE OR REPLACE FUNCTION protect_orphaned_tax_component_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'orphaned tax-component archive is immutable (component %)',
    OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS orphaned_tax_component_evidence_guard
  ON orphaned_tax_component_evidence;
CREATE TRIGGER orphaned_tax_component_evidence_guard
BEFORE UPDATE OR DELETE ON orphaned_tax_component_evidence
FOR EACH ROW EXECUTE FUNCTION protect_orphaned_tax_component_evidence();

WITH orphaned AS (
  SELECT component.*
    FROM document_line_tax_components component
    LEFT JOIN document_lines line
      ON line.id = component.document_line_id
   WHERE line.id IS NULL
),
archived AS (
  INSERT INTO orphaned_tax_component_evidence (
    id,
    org_id,
    original_document_line_id,
    payload,
    archive_reason,
    migration_filename
  )
  SELECT
    orphaned.id,
    orphaned.org_id,
    orphaned.document_line_id,
    to_jsonb(orphaned),
    'Parent document line is absent; preserve the exact legacy component row outside the active document subledger before enforcing referential integrity.',
    'generated/0109_schema_convergence_and_legacy_evidence.sql'
  FROM orphaned
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT count(*) FROM archived;

DO $$
DECLARE
  missing_archive bigint;
BEGIN
  SELECT count(*)
    INTO missing_archive
    FROM document_line_tax_components component
    LEFT JOIN document_lines line
      ON line.id = component.document_line_id
    LEFT JOIN orphaned_tax_component_evidence archive
      ON archive.id = component.id
     AND archive.org_id = component.org_id
   WHERE line.id IS NULL
     AND archive.id IS NULL;
  IF missing_archive <> 0 THEN
    RAISE EXCEPTION
      '% orphaned tax-component rows were not archived; refusing cleanup',
      missing_archive;
  END IF;
END
$$;

DELETE FROM document_line_tax_components component
WHERE NOT EXISTS (
  SELECT 1
    FROM document_lines line
   WHERE line.id = component.document_line_id
)
AND EXISTS (
  SELECT 1
    FROM orphaned_tax_component_evidence archive
   WHERE archive.id = component.id
     AND archive.org_id = component.org_id
);

ALTER TABLE document_line_tax_components
  VALIDATE CONSTRAINT document_line_tax_components_document_line_id_fkey;

-- Repair legacy void metadata only from objective evidence:
--   * an exact, unique journal reversal;
--   * the existing transaction audit event when present;
--   * otherwise the reserved connector/system principal and an explicit
--     verification/source-deletion classification.
DO $$
DECLARE
  ambiguous bigint;
BEGIN
  SELECT count(*)
    INTO ambiguous
    FROM documents document
   WHERE document.status = 'voided'
     AND document.posted_entry_id IS NOT NULL
     AND document.reversal_entry_id IS NULL
     AND (
       SELECT count(*)
         FROM journal_entries reversal
        WHERE reversal.org_id = document.org_id
          AND reversal.reverses_entry_id = document.posted_entry_id
          AND reversal.status IN ('posted', 'reversed')
     ) <> 1;
  IF ambiguous <> 0 THEN
    RAISE EXCEPTION
      '% historical voids do not have exactly one reversal; refusing metadata repair',
      ambiguous;
  END IF;
END
$$;

SELECT set_config('openbooks.amend', 'on', true);
SELECT set_config('openbooks.migration', 'on', true);

WITH before_state AS MATERIALIZED (
  SELECT
    document.id,
    document.org_id,
    document.status,
    document.voided_at AS before_voided_at,
    document.voided_by AS before_voided_by,
    document.void_reason AS before_void_reason,
    document.reversal_entry_id AS before_reversal_entry_id,
    document.updated_at,
    document.created_at,
    reversal.id AS exact_reversal_entry_id,
    evidence.at AS evidence_at,
    evidence.actor_id AS evidence_actor_id,
    evidence.reason AS evidence_reason,
    CASE
      WHEN document.document_number LIKE 'VERIFY-IC-%'
        THEN 'Historical verification fixture void; exact reversal lineage linked during control remediation.'
      WHEN document.custom ? 'netsuiteLegacyPriceRoundingIdentity'
        THEN 'Superseded by native append-only project financial adjustment evidence.'
      WHEN document.custom ? 'nsId'
        THEN 'Historical source-deletion void; exact reversal lineage linked during control remediation.'
      ELSE
        'Historical automated void; exact reversal lineage and control evidence restored during migration.'
    END AS fallback_reason
  FROM documents document
  LEFT JOIN LATERAL (
    SELECT candidate.id
      FROM journal_entries candidate
     WHERE candidate.org_id = document.org_id
       AND candidate.reverses_entry_id = document.posted_entry_id
       AND candidate.status IN ('posted', 'reversed')
     ORDER BY candidate.id
     LIMIT 1
  ) reversal ON true
  LEFT JOIN LATERAL (
    SELECT
      audit.at,
      audit.actor_id,
      audit.changes->>'reason' AS reason
    FROM audit_log audit
    WHERE audit.org_id = document.org_id
      AND audit.table_name = 'documents'
      AND audit.row_id = document.id
      AND (
        audit.request_id IN ('mirror', 'source-deletion-resolution')
        OR audit.changes->>'reason' LIKE 'source_deleted:%'
        OR audit.changes->>'reason' LIKE '%deleted at source%'
        OR audit.changes->>'reason' LIKE 'Superseded by native append-only%'
      )
    ORDER BY
      CASE
        WHEN audit.request_id IN ('mirror', 'source-deletion-resolution')
          OR audit.changes->>'reason' LIKE 'source_deleted:%'
          OR audit.changes->>'reason' LIKE '%deleted at source%'
        THEN 0 ELSE 1
      END,
      audit.at DESC
    LIMIT 1
  ) evidence ON true
  WHERE NOT (
    document.status <> 'voided'
    OR (
      document.voided_at IS NOT NULL
      AND document.voided_by IS NOT NULL
      AND document.void_reason IS NOT NULL
      AND length(btrim(document.void_reason)) BETWEEN 5 AND 500
      AND (
        document.posted_entry_id IS NULL
        OR document.reversal_entry_id IS NOT NULL
      )
    )
  )
),
updated AS (
  UPDATE documents document
     SET voided_at = coalesce(
           document.voided_at,
           before_state.evidence_at,
           document.updated_at,
           document.created_at
         ),
         voided_by = coalesce(
           document.voided_by,
           before_state.evidence_actor_id,
           '00000000-0000-0000-0000-000000000000'::uuid
         ),
         void_reason = CASE
           WHEN document.void_reason IS NOT NULL
             AND length(btrim(document.void_reason)) BETWEEN 5 AND 500
             THEN document.void_reason
           ELSE left(
             coalesce(
               nullif(btrim(before_state.evidence_reason), ''),
               before_state.fallback_reason
             ),
             500
           )
         END,
         reversal_entry_id = coalesce(
           document.reversal_entry_id,
           before_state.exact_reversal_entry_id
         ),
         updated_at = now()
    FROM before_state
   WHERE document.id = before_state.id
     AND document.org_id = before_state.org_id
  RETURNING
    document.id,
    document.org_id,
    document.voided_at,
    document.voided_by,
    document.void_reason,
    document.reversal_entry_id
)
INSERT INTO audit_log (
  org_id,
  table_name,
  row_id,
  action,
  changes,
  actor_id,
  request_id
)
SELECT
  before_state.org_id,
  'documents',
  before_state.id,
  'update',
  jsonb_build_object(
    'mode', 'legacy_void_evidence_remediation',
    'reason',
      'Restore attributable void metadata and exact existing reversal lineage without changing financial history.',
    'before', jsonb_build_object(
      'voidedAt', before_state.before_voided_at,
      'voidedBy', before_state.before_voided_by,
      'voidReason', before_state.before_void_reason,
      'reversalEntryId', before_state.before_reversal_entry_id
    ),
    'after', jsonb_build_object(
      'voidedAt', updated.voided_at,
      'voidedBy', updated.voided_by,
      'voidReason', updated.void_reason,
      'reversalEntryId', updated.reversal_entry_id
    ),
    'journalAmountsChanged', false,
    'journalAccountsChanged', false,
    'journalPeriodsChanged', false,
    'journalStatusesChanged', false,
    'migration',
      'generated/0109_schema_convergence_and_legacy_evidence.sql'
  ),
  before_state.evidence_actor_id,
  'legacy-void-evidence-remediation'
FROM before_state
JOIN updated
  ON updated.id = before_state.id
 AND updated.org_id = before_state.org_id;

ALTER TABLE documents
  VALIDATE CONSTRAINT documents_void_reason_required;

INSERT INTO _migration_control_exceptions (
  migration_filename,
  control_key,
  affected_rows,
  details
)
VALUES
  (
    'generated/0095_legacy_control_validation.sql',
    'documents_void_reason_required',
    0,
    jsonb_build_object(
      'remediatedBy',
        'generated/0109_schema_convergence_and_legacy_evidence.sql',
      'method',
        'existing audit evidence plus exact unique journal-reversal lineage',
      'financialHistoryChanged',
        false
    )
  ),
  (
    'generated/0109_schema_convergence_and_legacy_evidence.sql',
    'document_line_tax_components_document_line_id_fkey',
    0,
    jsonb_build_object(
      'archiveTable',
        'orphaned_tax_component_evidence',
      'method',
        'verbatim immutable archive before active-subledger cleanup',
      'financialHistoryChanged',
        false
    )
  )
ON CONFLICT (migration_filename, control_key) DO UPDATE
  SET affected_rows = excluded.affected_rows,
      detected_at = now(),
      details = excluded.details;
