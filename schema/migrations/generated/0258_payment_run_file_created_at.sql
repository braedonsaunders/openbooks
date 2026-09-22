-- OpenBooks forward migration 0258_payment_run_file_created_at.
--
-- AP bank files (NACHA, CPA-005, SEPA) stamp a creation date/time in the
-- header, and the bank keys duplicate-file detection on that header. The
-- file bytes are generated on demand, so stamping wall-clock time at render
-- means every re-download produces a different header: an accidental
-- re-upload of the SAME run then looks like a NEW file and pays every
-- vendor twice. Stamping the run once — the instant its first file is
-- created — and reusing that instant on every later render makes
-- re-downloads byte-identical, so the bank rejects the re-upload instead.
--
-- Backfill: none. Existing runs stamp on their next generation (the writer
-- coalesces), and already-downloaded artifacts keep serving their stored
-- bytes, which the artifact dedupe returns verbatim.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payment_runs
  ADD COLUMN IF NOT EXISTS file_created_at timestamp with time zone;

COMMENT ON COLUMN public.payment_runs.file_created_at IS
  'Instant the run''s first bank file was created (0258). Stamped once via coalesce on first generation and reused by every later render, so re-downloads reproduce byte-identical files and the bank''s duplicate-file detection still recognizes an accidental re-upload of the same run.';
