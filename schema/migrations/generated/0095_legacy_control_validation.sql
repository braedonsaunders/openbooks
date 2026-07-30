BEGIN;

CREATE TABLE IF NOT EXISTS _migration_control_exceptions (
  migration_filename text NOT NULL,
  control_key text NOT NULL,
  affected_rows bigint NOT NULL CHECK (affected_rows >= 0),
  detected_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (migration_filename, control_key)
);

ALTER TABLE documents
  VALIDATE CONSTRAINT documents_void_request_evidence;
ALTER TABLE customer_roles
  VALIDATE CONSTRAINT customer_roles_hold_evidence;
ALTER TABLE vendor_roles
  VALIDATE CONSTRAINT vendor_roles_hold_evidence;
ALTER TABLE party_bank_accounts
  VALIDATE CONSTRAINT party_bank_accounts_retirement_evidence;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM documents
     WHERE NOT (
       status <> 'voided'
       OR (
         voided_at IS NOT NULL
         AND voided_by IS NOT NULL
         AND void_reason IS NOT NULL
         AND length(btrim(void_reason)) BETWEEN 5 AND 500
         AND (posted_entry_id IS NULL OR reversal_entry_id IS NOT NULL)
       )
     )
  ) THEN
    ALTER TABLE documents
      VALIDATE CONSTRAINT documents_void_reason_required;
  END IF;
END
$$;

INSERT INTO _migration_control_exceptions (
  migration_filename,
  control_key,
  affected_rows,
  details
)
SELECT
  'generated/0095_legacy_control_validation.sql',
  'documents_void_reason_required',
  count(*),
  jsonb_build_object(
    'reason', 'historical void predates mandatory actor, reason, timestamp, or document-to-reversal lineage',
    'enforcement', 'NOT VALID check constraint rejects every new or changed noncompliant void',
    'remediation', 'an authorized administrator must attest the historical actor and reason; exact existing reversal lineage may then be linked without rewriting GL history'
  )
FROM documents
WHERE NOT (
  status <> 'voided'
  OR (
    voided_at IS NOT NULL
    AND voided_by IS NOT NULL
    AND void_reason IS NOT NULL
    AND length(btrim(void_reason)) BETWEEN 5 AND 500
    AND (posted_entry_id IS NULL OR reversal_entry_id IS NOT NULL)
  )
)
ON CONFLICT (migration_filename, control_key) DO UPDATE
  SET affected_rows = excluded.affected_rows,
      detected_at = now(),
      details = excluded.details;

COMMIT;
