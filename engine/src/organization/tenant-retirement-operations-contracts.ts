/** Trigger contracts for project, schedule, service, and inventory operations. */
export const OPERATIONS_TRIGGER_CONTRACTS = [
  {
    table: "hrm_benefit_transaction_policies",
    trigger: "benefit_transaction_rule_guard",
    function: "benefit_transaction_rule_guard",
  },
  {
    table: "hrm_benefit_transaction_policies",
    trigger: "benefit_transaction_rule_audit",
    function: "benefit_transaction_rule_audit",
  },
  {
    table: "hrm_benefit_transaction_items",
    trigger: "benefit_transaction_rule_guard",
    function: "benefit_transaction_rule_guard",
  },
  {
    table: "hrm_benefit_transaction_items",
    trigger: "benefit_transaction_rule_audit",
    function: "benefit_transaction_rule_audit",
  },
  {
    table: "hrm_benefit_transaction_positions",
    trigger: "benefit_transaction_rule_guard",
    function: "benefit_transaction_rule_guard",
  },
  {
    table: "hrm_benefit_transaction_positions",
    trigger: "benefit_transaction_rule_audit",
    function: "benefit_transaction_rule_audit",
  },
  {
    table: "hrm_benefit_transaction_responsibilities",
    trigger: "benefit_transaction_rule_guard",
    function: "benefit_transaction_rule_guard",
  },
  {
    table: "hrm_benefit_transaction_responsibilities",
    trigger: "benefit_transaction_rule_audit",
    function: "benefit_transaction_rule_audit",
  },
  {
    table: "hrm_benefit_transaction_limits",
    trigger: "benefit_transaction_rule_guard",
    function: "benefit_transaction_rule_guard",
  },
  {
    table: "hrm_benefit_transaction_limits",
    trigger: "benefit_transaction_rule_audit",
    function: "benefit_transaction_rule_audit",
  },
  {
    table: "project_budget_baselines",
    trigger: "project_budget_baselines_evidence_guard",
    function: "project_delivery_evidence_guard",
  },
  {
    table: "project_budget_baseline_lines",
    trigger: "project_budget_baseline_lines_evidence_guard",
    function: "project_delivery_evidence_guard",
  },
  {
    table: "project_forecasts",
    trigger: "project_forecasts_evidence_guard",
    function: "project_delivery_evidence_guard",
  },
  {
    table: "project_progress_entries",
    trigger: "project_progress_entries_evidence_guard",
    function: "project_delivery_evidence_guard",
  },
  {
    table: "project_revenue_accruals",
    trigger: "project_revenue_accruals_evidence_guard",
    function: "project_delivery_evidence_guard",
  },
  {
    table: "internal_billing_rules",
    trigger: "internal_billing_rules_history_guard",
    function: "internal_billing_rules_history_guard",
  },
  {
    table: "schedule_boards",
    trigger: "schedule_boards_guard",
    function: "schedule_boards_guard",
  },
  {
    table: "schedule_codes",
    trigger: "schedule_codes_guard",
    function: "schedule_codes_guard",
  },
  {
    table: "schedule_entries",
    trigger: "schedule_entries_guard",
    function: "schedule_entries_guard",
  },
  {
    table: "schedule_patterns",
    trigger: "schedule_roster_guard",
    function: "schedule_roster_guard",
  },
  {
    table: "schedule_pattern_assignments",
    trigger: "schedule_roster_guard",
    function: "schedule_roster_guard",
  },
  {
    table: "schedule_pattern_exceptions",
    trigger: "schedule_roster_guard",
    function: "schedule_roster_guard",
  },
  {
    table: "schedule_entry_requests",
    trigger: "schedule_roster_guard",
    function: "schedule_roster_guard",
  },
  {
    table: "schedule_publications",
    trigger: "schedule_roster_guard",
    function: "schedule_roster_guard",
  },
  {
    table: "schedule_attendance_devices",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_identities",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_policies",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_batches",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_events",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_watermarks",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_observations",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_event_claims",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "schedule_attendance_observation_events",
    trigger: "schedule_attendance_guard",
    function: "schedule_attendance_guard",
  },
  {
    table: "service_dispatch_policies",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_requests",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_agreements",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_agreement_versions",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_agreement_lines",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_jobs",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_job_lines",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_quotes",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_quote_lines",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_visits",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_visit_events",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_visit_parts",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_visit_signature_requests",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_visit_signatures",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_billings",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "service_job_deposits",
    trigger: "service_history_guard",
    function: "service_history_guard",
  },
  {
    table: "service_customer_notices",
    trigger: "service_record_guard",
    function: "service_record_guard",
  },
  {
    table: "schedule_source_records",
    trigger: "schedule_source_records_guard",
    function: "schedule_source_records_guard",
  },
  {
    table: "schedule_distributions",
    trigger: "schedule_distributions_snapshot_guard",
    function: "schedule_distribution_snapshot_guard",
  },
  {
    table: "schedule_distribution_recipients",
    trigger: "schedule_distribution_recipients_snapshot_guard",
    function: "schedule_distribution_snapshot_guard",
  },
  {
    table: "einvoice_documents",
    trigger: "einvoice_documents_immutable",
    function: "einvoice_documents_immutable",
  },
  {
    table: "withholding_deductions",
    trigger: "withholding_deductions_guard",
    function: "withholding_deductions_guard",
  },
  {
    table: "withholding_returns",
    trigger: "withholding_returns_guard",
    function: "withholding_returns_guard",
  },
  {
    table: "payroll_holiday_obligations",
    trigger: "payroll_holiday_obligation_guard",
    function: "payroll_holiday_obligation_guard",
  },
  {
    table: "payroll_holiday_occurrences",
    trigger: "payroll_holiday_obligation_guard",
    function: "payroll_holiday_obligation_guard",
  },
  {
    table: "pay_run_holiday_allocations",
    trigger: "payroll_holiday_allocation_guard",
    function: "payroll_holiday_allocation_guard",
  },
  {
    table: "pay_run_holiday_allocations",
    trigger: "payroll_holiday_allocation_audit",
    function: "payroll_holiday_allocation_audit",
  },
  {
    table: "consignment_stock",
    trigger: "consignment_position_guard",
    function: "consignment_position_guard",
  },
  {
    table: "consignment_events",
    trigger: "consignment_event_immutable",
    function: "consignment_event_immutable",
  },
  {
    table: "inventory_count_policies",
    trigger: "inventory_count_policy_history_guard",
    function: "inventory_count_policy_history_guard",
  },
  {
    table: "stock_count_lines",
    trigger: "inventory_serial_count_history_guard",
    function: "inventory_serial_count_history_guard",
  },
  {
    table: "warehouse_scan_events",
    trigger: "warehouse_scan_history",
    function: "warehouse_execution_history_guard",
  },
  {
    table: "pick_waves",
    trigger: "pick_wave_history",
    function: "warehouse_execution_history_guard",
  },
  {
    table: "pick_wave_members",
    trigger: "pick_wave_member_history",
    function: "warehouse_execution_history_guard",
  },
  {
    table: "handling_unit_moves",
    trigger: "handling_unit_move_history",
    function: "warehouse_execution_history_guard",
  },
  {
    table: "warehouse_execution_tasks",
    trigger: "warehouse_execution_task_guard",
    function: "warehouse_execution_task_guard",
  },
  {
    table: "pick_execution_lines",
    trigger: "pick_execution_history_guard",
    function: "pick_execution_history_guard",
  },
  {
    table: "handling_units",
    trigger: "handling_unit_lifecycle",
    function: "handling_unit_lifecycle_guard",
  },
  {
    table: "handling_unit_contents",
    trigger: "handling_unit_content_history",
    function: "handling_unit_content_history_guard",
  },
  {
    table: "operating_profile_versions",
    trigger: "operating_profile_version_immutable",
    function: "operating_profile_version_immutable",
  },
  {
    table: "time_entries",
    trigger: "production_time_history_guard",
    function: "production_time_history_guard",
  },
  {
    table: "mfg_routing_operations",
    trigger: "manufacturing_routing_operation_guard",
    function: "manufacturing_routing_operation_guard",
  },
  {
    table: "mfg_completion_batches",
    trigger: "manufacturing_completion_batch_guard",
    function: "manufacturing_completion_trace_guard",
  },
  {
    table: "mfg_completion_inputs",
    trigger: "manufacturing_completion_input_guard",
    function: "manufacturing_completion_trace_guard",
  },
  {
    table: "inventory_inspection_plans",
    trigger: "inventory_inspection_plan_guard",
    function: "inventory_inspection_plan_guard",
  },
  {
    table: "inventory_inspections",
    trigger: "inventory_inspection_guard",
    function: "inventory_inspection_guard",
  },
  {
    table: "mfg_subcontract_returns",
    trigger: "production_subcontract_return_guard",
    function: "production_subcontract_return_guard",
  },
  {
    table: "mfg_subcontracts",
    trigger: "production_subcontract_guard",
    function: "production_subcontract_guard",
  },
  {
    table: "mfg_subcontract_shipments",
    trigger: "production_subcontract_shipment_guard",
    function: "production_subcontract_shipment_guard",
  },
  {
    table: "mfg_subcontract_service_bills",
    trigger: "production_subcontract_service_guard",
    function: "production_subcontract_service_guard",
  },
  {
    table: "mfg_subcontract_material_returns",
    trigger: "production_subcontract_material_return_guard",
    function: "production_subcontract_material_return_guard",
  },
  {
    table: "mfg_scrap_events",
    trigger: "manufacturing_loss_event_guard",
    function: "manufacturing_loss_event_guard",
  },
  {
    table: "mfg_wo_operations",
    trigger: "manufacturing_snapshot_configuration_guard",
    function: "manufacturing_snapshot_configuration_guard",
  },
  {
    table: "mfg_wo_materials",
    trigger: "manufacturing_snapshot_configuration_guard",
    function: "manufacturing_snapshot_configuration_guard",
  },
  {
    table: "mfg_wo_byproducts",
    trigger: "manufacturing_snapshot_configuration_guard",
    function: "manufacturing_snapshot_configuration_guard",
  },
  {
    table: "bom_components",
    trigger: "production_bom_revision_guard",
    function: "production_bom_revision_guard",
  },
  {
    table: "bom_components",
    trigger: "production_bom_revision_complete_guard",
    function: "production_bom_revision_complete_guard",
  },
  {
    table: "mfg_mrp_runs",
    trigger: "production_mrp_run_evidence_guard",
    function: "production_mrp_run_evidence_guard",
  },
] as const;
