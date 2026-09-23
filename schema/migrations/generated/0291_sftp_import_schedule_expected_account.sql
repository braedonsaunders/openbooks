-- OpenBooks forward migration 0291_sftp_import_schedule_expected_account.
--
-- Scheduled SFTP bank imports dropped every watch-folder file into the
-- schedule's account without comparing the file's own account identity: a
-- same-currency statement for account B landing in account A's folder
-- silently became A's lines and balance evidence. The parsers now carry
-- the file's external account identifier (OFX ACCTID, BAI2 account
-- record, MT940 :25:, CAMT.053 account IBAN/Id; CSV has none), and each
-- import schedule binds the one identifier it accepts. A mismatch refuses
-- by name; a file carrying identity with no binding configured refuses
-- too, naming the schedule setting as the remedy — an unconfigured
-- schedule must pause with a clear error, never silently misattribute.
-- CSV has no identifier and relies on watch-folder isolation (kept sound
-- by non-overlapping server roots). Nullable with no backfill: existing
-- schedules bind their identifier on first touch instead of guessing.
-- Re-runnable: every statement is guarded by IF NOT EXISTS.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE ONLY public.sftp_import_schedules
  ADD COLUMN IF NOT EXISTS expected_external_account_id text;
