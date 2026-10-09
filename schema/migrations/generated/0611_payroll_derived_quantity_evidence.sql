-- Preserve priced operational units independently of worked-hour benefit bases.
ALTER TABLE public.pay_stub_lines ADD COLUMN derived_quantity numeric(24,4);
ALTER TABLE public.pay_stub_lines ADD COLUMN derived_rule_code text;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_derived_quantity_evidence CHECK (
  (derived_quantity IS NULL AND derived_rule_code IS NULL) OR
  (derived_quantity IS NOT NULL AND derived_quantity > 0
    AND derived_quantity <> 'NaN'::numeric
    AND derived_rule_code IS NOT NULL AND length(btrim(derived_rule_code)) > 0
    AND derived_rule_code = btrim(derived_rule_code)
    AND kind = 'earning' AND hours IS NULL)
);

-- Updates cannot reinterpret the operational units behind posted amounts.
CREATE FUNCTION public.pay_stub_line_derived_quantity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run_state text;
BEGIN
  IF ROW(NEW.derived_quantity, NEW.derived_rule_code)
      IS NOT DISTINCT FROM ROW(OLD.derived_quantity, OLD.derived_rule_code) THEN
    RETURN NEW;
  END IF;
  SELECT r.run_status INTO run_state FROM public.pay_stubs s
    JOIN public.pay_runs r ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    WHERE s.org_id = OLD.org_id AND s.id = OLD.stub_id FOR SHARE OF r;
  IF run_state IS NULL OR run_state NOT IN ('draft', 'calculated') THEN
    RAISE EXCEPTION 'Derived payroll quantity evidence is immutable after posting; use a governed payroll correction.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_line_derived_quantity_guard
  BEFORE UPDATE OF derived_quantity, derived_rule_code ON public.pay_stub_lines
  FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_derived_quantity_guard();
