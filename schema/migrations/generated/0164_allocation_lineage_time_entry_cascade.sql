-- OpenBooks forward migration 0164_allocation_lineage_time_entry_cascade.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- 0163 added allocation_lineage.source_time_entry_id with a composite tenant
-- FK to time_entries but no delete behavior, so deleting a time entry fails
-- 23503 once lineage rows reference it (the project-posting-concurrency
-- teardown deletes time entries directly). The sibling lineage anchors
-- already cascade (allocation_lineage_run_id_fkey and
-- allocation_lineage_document_id_fkey are both ON DELETE CASCADE): evidence
-- follows its anchor. This migration re-adds the 0163 FK with ON DELETE
-- CASCADE, dropping the exact 0163 constraint first. No posted history is
-- reinterpreted: only the delete behavior of future time-entry deletes
-- changes, matching the run/document anchors.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'allocation_lineage_time_entry_id_fkey'
       AND pg_get_constraintdef(oid) NOT LIKE '%ON DELETE CASCADE%'
  ) THEN
    ALTER TABLE public.allocation_lineage DROP CONSTRAINT allocation_lineage_time_entry_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_time_entry_id_fkey'
  ) THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_time_entry_id_fkey
      FOREIGN KEY (org_id, source_time_entry_id) REFERENCES public.time_entries(org_id, id) ON DELETE CASCADE;
  END IF;
END $$;
