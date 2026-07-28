BEGIN;

ALTER TABLE project_financial_adjustments
  DROP CONSTRAINT IF EXISTS project_financial_adjustments_measure;

ALTER TABLE project_financial_adjustments
  ADD CONSTRAINT project_financial_adjustments_measure
  CHECK (
    measure IN (
      'actual_cost',
      'invoiced_to_date',
      'billable_value',
      'total_price',
      'could_be_invoiced',
      'gross_profit'
    )
  );

COMMIT;
