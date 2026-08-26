-- OpenBooks forward migration 0049_payment_schedule_occurrence_durability.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- The payment scheduler used to advance payment_schedules.next_run_at BEFORE
-- creating the run, then create and submit the run in separate transactions.
-- A crash after that cursor advance but before createPaymentRun permanently
-- skipped the due occurrence; a failure after creation committed an orphan
-- draft with no last_payment_run_id link and no resume path; and
-- source_schedule_id identified only the schedule, never the occurrence, so
-- nothing made a retried tick idempotent.
--
-- This table is the per-occurrence ledger that fixes all three: one row per
-- (org, schedule, occurrence fire time), inserted inside the run-creation
-- transaction next to the run it names (the claim, the run, its payments, and
-- its instructions commit atomically), linked to the created run, and carrying
-- the submission lifecycle so a failed or crashed submission resumes the SAME
-- linked run instead of creating a duplicate. The unique index makes a double
-- claim impossible even under concurrent ticks: the loser adopts the winner's
-- run through the same occurrence key.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.payment_schedule_occurrences (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    occurrence_at timestamp with time zone NOT NULL,
    payment_run_id uuid,
    status text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

ALTER TABLE ONLY public.payment_schedule_occurrences FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_schedule_occurrences_pkey'
  ) THEN
    ALTER TABLE ONLY public.payment_schedule_occurrences
      ADD CONSTRAINT payment_schedule_occurrences_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_schedule_occurrences_once
  ON public.payment_schedule_occurrences USING btree (org_id, schedule_id, occurrence_at);
CREATE INDEX IF NOT EXISTS payment_schedule_occurrences_pending
  ON public.payment_schedule_occurrences USING btree (status, occurrence_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_schedule_occurrence_org_fk'
  ) THEN
    ALTER TABLE ONLY public.payment_schedule_occurrences
      ADD CONSTRAINT payment_schedule_occurrence_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_schedule_occurrence_schedule_fk'
  ) THEN
    ALTER TABLE ONLY public.payment_schedule_occurrences
      ADD CONSTRAINT payment_schedule_occurrence_schedule_fk
      FOREIGN KEY (schedule_id) REFERENCES public.payment_schedules(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'payment_schedule_occurrence_run_fk'
  ) THEN
    ALTER TABLE ONLY public.payment_schedule_occurrences
      ADD CONSTRAINT payment_schedule_occurrence_run_fk
      FOREIGN KEY (payment_run_id) REFERENCES public.payment_runs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'payment_schedule_occurrences'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.payment_schedule_occurrences
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

COMMENT ON POLICY org_isolation ON public.payment_schedule_occurrences IS 'openbooks:org_isolation:v1';

ALTER TABLE public.payment_schedule_occurrences ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.payment_schedule_occurrences IS
  'Per-occurrence durability ledger for scheduled payment runs. Claimed inside the run-creation transaction; a retried or concurrent tick resolves the same occurrence key to the same run, and submission state is recoverable from this row.';
