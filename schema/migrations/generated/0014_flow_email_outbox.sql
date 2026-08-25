-- OpenBooks forward migration 0014_flow_email_outbox.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Flow emails used to be handed straight to the Redis queue at execution
-- time. When a flow runs inside a caller's transaction (document void
-- reservation, posting commands), a later ROLLBACK discarded the flow_run,
-- effect claims, and gates while Redis kept the email — recipients saw mail
-- for mutations that never committed, and a retry could enqueue it again.
-- flow_email rows carry the rendered delivery in `payload` and are written
-- through the caller's own transaction, so rollback removes them with the
-- rest of the flow's effects; commit leaves them for the scheduler-outbox
-- worker to deliver with claim/fencing/retry semantics.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.scheduler_outbox ADD COLUMN IF NOT EXISTS payload jsonb;

COMMENT ON COLUMN public.scheduler_outbox.payload IS
  'Rendered email delivery for flow_email rows: to/subject/html/text plus optional attachments and meta. Written inside the flow caller''s transaction so a rollback discards the send; null for every other kind.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_kind'
       AND pg_get_constraintdef(oid) NOT LIKE '%flow_email%'
  ) THEN
    ALTER TABLE public.scheduler_outbox DROP CONSTRAINT scheduler_outbox_kind;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_kind'
  ) THEN
    ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_kind
      CHECK ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text, 'approval_escalation'::text, 'flow_email'::text])));
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_scope'
       AND pg_get_constraintdef(oid) NOT LIKE '%flow_email%'
  ) THEN
    ALTER TABLE public.scheduler_outbox DROP CONSTRAINT scheduler_outbox_scope;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scheduler_outbox_scope'
  ) THEN
    ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_scope CHECK ((
      ((kind = 'approval_escalation') AND (org_id IS NOT NULL) AND (subject_id IS NOT NULL))
      OR
      ((kind = ANY (ARRAY['dunning'::text, 'subscription_billing'::text, 'property_billing'::text, 'fx_providers'::text])) AND (org_id IS NULL) AND (subject_id IS NULL))
      OR
      ((kind = 'flow_email') AND (org_id IS NOT NULL) AND (subject_id IS NOT NULL) AND (payload IS NOT NULL))
    ));
  END IF;
END
$$;
