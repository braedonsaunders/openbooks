-- OpenBooks forward migration 0273_dsar_export_incomplete_status.
--
-- A DSAR export whose document files had no retrievable bytes (the
-- files/file_versions/file_blobs join finds nothing — purged, orphaned, or
-- never stored) silently skipped those files, kept the documents module
-- 'included', and marked the export 'ready': the requester received a zip
-- presented as their complete record with files missing and no trace of the
-- omission. Completeness is a legal property of a subject-access export, so
-- a silent partial success is a refusal-shaped defect — it must read as
-- partial, not as whole.
--
-- This widens the export status check with 'incomplete': the build marks an
-- export incomplete (never ready) when any requested document's bytes were
-- unavailable, names each omitted document with its reason in the scope
-- manifest and in export.json, and the download surface keeps serving the
-- partial zip while showing the incomplete status. No backfill: no existing
-- row can hold a status the old check forbade.
--
-- Re-runnable: the constraint is dropped and re-added idempotently, so a
-- second run changes nothing.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Full set restated (0267 added 'building'; this adds 'incomplete') so the
-- constraint reads standalone on any tree that has both migrations.
ALTER TABLE public.hrm_data_subject_exports DROP CONSTRAINT IF EXISTS hrm_data_subject_exports_status;
ALTER TABLE public.hrm_data_subject_exports
  ADD CONSTRAINT hrm_data_subject_exports_status CHECK (
    status IN ('queued', 'building', 'ready', 'incomplete', 'delivered', 'failed')
  );
