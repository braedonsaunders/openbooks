-- OpenBooks forward migration 0006_recurring_occurrence_guard.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- A recurring tick claims its occurrence (advance next_run_on), then generates
-- the document inside its own transaction. The success bookkeeping (run_count,
-- last_document_id) runs after that commit — and when it failed transiently,
-- the catch restored the claimed next_run_on, so the next tick generated and
-- RE-POSTED a second invoice for the same occurrence. This table is the
-- per-occurrence dedupe guard: one row per (org, schedule, occurrence date),
-- inserted inside the generation transaction together with the document it
-- names. A retried tick finds the committed row and replays the existing
-- document instead of posting a duplicate; the unique index makes a double
-- insert impossible even under concurrency.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.recurring_occurrence_documents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    occurrence_on date NOT NULL,
    document_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.recurring_occurrence_documents FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recurring_occurrence_documents_pkey'
  ) THEN
    ALTER TABLE ONLY public.recurring_occurrence_documents
      ADD CONSTRAINT recurring_occurrence_documents_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_once
  ON public.recurring_occurrence_documents USING btree (org_id, schedule_id, occurrence_on);
CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_document
  ON public.recurring_occurrence_documents USING btree (document_id);
CREATE INDEX IF NOT EXISTS recurring_occurrence_schedule
  ON public.recurring_occurrence_documents USING btree (org_id, schedule_id, occurrence_on DESC);

-- Existing installations may already have rows from the original guard, whose
-- single-column foreign keys did not prove that the schedule and document
-- belonged to this occurrence's organization. Refuse the upgrade rather than
-- rewriting immutable financial lineage; the operator must reconcile the
-- source evidence before the ownership constraints can be installed.
DO $preflight$
DECLARE
  mismatch record;
BEGIN
  SELECT occurrence.id AS occurrence_id,
         occurrence.org_id,
         occurrence.schedule_id,
         schedule_row.org_id AS schedule_org_id,
         occurrence.document_id,
         document_row.org_id AS document_org_id
    INTO mismatch
    FROM public.recurring_occurrence_documents occurrence
    LEFT JOIN public.recurring_schedules schedule_row
      ON schedule_row.id = occurrence.schedule_id
    LEFT JOIN public.documents document_row
      ON document_row.id = occurrence.document_id
   WHERE schedule_row.org_id IS DISTINCT FROM occurrence.org_id
      OR document_row.org_id IS DISTINCT FROM occurrence.org_id
   ORDER BY occurrence.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy data violates tenant coherence: public.recurring_occurrence_documents',
      DETAIL = jsonb_build_object(
        'table', 'recurring_occurrence_documents',
        'row_id', mismatch.occurrence_id,
        'org_id', mismatch.org_id,
        'schedule_id', mismatch.schedule_id,
        'schedule_org_id', mismatch.schedule_org_id,
        'document_id', mismatch.document_id,
        'document_org_id', mismatch.document_org_id
      )::text,
      HINT = 'Reconcile the lineage row to schedule and document references owned by the same organization, then retry the upgrade. This migration will not rewrite financial history.';
  END IF;
END
$preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key.
-- The document key is present in the canonical baseline; both statements are
-- intentionally idempotent so this migration also repairs upgraded databases
-- that predate either key.
CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedules_org_id_id_unique
  ON public.recurring_schedules USING btree (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique
  ON public.documents USING btree (org_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'recurring_occurrence_org_fk'
  ) THEN
    ALTER TABLE ONLY public.recurring_occurrence_documents
      ADD CONSTRAINT recurring_occurrence_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

-- Replace the original global-id references with tenant-coherent equivalents.
-- NOT VALID keeps the DDL bounded while the explicit preflight above reports a
-- precise legacy row; VALIDATE below makes the constraint trusted thereafter.
ALTER TABLE public.recurring_occurrence_documents
  DROP CONSTRAINT IF EXISTS recurring_occurrence_schedule_fk,
  DROP CONSTRAINT IF EXISTS recurring_occurrence_document_fk;

ALTER TABLE public.recurring_occurrence_documents
  ADD CONSTRAINT recurring_occurrence_schedule_fk
  FOREIGN KEY (org_id, schedule_id)
  REFERENCES public.recurring_schedules(org_id, id)
  DEFERRABLE NOT VALID,
  ADD CONSTRAINT recurring_occurrence_document_fk
  FOREIGN KEY (org_id, document_id)
  REFERENCES public.documents(org_id, id)
  DEFERRABLE NOT VALID;

ALTER TABLE public.recurring_occurrence_documents
  VALIDATE CONSTRAINT recurring_occurrence_schedule_fk;
ALTER TABLE public.recurring_occurrence_documents
  VALIDATE CONSTRAINT recurring_occurrence_document_fk;

CREATE OR REPLACE FUNCTION public.recurring_occurrence_document_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'recurring occurrence lineage is immutable';
END $$;

-- The subscription period-invoice guard predates the wipe machinery actually
-- shipped: it reads app.sandbox_wipe, while every wipe path (sandbox
-- lifecycle, sim world, and the test fixtures) sets openbooks.sandbox_wipe.
-- Plain plan-based subscriptions now record their periods through this table,
-- so a wipe that must remain able to clear them accepts either GUC name.
CREATE OR REPLACE FUNCTION public.subscription_period_invoice_immutable_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('app.sandbox_wipe',true)='on'
     OR current_setting('openbooks.sandbox_wipe',true)='on' THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'subscription period invoice lineage is immutable';
END $$;

DROP TRIGGER IF EXISTS recurring_occurrence_document_immutable ON public.recurring_occurrence_documents;
CREATE TRIGGER recurring_occurrence_document_immutable
  BEFORE DELETE OR UPDATE ON public.recurring_occurrence_documents
  FOR EACH ROW EXECUTE FUNCTION public.recurring_occurrence_document_immutable_guard();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'recurring_occurrence_documents'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.recurring_occurrence_documents
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR ((org_id)::text = current_setting('app.current_org'::text, true))
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.recurring_occurrence_documents IS 'openbooks:org_isolation:v1';

ALTER TABLE public.recurring_occurrence_documents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.recurring_occurrence_documents IS
  'Per-occurrence dedupe guard for recurring generation. Inserted inside the generation transaction next to the cloned document; a retried or racing tick replays the named document instead of re-posting the occurrence. Composite tenant-scoped foreign keys keep schedule and document lineage inside one organization.';
