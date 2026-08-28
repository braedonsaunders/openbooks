-- OpenBooks forward migration 0075_payroll_bank_file_release_status_evidence.
--
-- A payroll bank file is a money-moving instruction.  Its lifecycle status
-- must tell the same story as its release evidence:
--
--   generated  = no release has happened (zero count and no timestamps)
--   released   = at least one release is evidenced (positive count and both
--                timestamps)
--   superseded = the replacement chain is evidenced separately; the old file
--                may have been released before or after supersession, so it
--                permits either complete release state.
--
-- The baseline release check only coupled the count and timestamps.  It thus
-- admitted a released row with no evidence and a generated row whose bytes had
-- already left the building.  This migration refuses to guess at the meaning
-- of any legacy row: a violating row is reported and rollout aborts before the
-- old constraint is replaced.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $pay_run_bank_file_release_status_preflight$
DECLARE
  violation record;
BEGIN
  SELECT f.id AS row_id,
         f.org_id,
         f.status,
         f.release_count,
         f.first_released_at,
         f.last_released_at
    INTO violation
    FROM public.pay_run_bank_files f
   WHERE NOT (
     (f.status IN ('generated', 'superseded')
       AND f.release_count = 0
       AND f.first_released_at IS NULL
       AND f.last_released_at IS NULL)
     OR (f.status IN ('released', 'superseded')
       AND f.release_count > 0
       AND f.first_released_at IS NOT NULL
       AND f.last_released_at IS NOT NULL)
   )
   ORDER BY f.org_id, f.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy payroll bank-file row violates release status/evidence invariant',
      DETAIL = jsonb_build_object(
        'row_id', violation.row_id,
        'org_id', violation.org_id,
        'status', violation.status,
        'release_count', violation.release_count,
        'first_released_at', violation.first_released_at,
        'last_released_at', violation.last_released_at
      )::text,
      HINT = 'Review the identified payroll bank-file lifecycle and record an approved correction, then retry migration 0075. This migration never rewrites release history.';
  END IF;
END
$pay_run_bank_file_release_status_preflight$;

-- The baseline constraint has the same name but a weaker predicate.  Drop and
-- recreate it in this transaction so replaying the reviewed migration is safe
-- and no external writer can observe an enforcement gap.
ALTER TABLE public.pay_run_bank_files
  DROP CONSTRAINT IF EXISTS pay_run_bank_files_release_evidence;

ALTER TABLE public.pay_run_bank_files
  ADD CONSTRAINT pay_run_bank_files_release_evidence
  CHECK (
    (status IN ('generated', 'superseded')
      AND release_count = 0
      AND first_released_at IS NULL
      AND last_released_at IS NULL)
    OR (status IN ('released', 'superseded')
      AND release_count > 0
      AND first_released_at IS NOT NULL
      AND last_released_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE public.pay_run_bank_files
  VALIDATE CONSTRAINT pay_run_bank_files_release_evidence;

COMMENT ON CONSTRAINT pay_run_bank_files_release_evidence
  ON public.pay_run_bank_files IS
  'openbooks:payroll_bank_file_release_status_evidence:v1 - generated files have no release evidence, released files have positive counted evidence, and superseded files retain either complete state';
