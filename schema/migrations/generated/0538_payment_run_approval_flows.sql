-- OpenBooks forward migration 0538_payment_run_approval_flows.
-- Payment-run approval is owned by Flows: a submitted run waits for approval
-- only when an enabled payment-run flow raises a gate, and is approved on
-- submit otherwise. The per-profile run and file approval switches are
-- retired, and a generated file is deliverable as generated because it
-- renders a run its approval already released.
--
-- Work caught mid-approval is moved to a state the operator can act on, with
-- an event recording why: a run awaiting approval returns to draft (submitting
-- it again routes it through Flows), and a file awaiting approval is rejected
-- (reprocessing it generates a deliverable replacement).
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

WITH returned AS (
  UPDATE public.payment_runs
     SET status = 'draft',
         submitted_at = NULL,
         submitted_by = NULL,
         updated_at = now()
   WHERE status = 'pending_approval'
  RETURNING id, org_id
)
INSERT INTO public.payment_events (org_id, payment_run_id, event_type, from_status, to_status, details)
SELECT org_id, id, 'run_returned_to_draft', 'pending_approval', 'draft',
       jsonb_build_object('reason', 'Payment-run approval now runs through Flows; submit the run again to route it.')
  FROM returned;

WITH rejected AS (
  UPDATE public.payment_files
     SET status = 'rejected',
         rejected_at = now(),
         rejection_reason = 'Separate file approval was retired; reprocess the file to generate a deliverable replacement.',
         updated_at = now()
   WHERE status = 'pending_approval'
  RETURNING id, org_id, payment_run_id
)
INSERT INTO public.payment_events (org_id, payment_run_id, payment_file_id, event_type, from_status, to_status, details)
SELECT org_id, payment_run_id, id, 'file_rejected', 'pending_approval', 'rejected',
       jsonb_build_object('reason', 'Separate file approval was retired; reprocess the file to generate a deliverable replacement.')
  FROM rejected;

ALTER TABLE public.payment_bank_profiles
  DROP COLUMN IF EXISTS require_run_approval,
  DROP COLUMN IF EXISTS require_file_approval;
