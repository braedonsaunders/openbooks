-- Allow recurring assignments on regular and final runs without charging supplemental runs.
ALTER TABLE employee_pay_components
  DROP CONSTRAINT employee_pay_components_run_applicability,
  ADD CONSTRAINT employee_pay_components_run_applicability
    CHECK (run_applicability IN ('standard_runs', 'regular_only', 'periodic_and_final'));
