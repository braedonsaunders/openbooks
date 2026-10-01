-- Represent employer-provided non-cash value using native payroll earnings.
-- Existing components and calculated history remain explicitly cash. Country
-- pack treatment stays on the earning; the new representation changes only
-- cash entitlement and its balance-sheet offset.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components ADD COLUMN payment_kind text NOT NULL DEFAULT 'cash';
ALTER TABLE public.pay_components ADD COLUMN non_cash_account_id uuid;
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_payment_kind CHECK (payment_kind IN ('cash', 'non_cash'));
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_non_cash_shape CHECK (
  (payment_kind = 'cash' AND non_cash_account_id IS NULL) OR
  (payment_kind = 'non_cash' AND kind = 'earning' AND system_key IS NULL AND non_cash_account_id IS NOT NULL)
);
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_non_cash_account_tenant_fkey
  FOREIGN KEY (org_id, non_cash_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.pay_stub_lines ADD COLUMN payment_kind text NOT NULL DEFAULT 'cash';
ALTER TABLE public.pay_stub_lines ADD COLUMN non_cash_account_id uuid;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_payment_kind CHECK (payment_kind IN ('cash', 'non_cash'));
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_non_cash_shape CHECK (
  (payment_kind = 'cash' AND non_cash_account_id IS NULL) OR
  (payment_kind = 'non_cash' AND kind = 'earning' AND non_cash_account_id IS NOT NULL)
);
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_non_cash_account_tenant_fkey
  FOREIGN KEY (org_id, non_cash_account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE FUNCTION public.pay_component_non_cash_account_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.payment_kind IS DISTINCT FROM OLD.payment_kind AND EXISTS (
    SELECT 1 FROM public.hrm_benefit_programs p WHERE p.org_id = OLD.org_id AND p.pay_component_id = OLD.id
      AND (p.status = 'active' OR EXISTS (
        SELECT 1 FROM public.hrm_benefit_awards a WHERE a.org_id = p.org_id AND a.program_id = p.id
          AND a.status IN ('approved', 'queued', 'delivered')
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An active benefit program or approved benefit obligation uses this cash representation; preserve its component and create a new program and component for a different delivery policy.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.payment_kind IS DISTINCT FROM OLD.payment_kind AND EXISTS (
    SELECT 1 FROM public.pay_stub_lines l JOIN public.pay_stubs s ON s.org_id = l.org_id AND s.id = l.stub_id
    JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    WHERE l.org_id = OLD.org_id AND l.component_id = OLD.id AND r.run_status IN ('committed', 'voided')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pay component cash representation is fixed after committed payroll; preserve this component and create a new component for future earnings.';
  END IF;
  IF NEW.payment_kind = 'non_cash' AND NOT EXISTS (
    SELECT 1 FROM public.accounts a WHERE a.org_id = NEW.org_id AND a.id = NEW.non_cash_account_id
      AND a.is_active AND NOT a.is_summary
      AND a.type IN ('asset_current_other', 'asset_other', 'liability_current_other', 'liability_long_term')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A non-cash earning requires an active posting prepaid asset or provider clearing liability; an expense account would count the benefit twice.';
  END IF;
  RETURN NEW;
END
$func$;
CREATE TRIGGER pay_component_non_cash_account_trigger BEFORE INSERT OR UPDATE ON public.pay_components
  FOR EACH ROW EXECUTE FUNCTION public.pay_component_non_cash_account_guard();

CREATE FUNCTION public.pay_stub_line_payment_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE component_payment_kind text; component_non_cash_account uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'earning' AND NEW.component_id IS NOT NULL THEN
      SELECT payment_kind, non_cash_account_id INTO component_payment_kind, component_non_cash_account
        FROM public.pay_components WHERE org_id = NEW.org_id AND id = NEW.component_id;
      IF component_payment_kind IS NOT NULL AND (
        NEW.payment_kind IS DISTINCT FROM component_payment_kind OR
        (component_payment_kind = 'non_cash' AND NEW.non_cash_account_id IS DISTINCT FROM component_non_cash_account)
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The calculated earning cash representation must match its configured component. Update the payroll application and recalculate; a non-cash benefit must never also be paid as cash.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.payment_kind, NEW.non_cash_account_id) IS DISTINCT FROM ROW(OLD.payment_kind, OLD.non_cash_account_id)
     AND EXISTS (SELECT 1 FROM public.pay_stubs s JOIN public.pay_runs r
       ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
       WHERE s.org_id = OLD.org_id AND s.id = OLD.stub_id AND r.run_status IN ('committed', 'voided')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The cash representation and clearing account of a committed payroll line are immutable; use a correcting payroll run.';
  END IF;
  RETURN NEW;
END
$func$;
CREATE TRIGGER pay_stub_line_payment_kind_trigger BEFORE INSERT OR UPDATE ON public.pay_stub_lines
  FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_payment_kind_guard();

CREATE FUNCTION public.hrm_benefit_award_payment_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
DECLARE delivery text;
BEGIN
  SELECT delivery_method INTO delivery FROM public.hrm_benefit_programs WHERE org_id = NEW.org_id AND id = NEW.program_id;
  IF OLD.status = 'approved' AND NEW.status = 'queued' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pay_run_adjustments a
      JOIN public.pay_runs r ON r.org_id = a.org_id AND r.document_id = a.pay_run_document_id
      JOIN public.documents d ON d.org_id = r.org_id AND d.id = r.document_id
      JOIN public.worker_employments e ON e.org_id = NEW.org_id AND e.id = NEW.employment_id
      JOIN public.hrm_benefit_programs p ON p.org_id = NEW.org_id AND p.id = NEW.program_id
      JOIN public.pay_components c ON c.org_id = p.org_id AND c.id = p.pay_component_id
      WHERE a.org_id = NEW.org_id AND a.id = NEW.pay_run_adjustment_id AND a.pay_run_document_id = NEW.pay_run_document_id
        AND a.component_id = p.pay_component_id AND a.employee_party_id = e.worker_party_id
        AND a.adjustment_type = 'line' AND NOT a.replace_component AND a.amount = NEW.value
        AND c.kind = 'earning' AND c.is_active
        AND c.payment_kind = CASE WHEN delivery = 'external' THEN 'non_cash' ELSE 'cash' END
        AND d.status = 'draft' AND r.run_status <> 'committed'
        AND d.subsidiary_id = p.legal_entity_id AND d.currency = NEW.currency
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
      JOIN public.hrm_benefit_programs p ON p.org_id = NEW.org_id AND p.id = NEW.program_id
      WHERE s.org_id = NEW.org_id AND s.pay_run_document_id = NEW.pay_run_document_id
        AND s.employment_id = NEW.employment_id AND s.employee_party_id = e.worker_party_id AND s.currency_code = NEW.currency
        AND l.component_id = p.pay_component_id AND l.kind = 'earning' AND l.amount = NEW.value
        AND l.payment_kind = 'non_cash' AND l.non_cash_account_id IS NOT NULL
        AND r.run_status = 'committed' AND d.status <> 'voided'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Provider fulfillment requires its reference and the committed non-cash payroll representation; calculate and commit the linked pay run before recording fulfillment.';
    END IF;
  END IF;
  RETURN NEW;
END
$func$;
CREATE TRIGGER hrm_benefit_award_payment_kind_trigger BEFORE UPDATE ON public.hrm_benefit_awards
  FOR EACH ROW EXECUTE FUNCTION public.hrm_benefit_award_payment_kind_guard();

CREATE FUNCTION public.payroll_provider_fulfillment_void_guard() RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  IF NEW.status = 'voided' AND OLD.status <> 'voided' AND EXISTS (
    SELECT 1 FROM public.hrm_benefit_awards a JOIN public.hrm_benefit_programs p ON p.org_id = a.org_id AND p.id = a.program_id
    WHERE a.org_id = OLD.org_id AND a.pay_run_document_id = OLD.id AND a.status = 'delivered'
      AND p.delivery_method = 'external' AND a.external_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This payroll run represents a fulfilled non-cash benefit; voiding payroll does not cancel provider fulfillment. Record an adjusting benefit award and correcting payroll run instead.';
  END IF;
  RETURN NEW;
END
$func$;
CREATE TRIGGER payroll_provider_fulfillment_void_trigger BEFORE UPDATE OF status ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.payroll_provider_fulfillment_void_guard();

SELECT public.openbooks_refresh_query_catalog();
