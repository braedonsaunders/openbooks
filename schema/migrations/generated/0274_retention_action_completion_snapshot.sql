-- OpenBooks forward migration 0274_retention_action_completion_snapshot.
--
-- applyCompletionRetention froze retain_until and the governing schedule id
-- on the document at completion — but NOT the action. The daily tick then
-- copied the schedule's CURRENT action into each new retention_actions row,
-- so editing a schedule's action (anonymize → delete) after documents had
-- completed silently re-governed those historical documents under a rule
-- they were never completed under: past-due anonymize documents were
-- deleted. A completion-time promise ("this category anonymizes") must not
-- be rewritable after the fact.
--
-- This freezes the governing action in the completion snapshot itself: a new
-- hrm_documents.retention_action column, written once alongside retain_until
-- at completion, which the tick copies into each action row instead of the
-- schedule's live value. Later schedule edits govern only documents that
-- complete AFTER the edit — historical documents keep the action they were
-- completed under. retain_until was already frozen; from_event and
-- retain_years only feed that frozen date, so the action was the one live
-- governing parameter left.
--
-- Backfill: every document already carrying a retention_rule_id inherits
-- that schedule's current action — the only action those rows could ever
-- have executed under, so the freeze changes nothing already decided.
--
-- Re-runnable: column and constraint adds are IF NOT EXISTS-guarded and the
-- backfill only touches rows still missing the snapshot.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.hrm_documents
  ADD COLUMN IF NOT EXISTS retention_action text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_documents_retention_action') THEN
    ALTER TABLE public.hrm_documents
      ADD CONSTRAINT hrm_documents_retention_action CHECK (
        retention_action IS NULL OR retention_action IN ('delete', 'anonymize')
      );
  END IF;
END $$;

UPDATE public.hrm_documents d
   SET retention_action = s.action
  FROM public.hrm_retention_schedules s
 WHERE d.retention_rule_id = s.id
   AND d.retention_action IS NULL
   AND d.retention_rule_id IS NOT NULL;
