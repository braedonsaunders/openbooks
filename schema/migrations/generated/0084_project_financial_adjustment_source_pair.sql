BEGIN;

ALTER TABLE project_financial_adjustments
  ADD CONSTRAINT project_financial_adjustments_source_pair
  CHECK (
    (source_system IS NULL) = (source_ref IS NULL)
  );

COMMIT;
