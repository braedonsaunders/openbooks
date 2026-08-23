-- OpenBooks forward migration 0004_scheduler_outbox.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Scheduler ticks and approval-escalation timers used to log-and-drop. This
-- table is the durable outbox: claim a row, run the work, mark failed with a
-- reason, retry with backoff, and leave terminal `failed` rows for operators.
-- Redis/BullMQ may rebuild from these rows; they are not the source of truth.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.scheduler_outbox (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid,
    kind text NOT NULL,
    subject_id uuid,
    occurrence_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    finished_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT scheduler_outbox_kind CHECK ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text, 'approval_escalation'::text]))),
    CONSTRAINT scheduler_outbox_status CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT scheduler_outbox_nonnegative_attempts CHECK ((attempt_count >= 0)),
    CONSTRAINT scheduler_outbox_scope CHECK ((
      ((kind = 'approval_escalation') AND (org_id IS NOT NULL) AND (subject_id IS NOT NULL))
      OR
      ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text])) AND (org_id IS NULL) AND (subject_id IS NULL))
    ))
);

ALTER TABLE ONLY public.scheduler_outbox FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_pkey'
  ) THEN
    ALTER TABLE ONLY public.scheduler_outbox
      ADD CONSTRAINT scheduler_outbox_pkey PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS scheduler_outbox_occurrence
  ON public.scheduler_outbox USING btree (kind, occurrence_key);
CREATE INDEX IF NOT EXISTS scheduler_outbox_due
  ON public.scheduler_outbox USING btree (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS scheduler_outbox_org
  ON public.scheduler_outbox USING btree (org_id, status, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_org_fk'
  ) THEN
    ALTER TABLE ONLY public.scheduler_outbox
      ADD CONSTRAINT scheduler_outbox_org_fk
      FOREIGN KEY (org_id) REFERENCES public.orgs(id) DEFERRABLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'scheduler_outbox'
       AND policyname = 'org_isolation'
  ) THEN
    CREATE POLICY org_isolation ON public.scheduler_outbox
      USING (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR (
          (org_id IS NOT NULL)
          AND ((org_id)::text = current_setting('app.current_org'::text, true))
        )
      )
      WITH CHECK (
        (current_setting('app.bypass_rls'::text, true) = 'on'::text)
        OR (
          (org_id IS NOT NULL)
          AND ((org_id)::text = current_setting('app.current_org'::text, true))
        )
      );
  END IF;
END
$$;

COMMENT ON POLICY org_isolation ON public.scheduler_outbox IS 'openbooks:org_isolation:v1';

ALTER TABLE public.scheduler_outbox ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.scheduler_outbox IS
  'Durable scheduler and approval-escalation outbox. Claim, run, fail with reason, retry with backoff; terminal failed rows stay visible to operators.';
