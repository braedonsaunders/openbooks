-- Close the remaining deferred lifecycle controls after the legacy rows were
-- profiled and found compliant. These constraints were introduced NOT VALID so
-- new writes were protected while pre-existing data could be remediated. A
-- financial release must not leave their historical validation deferred.

ALTER TABLE document_links
  VALIDATE CONSTRAINT document_links_reversal_evidence;

ALTER TABLE asset_events
  VALIDATE CONSTRAINT asset_events_reversal_shape;

ALTER TABLE performance_obligations
  VALIDATE CONSTRAINT performance_obligation_cancellation_shape;

ALTER TABLE tax_provision_runs
  VALIDATE CONSTRAINT tax_provision_runs_lifecycle_shape_chk;

INSERT INTO _migration_control_exceptions (
  migration_filename,
  control_key,
  affected_rows,
  details
)
VALUES
  (
    'generated/0110_validate_financial_lifecycle_constraints.sql',
    'document_links_reversal_evidence',
    0,
    jsonb_build_object(
      'validation', 'complete',
      'legacyViolations', 0,
      'financialHistoryChanged', false
    )
  ),
  (
    'generated/0110_validate_financial_lifecycle_constraints.sql',
    'asset_events_reversal_shape',
    0,
    jsonb_build_object(
      'validation', 'complete',
      'legacyViolations', 0,
      'financialHistoryChanged', false
    )
  ),
  (
    'generated/0110_validate_financial_lifecycle_constraints.sql',
    'performance_obligation_cancellation_shape',
    0,
    jsonb_build_object(
      'validation', 'complete',
      'legacyViolations', 0,
      'financialHistoryChanged', false
    )
  ),
  (
    'generated/0110_validate_financial_lifecycle_constraints.sql',
    'tax_provision_runs_lifecycle_shape_chk',
    0,
    jsonb_build_object(
      'validation', 'complete',
      'legacyViolations', 0,
      'financialHistoryChanged', false
    )
  )
ON CONFLICT (migration_filename, control_key) DO UPDATE
  SET affected_rows = excluded.affected_rows,
      detected_at = now(),
      details = excluded.details;
