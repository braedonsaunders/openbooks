-- Persist payroll linkage when an approved benefit award queues, then keep
-- it immutable through delivery. Editable-run voiding clears linkage and
-- removes its native adjustment in one transaction; finalized history stays
-- terminal. This replaces the guard without rewriting any existing award.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_snapshot_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.program_snapshot IS DISTINCT FROM OLD.program_snapshot
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.period_from IS DISTINCT FROM OLD.period_from
     OR NEW.period_to IS DISTINCT FROM OLD.period_to
     OR NEW.value IS DISTINCT FROM OLD.value
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source_key IS DISTINCT FROM OLD.source_key
     OR NEW.adjusts_award_id IS DISTINCT FROM OLD.adjusts_award_id THEN
    IF OLD.status = 'delivered' THEN
      RAISE EXCEPTION
        'HRM benefit award % is delivered history — issue an adjusting award instead of rewriting it.', OLD.id;
    END IF;
    RAISE EXCEPTION
      'HRM benefit award % carries immutable program and source snapshots — void it and issue a new award instead of rewriting it.', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'queued', 'delivered', 'voided')
     AND NEW.evidence IS DISTINCT FROM OLD.evidence THEN
    RAISE EXCEPTION
      'HRM benefit award % evidence froze at approval — void it and issue a new award instead of rewriting the proof.', OLD.id;
  END IF;
  IF OLD.status = 'delivered' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Benefit award % is delivered history — record an adjusting award instead of changing its status.', OLD.id;
  END IF;
  IF OLD.status = 'voided' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Benefit award % is voided history — issue a new award with a new source reference instead of changing its status.', OLD.id;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Benefit award % creation evidence is immutable — preserve its recorded author and time.', OLD.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending', 'voided')) OR
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'voided')) OR
    (OLD.status = 'approved' AND NEW.status IN ('queued', 'voided')) OR
    (OLD.status = 'queued' AND NEW.status IN ('delivered', 'voided'))
  ) THEN
    RAISE EXCEPTION 'Benefit award % has an invalid lifecycle move — use submission, independent approval, payout and delivery in order.', OLD.id;
  END IF;
  IF OLD.status IN ('approved', 'queued', 'delivered', 'voided')
     AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'Benefit award % approval evidence is immutable — preserve its recorded approver and time.', OLD.id;
  END IF;
  IF NEW.status = 'approved' AND OLD.status = 'pending'
     AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL OR NEW.approved_by = NEW.created_by) THEN
    RAISE EXCEPTION 'Benefit award % requires an independent approver — ask a second manager to approve.', OLD.id;
  END IF;
  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref
     AND NOT (OLD.status = 'queued' AND NEW.status = 'delivered') THEN
    RAISE EXCEPTION 'Benefit award % external reference writes only at delivery — record provider fulfillment through the award service.', OLD.id;
  END IF;
  IF NEW.pay_run_document_id IS DISTINCT FROM OLD.pay_run_document_id
     OR NEW.pay_run_adjustment_id IS DISTINCT FROM OLD.pay_run_adjustment_id THEN
    IF NOT (
      (OLD.status = 'approved' AND NEW.status = 'queued'
       AND OLD.pay_run_document_id IS NULL AND OLD.pay_run_adjustment_id IS NULL
       AND NEW.pay_run_document_id IS NOT NULL AND NEW.pay_run_adjustment_id IS NOT NULL) OR
      (OLD.status = 'queued' AND NEW.status = 'voided'
       AND NEW.pay_run_document_id IS NULL AND NEW.pay_run_adjustment_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Benefit award % payroll linkage is immutable after queueing — use the recorded adjustment or void it through its editable pay run.', OLD.id;
    END IF;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'queued'
     AND (SELECT delivery_method = 'payroll' FROM public.hrm_benefit_programs WHERE org_id = NEW.org_id AND id = NEW.program_id) THEN
    IF NEW.pay_run_document_id IS NULL OR NEW.pay_run_adjustment_id IS NULL THEN
      RAISE EXCEPTION 'Benefit award % requires a native payroll adjustment — select an editable pay run before queueing.', OLD.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_run_adjustments a
      JOIN public.pay_runs r ON r.org_id = a.org_id AND r.document_id = a.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      JOIN public.worker_employments e ON e.org_id = NEW.org_id AND e.id = NEW.employment_id
      JOIN public.hrm_benefit_programs p ON p.org_id = NEW.org_id AND p.id = NEW.program_id
      WHERE a.org_id = NEW.org_id AND a.id = NEW.pay_run_adjustment_id
        AND a.pay_run_document_id = NEW.pay_run_document_id
        AND a.employee_party_id = e.worker_party_id AND a.component_id = p.pay_component_id
        AND a.adjustment_type = 'line' AND NOT a.replace_component AND a.amount = NEW.value
        AND a.note = 'Benefit award ' || NEW.id::text || ' (' || p.code || ' ' || NEW.period_from::text || '..' || coalesce(NEW.period_to::text, 'open') || ')'
        AND d.status = 'draft' AND r.run_status <> 'committed'
        AND d.subsidiary_id = p.legal_entity_id AND d.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION 'Benefit award % does not match an editable native payroll adjustment — queue it through its pay-run action.', OLD.id;
    END IF;
  END IF;
  IF OLD.status = 'queued' AND NEW.status = 'voided' AND OLD.pay_run_document_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_runs r JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
       WHERE r.org_id = OLD.org_id AND r.document_id = OLD.pay_run_document_id
         AND r.run_status <> 'committed' AND d.status = 'draft'
    ) THEN
      RAISE EXCEPTION 'Benefit award % belongs to a finalized pay run — preserve delivered history and record a payroll correction.', OLD.id;
    END IF;
    IF NEW.pay_run_document_id IS NOT NULL OR NEW.pay_run_adjustment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Benefit award % still has a payable adjustment — void it through the award service to remove the adjustment atomically.', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$func$;


-- A deferred check lets the service clear the foreign key before deleting
-- its adjustment, while refusing a void that leaves the cash input payable.
CREATE OR REPLACE FUNCTION public.hrm_benefit_award_void_adjustment_guard()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pay_run_adjustments WHERE org_id = OLD.org_id AND id = OLD.pay_run_adjustment_id) THEN
    RAISE EXCEPTION 'Benefit award % still has a payable adjustment — remove it in the same transaction as voiding the award.', OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;
DROP TRIGGER IF EXISTS hrm_benefit_award_void_adjustment_trigger ON public.hrm_benefit_awards;
CREATE CONSTRAINT TRIGGER hrm_benefit_award_void_adjustment_trigger
  AFTER UPDATE ON public.hrm_benefit_awards
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'queued' AND NEW.status = 'voided' AND OLD.pay_run_adjustment_id IS NOT NULL)
  EXECUTE FUNCTION public.hrm_benefit_award_void_adjustment_guard();
