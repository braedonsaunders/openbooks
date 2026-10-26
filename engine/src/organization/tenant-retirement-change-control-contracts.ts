/** Trigger contracts for pending changes and approvals. */
export const CHANGE_CONTROL_TRIGGER_CONTRACTS = [
  {
    table: "ap_capture_autopost_policies",
    trigger: "ap_capture_autopost_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "time_entries",
    trigger: "source_retired_time_evidence",
    function: "source_retired_time_guard",
  },
  {
    table: "depreciation_schedule_lines",
    trigger: "depreciation_source_authority_guard",
    function: "depreciation_source_authority_guard",
  },
  {
    table: "hrm_leave_payroll_entitlement_mappings",
    trigger: "hrm_leave_payroll_entitlement_mappings_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "hrm_calibration_entries",
    trigger: "calibration_entry_published_guard",
    function: "calibration_entry_published_guard",
  },
  {
    table: "hrm_calibration_sessions",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_calibration_entries",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_headcount_plan_lines",
    trigger: "headcount_plan_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "reconciliation_matches",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "subcontracts",
    trigger: "subcontract_change_pending_terms_guard",
    function: "subcontract_change_pending_terms_guard",
  },
  {
    table: "subcontract_sov_lines",
    trigger: "subcontract_change_pending_terms_guard",
    function: "subcontract_change_pending_terms_guard",
  },
  {
    table: "vendor_pay_applications",
    trigger: "subcontract_change_pending_terms_guard",
    function: "subcontract_change_pending_terms_guard",
  },
  {
    table: "vendor_pay_application_lines",
    trigger: "subcontract_change_pending_terms_guard",
    function: "subcontract_change_pending_terms_guard",
  },
  {
    table: "hrm_training_courses",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "reconciliations",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "rebate_agreements",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "close_run_tasks",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "close_task_evidence",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "rebate_claims",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "subcontracts",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "subcontract_sov_lines",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "subcontract_change_orders",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "vendor_pay_applications",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "vendor_pay_application_lines",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "pay_applications",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "pay_application_lines",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "change_orders",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_headcount_plans",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_headcount_plan_lines",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_comp_cycle_lines",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_per_diem_entries",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "hrm_travel_pay_entries",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "change_sets",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "change_set_items",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "compliance_waivers",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "compliance_records",
    trigger: "native_command_pending_terms_guard",
    function: "native_command_pending_terms_guard",
  },
  {
    table: "flow_submissions",
    trigger: "flow_submission_receipt_guard",
    function: "flow_submission_receipt_guard",
  },
] as const;
