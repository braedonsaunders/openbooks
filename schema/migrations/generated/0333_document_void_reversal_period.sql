-- OpenBooks forward migration 0333_document_void_reversal_period.
--
-- Void reversals could never land in an adjustment period by date
-- (resolveCoveringPeriod is regular-only), while document-void.ts promised an
-- explicit document override that had no field and could not be executed.
-- documents gains a nullable adjustment-period pointer: the void request
-- stores the named override and completion posts the reversal journals into
-- it. Null (the only value existing rows carry) keeps today's behaviour —
-- the reversal resolves by date in the regular covering period.
--
-- Staged build: the nullable column with no default is metadata-only on the
-- hot documents table, and the foreign key arrives NOT VALID with a separate
-- guarded VALIDATE (0301 pattern), so no scan holds the table lock. Every
-- statement is replay-safe: ADD COLUMN IF NOT EXISTS, the ADD CONSTRAINT is
-- guarded on pg_constraint, and the VALIDATE runs only while unvalidated.
-- No statement needs CONCURRENTLY, so the file stays inside the tracked
-- transaction.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS void_reversal_period_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.documents'::regclass
       AND conname = 'documents_void_reversal_period_id_fkey'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_void_reversal_period_id_fkey
      FOREIGN KEY (void_reversal_period_id) REFERENCES public.accounting_periods (id)
      NOT VALID;
  END IF;
END
$$;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.documents'::regclass
       AND conname = 'documents_void_reversal_period_id_fkey'
       AND NOT convalidated
  ) THEN
    ALTER TABLE public.documents
      VALIDATE CONSTRAINT documents_void_reversal_period_id_fkey;
  END IF;
END
$$;
