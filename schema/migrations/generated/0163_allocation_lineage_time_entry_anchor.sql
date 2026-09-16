-- OpenBooks forward migration 0163_allocation_lineage_time_entry_anchor.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The overhead net-zero pair (engine/src/overhead-apply.ts) folds into the
-- allocation kernel as a system-owned post rule bound to the time-approval
-- event. Its lineage rows have no allocation run and no document — the
-- trigger is an approved time entry — so the 0160 anchor check
-- (run_id OR document_id) refuses them. This migration adds
-- allocation_lineage.source_time_entry_id (composite tenant FK to
-- time_entries(org_id, id), which exposes that unique key) plus a partial
-- index for the entry-anchored drill, and widens the anchor check to accept
-- a time-entry-anchored row. Entry, post and period rows are unaffected: a
-- row anchored the old way still satisfies the new check, and no existing
-- row carries the new column, so no posted history is reinterpreted.
--
-- The 0161 governed view over allocation_lineage is SELECT *, so the new
-- column flows to openbooks_read with no view change.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'allocation_lineage'
       AND column_name = 'source_time_entry_id'
  ) THEN
    ALTER TABLE public.allocation_lineage ADD COLUMN source_time_entry_id uuid;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS allocation_lineage_time_entry
  ON public.allocation_lineage USING btree (org_id, source_time_entry_id)
  WHERE source_time_entry_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_time_entry_id_fkey') THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_time_entry_id_fkey
      FOREIGN KEY (org_id, source_time_entry_id) REFERENCES public.time_entries(org_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'allocation_lineage_anchor'
       AND pg_get_constraintdef(oid) NOT LIKE '%source_time_entry_id%'
  ) THEN
    ALTER TABLE public.allocation_lineage DROP CONSTRAINT allocation_lineage_anchor;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'allocation_lineage_anchor'
  ) THEN
    ALTER TABLE public.allocation_lineage ADD CONSTRAINT allocation_lineage_anchor
      CHECK (((run_id IS NOT NULL) OR (document_id IS NOT NULL) OR (source_time_entry_id IS NOT NULL)));
  END IF;
END $$;

-- The 0161 governed view is SELECT *: Postgres freezes the column list at
-- CREATE time, so the new column only reaches openbooks_read after a
-- re-create. Same DROP + CREATE + GRANT shape as 0161 (never OR REPLACE,
-- which refuses column-list changes against a differing view).
DROP VIEW IF EXISTS openbooks_query.allocation_lineage;
CREATE VIEW openbooks_query.allocation_lineage WITH (security_barrier='true') AS
 SELECT * FROM public.allocation_lineage
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.allocation_lineage TO openbooks_read;
