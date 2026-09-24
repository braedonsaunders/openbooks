-- OpenBooks forward migration 0349_sftp_import_schedule_run_claim.
-- Persist the active SFTP scan identity so interrupted claims remain visible and recoverable.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.sftp_import_schedules
  ADD COLUMN run_claim_token uuid,
  ADD COLUMN run_claimed_at timestamp with time zone;

ALTER TABLE ONLY public.sftp_import_schedules
  ADD CONSTRAINT sftp_import_schedules_run_claim_pair
  CHECK ((run_claim_token IS NULL) = (run_claimed_at IS NULL));
