-- OpenBooks forward migration 0394_payment_run_nacha_modifier.
--
-- The NACHA File Header carries a one-character File ID Modifier, and the
-- bank keys same-day duplicate-file detection on (origin, creation date,
-- modifier). The modifier used to derive from the run number mod 36, so two
-- runs generated the same day could share a letter (run numbers advance
-- across every payment method, not per NACHA file) and past 36 files the
-- alphabet wrapped with no refusal — a legitimate file rejected as a
-- duplicate, or two distinct files sharing one bank identity. The modifier
-- is now allocated per bank profile per creation day (lowest free letter,
-- pinned on the run) and generation refuses when all 36 are in use.
--
-- Backfill: none. Null means "allocated before this migration" — readers
-- fall back to the legacy run-number derivation for those rows, and the
-- next generation pins a real letter.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payment_runs
  ADD COLUMN IF NOT EXISTS file_id_modifier text;

DO $$
BEGIN
  IF NOT EXISTS (select 1 from pg_constraint where conname = 'payment_runs_file_id_modifier_shape') THEN
    ALTER TABLE public.payment_runs
      ADD CONSTRAINT payment_runs_file_id_modifier_shape
      CHECK (file_id_modifier IS NULL OR file_id_modifier ~ '^[A-Z0-9]$');
  END IF;
END $$;

COMMENT ON COLUMN public.payment_runs.file_id_modifier IS
  'NACHA File ID Modifier (single character A-Z, 0-9) allocated for this run''s bank file (0394). Pinned once per bank profile per creation day (lowest free letter) so two files generated the same day never share the bank''s same-day duplicate-file identity; null means allocated before this migration and readers fall back to the legacy run-number derivation.';
