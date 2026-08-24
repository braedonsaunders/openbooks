-- OpenBooks forward migration 0010_bank_statement_source_evidence.
--
-- Statement imports now retain exact source bytes in append-only audit
-- evidence and store its stable pointer on bank_statements. The source bytes
-- of older rows cannot be reconstructed from parsed lines, so this migration
-- fails closed when a legacy row still lacks evidence instead of fabricating
-- a reference that would misrepresent the audit trail.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Keep the preflight and constraint scan free of concurrent writes. Bootstrap
-- applies each reviewed migration inside one transaction, so the lock remains
-- held until the migration digest is recorded and committed.
LOCK TABLE public.bank_statements IN SHARE ROW EXCLUSIVE MODE;

DO $bank_statement_source_evidence_preflight$
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
      'cannot require bank statement source evidence: statement % has no raw_file_ref',
      missing_statement_id
      USING
        ERRCODE = '23502',
        HINT = 'Recover the exact source bytes, retain them as append-only audit evidence, and set raw_file_ref before rerunning this migration.';
  END IF;
END
$bank_statement_source_evidence_preflight$;

ALTER TABLE public.bank_statements
  ALTER COLUMN raw_file_ref SET NOT NULL;

COMMENT ON COLUMN public.bank_statements.raw_file_ref IS
  'Stable pointer to append-only evidence containing the exact statement source bytes.';
