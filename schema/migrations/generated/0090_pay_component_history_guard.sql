-- OpenBooks forward migration 0090_pay_component_history_guard.
-- Tax classification is a historical policy identity after committed use.
-- No historical rows are rewritten or inferred from current configuration.
CREATE OR REPLACE FUNCTION public.pay_component_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Permit the owning tenant's cascade deletion, never an ordinary component
  -- deletion that would SET NULL on historical stub lines.
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.orgs WHERE id = OLD.org_id
  ) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.org_id, NEW.kind, NEW.system_key, NEW.country,
           NEW.taxable, NEW.pensionable, NEW.insurable, NEW.vacationable,
           NEW.non_periodic, NEW.tax_treatment)
       IS NOT DISTINCT FROM
       ROW(OLD.id, OLD.org_id, OLD.kind, OLD.system_key, OLD.country,
           OLD.taxable, OLD.pensionable, OLD.insurable, OLD.vacationable,
           OLD.non_periodic, OLD.tax_treatment) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pay_stub_lines l
    JOIN public.pay_stubs s ON s.org_id = l.org_id AND s.id = l.stub_id
    JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
     WHERE l.org_id = OLD.org_id AND l.component_id = OLD.id
       AND r.run_status IN ('committed', 'voided')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      CONSTRAINT = 'pay_component_historical_policy',
      MESSAGE = 'Pay component tax classification is fixed after committed payroll. Preserve this component and use a new policy for future payroll; historical corrections require a controlled adjustment.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- Raw SQL writers must also invalidate an existing calculation. A caller's
  -- old transaction timestamp must not hide a later policy edit.
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pay_component_history_guard ON public.pay_components;
CREATE TRIGGER pay_component_history_guard BEFORE UPDATE OR DELETE ON public.pay_components
FOR EACH ROW EXECUTE FUNCTION public.pay_component_history_guard();
