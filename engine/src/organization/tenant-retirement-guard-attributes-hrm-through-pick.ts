/** Runtime attributes for HRM through pick execution guards. */
export const HRM_THROUGH_PICK_GUARD_ATTRIBUTES = [
  {
    name: "hrm_compliance_findings_no_delete",
    config: [],
  },
  {
    name: "hrm_documents_history_guard",
    config: [],
  },
  {
    name: "hrm_employment_change_request_no_delete",
    config: [],
  },
  {
    name: "hrm_exit_record_event_no_delete",
    config: [],
  },
  {
    name: "hrm_exit_record_no_delete",
    config: [],
  },
  {
    name: "hrm_feedback_no_delete",
    config: [],
  },
  {
    name: "hrm_goal_update_no_delete",
    config: [],
  },
  {
    name: "hrm_leave_request_no_delete",
    config: [],
  },
  {
    name: "hrm_payroll_input_no_delete",
    config: [],
  },
  {
    name: "hrm_pipeline_template_no_delete",
    config: [],
  },
  {
    name: "hrm_process_steps_history_guard",
    config: [],
  },
  {
    name: "hrm_process_template_no_delete",
    config: [],
  },
  {
    name: "hrm_processes_history_guard",
    config: [],
  },
  {
    name: "hrm_qualification_events_no_delete",
    config: [],
  },
  {
    name: "hrm_recruiting_depth_append_only",
    config: [],
  },
  {
    name: "hrm_recruiting_history_guard",
    config: [],
  },
  {
    name: "hrm_review_event_no_delete",
    config: [],
  },
  {
    name: "hrm_review_no_delete",
    config: [],
  },
  {
    name: "hrm_review_template_no_delete",
    config: [],
  },
  {
    name: "hrm_scorecard_submitted_immutable",
    config: [],
  },
  {
    name: "hrm_talent_review_no_delete",
    config: [],
  },
  {
    name: "hrm_training_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "internal_billing_rules_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "inv_move_guard",
    config: [],
  },
  {
    name: "inventory_count_policy_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "inventory_lot_identity_guard",
    config: [],
  },
  {
    name: "inventory_provisional_immutable",
    config: [],
  },
  {
    name: "inventory_serial_count_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "inventory_serial_lifecycle_guard",
    config: [],
  },
  {
    name: "je_guard",
    config: [],
  },
  {
    name: "jl_guard",
    config: [],
  },
  {
    name: "journal_lines_check_balanced_stmt_del",
    config: [],
  },
  {
    name: "journal_lines_check_fx_residual_stmt_del",
    config: [],
  },
  {
    name: "landed_cost_allocation_guard",
    config: [],
  },
  {
    name: "landed_cost_voucher_guard",
    config: [],
  },
  {
    name: "landed_cost_voucher_target_guard",
    config: [],
  },
  {
    name: "lease_agreement_revision_guard",
    config: [],
  },
  {
    name: "lease_schedule_history_guard",
    config: [],
  },
  {
    name: "multibook_evidence_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "net_investment_configuration_guard",
    config: [],
  },
  {
    name: "net_investment_evidence_guard",
    config: [],
  },
  {
    name: "nonprofit_frameworks_guard",
    config: [],
  },
  {
    name: "openbooks_bank_statement_line_guard",
    config: [],
  },
  {
    name: "openbooks_gl_activity_entry",
    config: [],
  },
  {
    name: "openbooks_gl_activity_line",
    config: [],
  },
  {
    name: "openbooks_guard_ap_capture_evidence",
    config: [],
  },
  {
    name: "openbooks_guard_ap_capture_source_blob",
    config: [],
  },
  {
    name: "openbooks_guard_ap_capture_source_file",
    config: [],
  },
  {
    name: "openbooks_guard_ap_capture_source_version",
    config: [],
  },
  {
    name: "openbooks_guard_budget_line",
    config: [],
  },
  {
    name: "openbooks_guard_budget_scenario",
    config: [],
  },
  {
    name: "openbooks_guard_depreciation_evidence",
    config: [],
  },
  {
    name: "openbooks_guard_finished_ap_capture_run",
    config: [],
  },
  {
    name: "openbooks_guard_pay_run_bank_file",
    config: [],
  },
  {
    name: "openbooks_guard_payroll_bank_file_blob",
    config: [],
  },
  {
    name: "openbooks_guard_payroll_bank_file_file",
    config: [],
  },
  {
    name: "openbooks_guard_payroll_bank_file_version",
    config: [],
  },
  {
    name: "openbooks_party_payment_stats",
    config: [],
  },
  {
    name: "openbooks_reconciliation_match_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "order_line_cancellations_append_only_guard",
    config: [],
  },
  {
    name: "org_business_calendars_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "pay_component_earning_classifications_prevent_orphan_delete",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "pay_component_history_guard",
    config: [],
  },
  {
    name: "pay_component_statutory_treatment_preserve_committed",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "payment_event_immutable",
    config: [],
  },
  {
    name: "payment_run_item_guard",
    config: [],
  },
  {
    name: "payroll_annual_period_bounds_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_compensation_calculation_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_compensation_configuration_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_employee_employer_assignment_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_holiday_allocation_audit",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "payroll_holiday_allocation_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "payroll_holiday_obligation_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "payroll_period_opening_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_program_period_bounds_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_service_configuration_audit",
    config: [],
  },
  {
    name: "payroll_service_configuration_guard",
    config: [],
  },
  {
    name: "payroll_work_location_allocation_audit",
    config: [],
  },
  {
    name: "payroll_work_location_allocation_lock_committed",
    config: [],
  },
  {
    name: "pick_execution_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
] as const;
