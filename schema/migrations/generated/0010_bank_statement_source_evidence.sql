-- OpenBooks forward migration 0010_bank_statement_source_evidence.
--
-- Statement imports now retain exact source bytes in append-only audit
-- evidence and store its stable pointer on bank_statements. The source bytes
-- of older rows cannot be reconstructed from parsed lines. Preserve those
-- statements and disclose that historical control gap in append-only audit
-- evidence instead of fabricating bytes or preventing a populated upgrade.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Keep the evidence backfill and constraint scan free of concurrent writes. Bootstrap
-- applies each reviewed migration inside one transaction, so the lock remains
-- held until the migration digest is recorded and committed.
LOCK TABLE public.bank_statements IN SHARE ROW EXCLUSIVE MODE;

-- Legacy import code deliberately stored raw_file_ref as null. Give each such
-- statement a truth-preserving, immutable evidence record: it says the source
-- was not retained; it does not invent source bytes or a SHA-256. The CTE makes
-- the audit insert and statement update one atomic database statement.
WITH legacy_statement AS MATERIALIZED (
  SELECT statement.id AS statement_id,
         statement.org_id,
         public.uuid_generate_v7() AS evidence_id
    FROM public.bank_statements statement
   WHERE statement.raw_file_ref IS NULL
   ORDER BY statement.id
),
legacy_evidence AS (
  INSERT INTO public.audit_log (
    id,
    org_id,
    table_name,
    row_id,
    action,
    changes,
    actor_id,
    request_id
  )
  SELECT legacy.evidence_id,
         legacy.org_id,
         'bank_statements',
         legacy.statement_id,
         'update',
         jsonb_build_object(
           'operation', 'bank_statement_source_evidence_migration',
           'rawFileRef', jsonb_build_object(
             'before', NULL::text,
             'after', format(
               'audit-log:%s#evidence=legacy-source-unavailable',
               legacy.evidence_id
             )
           ),
           'sourceEvidence', jsonb_build_object(
             'provenance', 'legacy_source_unavailable',
             'sourceAvailable', false,
             'reason', 'Exact source bytes were not retained by the importing release.',
             'migration', '0010_bank_statement_source_evidence'
           )
         ),
         NULL,
         'migration:0010_bank_statement_source_evidence'
    FROM legacy_statement legacy
  RETURNING id AS evidence_id, org_id, row_id AS statement_id
)
UPDATE public.bank_statements statement
   SET raw_file_ref = format(
         'audit-log:%s#evidence=legacy-source-unavailable',
         evidence.evidence_id
       )
  FROM legacy_evidence evidence
 WHERE statement.id = evidence.statement_id
   AND statement.org_id = evidence.org_id
   AND statement.raw_file_ref IS NULL;

-- Fail closed only if the atomic evidence attachment did not cover every
-- legacy row. The mere existence of an honest legacy-gap attestation is not a
-- deployment failure.
DO $bank_statement_source_evidence_verification$
DECLARE
  missing_statement_id uuid;
BEGIN
  SELECT id
    INTO missing_statement_id
    FROM public.bank_statements
   WHERE raw_file_ref IS NULL
   ORDER BY id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot finish bank statement source evidence migration: statement % still has no evidence reference',
      missing_statement_id
      USING
        ERRCODE = '23502',
        HINT = 'Inspect the legacy evidence insert and rerun the migration after correcting the database error.';
  END IF;
END
$bank_statement_source_evidence_verification$;

ALTER TABLE public.bank_statements
  ALTER COLUMN raw_file_ref SET NOT NULL;

COMMENT ON COLUMN public.bank_statements.raw_file_ref IS
  'Stable pointer to append-only source evidence: exact bytes for current imports, or an explicit legacy-source-unavailable attestation when an older release did not retain them.';
