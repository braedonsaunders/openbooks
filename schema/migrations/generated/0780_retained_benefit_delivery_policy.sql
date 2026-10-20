-- Pay approved benefit obligations from their immutable delivery terms.
-- Later program revisions cannot replace the component or legal entity.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.hrm_benefit_award_payment_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE delivery text; component uuid; entity uuid;
BEGIN
  delivery:=NEW.program_snapshot->>'deliveryMethod';
  IF (OLD.status='approved' AND NEW.status='queued') OR (delivery='external' AND OLD.status='queued' AND NEW.status='delivered') THEN
    IF delivery NOT IN('payroll','external') OR delivery IS NULL
      OR coalesce(NEW.source_snapshot->>'payComponentId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      OR coalesce(NEW.program_snapshot->>'legalEntityId','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'The award has no complete retained delivery policy. Void the unissued award and create it from the current program before payroll processing.' USING ERRCODE='23514';
    END IF;
    component:=(NEW.source_snapshot->>'payComponentId')::uuid;
    entity:=(NEW.program_snapshot->>'legalEntityId')::uuid;
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'queued' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_run_adjustments a
      JOIN public.pay_runs r ON r.org_id = a.org_id AND r.document_id = a.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      JOIN public.worker_employments e ON e.org_id = NEW.org_id AND e.id = NEW.employment_id
      JOIN public.pay_components c ON c.org_id = NEW.org_id AND c.id = component
      WHERE a.org_id = NEW.org_id AND a.id = NEW.pay_run_adjustment_id AND a.pay_run_document_id = NEW.pay_run_document_id
        AND a.component_id = component AND a.employee_party_id = e.worker_party_id AND e.employer_subsidiary_id=entity
        AND a.adjustment_type = 'line' AND NOT a.replace_component AND a.amount = NEW.value
        AND c.kind = 'earning' AND c.is_active
        AND c.payment_kind = CASE WHEN delivery = 'external' THEN 'non_cash' ELSE 'cash' END
        AND d.status = 'draft' AND r.run_status <> 'committed'
        AND d.subsidiary_id = entity AND d.currency = NEW.currency
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A benefit must queue on its exact native payroll adjustment: cash for payroll rewards, non-cash for provider benefits. Select an editable pay run and the matching earning component.';
    END IF;
  END IF;
  IF delivery = 'external' AND OLD.status = 'queued' AND NEW.status = 'delivered' THEN
    IF NEW.external_ref IS NULL OR length(trim(NEW.external_ref)) = 0 OR NOT EXISTS (
      SELECT 1 FROM public.pay_stubs s JOIN public.pay_stub_lines l ON l.org_id = s.org_id AND l.stub_id = s.id
      JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      JOIN public.worker_employments e ON e.org_id = NEW.org_id AND e.id = NEW.employment_id
      WHERE s.org_id = NEW.org_id AND s.pay_run_document_id = NEW.pay_run_document_id
        AND s.employment_id = NEW.employment_id AND s.employee_party_id = e.worker_party_id AND s.currency_code = NEW.currency AND e.employer_subsidiary_id=entity
        AND l.component_id = component AND l.kind = 'earning' AND l.amount = NEW.value
        AND l.payment_kind = 'non_cash' AND l.non_cash_account_id IS NOT NULL
        AND r.run_status = 'committed' AND d.status <> 'voided'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Provider fulfillment requires its reference and the committed non-cash payroll representation; calculate and commit the linked pay run before recording fulfillment.';
    END IF;
  END IF;
  RETURN NEW;
END
$func$;
