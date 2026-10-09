-- Preserve existing recurring payroll behavior while allowing explicit regular-only assignments.
ALTER TABLE employee_pay_components
  ADD COLUMN run_applicability text NOT NULL DEFAULT 'standard_runs',
  ADD CONSTRAINT employee_pay_components_run_applicability
    CHECK (run_applicability IN ('standard_runs', 'regular_only'));
