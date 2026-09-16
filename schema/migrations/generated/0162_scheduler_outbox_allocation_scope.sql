-- OpenBooks forward migration 0162_scheduler_outbox_allocation_scope.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Migration 0160 added 'allocation_run' to the scheduler_outbox_kind check
-- but not to scheduler_outbox_scope, so every allocation occurrence insert
-- failed the scope check ("scheduler_outbox_scope" violation): the
-- constraint only knew the approval_escalation branch, the four scan kinds,
-- and flow_email. This migration adds the allocation_run branch in the
-- flow_email shape — an occurrence always carries its org, its rule as the
-- subject, and the rule/version/period/book payload — dropping and
-- re-adding the constraint idempotently exactly like 0014 did. No posted
-- history is reinterpreted: no allocation_run row could have existed before
-- this branch, so nothing is grandfathered.

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
     WHERE conname = 'scheduler_outbox_scope'
       AND pg_get_constraintdef(oid) NOT LIKE '%allocation_run%'
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
      OR
      ((kind = 'allocation_run') AND (org_id IS NOT NULL) AND (subject_id IS NOT NULL) AND (payload IS NOT NULL))
    ));
  END IF;
END $$;
