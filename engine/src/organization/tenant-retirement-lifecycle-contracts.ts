/** Trigger contracts for record lifecycle controls. */
export const LIFECYCLE_TRIGGER_CONTRACTS = [
  {
    table: "payment_instructions",
    trigger: "payment_instructions_posting_claim_fence",
    function: "enforce_payment_instruction_posting_claim",
  },
  {
    table: "document_lines",
    trigger: "document_lines_total_line_refresh",
    function: "document_lines_total_line_refresh",
  },
  {
    table: "document_lines",
    trigger: "document_lines_total_line_tieout",
    function: "document_lines_total_line_tieout",
  },
  {
    table: "scheduler_outbox_terminal_audit",
    trigger: "scheduler_outbox_terminal_audit_append_only",
    function: "scheduler_outbox_terminal_audit_append_only_guard",
  },
  {
    table: "document_lines",
    trigger: "document_line_immutability",
    function: "document_line_immutability_guard",
  },
  {
    table: "change_set_items",
    trigger: "change_set_items_lifecycle_guard",
    function: "change_set_items_lifecycle_guard",
  },
  {
    table: "account_group_members",
    trigger: "account_group_member_scope_guard",
    function: "account_group_member_scope_guard",
  },
  {
    table: "pay_components",
    trigger: "pay_component_history_guard",
    function: "pay_component_history_guard",
  },
  {
    table: "accounting_books",
    trigger: "primary_book_history_guard",
    function: "primary_book_history_guard",
  },
  {
    table: "depreciation_book_policies",
    trigger: "depreciation_book_policy_history_guard",
    function: "depreciation_book_policy_history_guard",
  },
  {
    table: "allocation_rule_targets",
    trigger: "allocation_rule_target_guard",
    function: "allocation_rule_target_guard",
  },
  {
    table: "worker_employment_versions",
    trigger: "worker_employment_versions_closure",
    function: "worker_employment_versions_closure_guard",
  },
  {
    table: "employment_assignment_versions",
    trigger: "employment_assignment_versions_closure",
    function: "employment_assignment_versions_closure_guard",
  },
  {
    table: "reporting_relationships",
    trigger: "reporting_relationships_closure",
    function: "reporting_relationships_closure_guard",
  },
  {
    table: "employment_changes",
    trigger: "employment_changes_immutable",
    function: "employment_changes_immutable_guard",
  },
  {
    table: "hrm_employment_change_requests",
    trigger: "hrm_employment_change_request_no_delete_trigger",
    function: "hrm_employment_change_request_no_delete",
  },
  {
    table: "position_versions",
    trigger: "position_versions_closure",
    function: "position_versions_closure_guard",
  },
  {
    table: "position_changes",
    trigger: "position_changes_immutable",
    function: "position_changes_immutable_guard",
  },
  {
    table: "hrm_process_templates",
    trigger: "hrm_process_template_no_delete",
    function: "hrm_process_template_no_delete",
  },
  {
    table: "hrm_processes",
    trigger: "hrm_processes_history",
    function: "hrm_processes_history_guard",
  },
  {
    table: "hrm_process_steps",
    trigger: "hrm_process_steps_history",
    function: "hrm_process_steps_history_guard",
  },
  {
    table: "hrm_absences",
    trigger: "hrm_absence_no_delete_trigger",
    function: "hrm_absence_no_delete",
  },
  {
    table: "hrm_leave_requests",
    trigger: "hrm_leave_request_no_delete_trigger",
    function: "hrm_leave_request_no_delete",
  },
  {
    table: "hrm_payroll_inputs",
    trigger: "hrm_payroll_input_no_delete_trigger",
    function: "hrm_payroll_input_no_delete",
  },
  {
    table: "hrm_pipeline_templates",
    trigger: "hrm_pipeline_template_no_delete",
    function: "hrm_pipeline_template_no_delete",
  },
  {
    table: "hrm_application_events",
    trigger: "hrm_application_events_immutable",
    function: "hrm_application_events_immutable",
  },
  {
    table: "hrm_requisitions",
    trigger: "hrm_requisitions_history",
    function: "hrm_recruiting_history_guard",
  },
  {
    table: "hrm_applications",
    trigger: "hrm_applications_history",
    function: "hrm_recruiting_history_guard",
  },
  {
    table: "hrm_interviews",
    trigger: "hrm_interviews_history",
    function: "hrm_recruiting_history_guard",
  },
  {
    table: "hrm_offers",
    trigger: "hrm_offers_history",
    function: "hrm_recruiting_history_guard",
  },
  {
    table: "hrm_review_events",
    trigger: "hrm_review_event_no_delete_trigger",
    function: "hrm_review_event_no_delete",
  },
  {
    table: "hrm_goal_updates",
    trigger: "hrm_goal_update_no_delete_trigger",
    function: "hrm_goal_update_no_delete",
  },
  {
    table: "hrm_reviews",
    trigger: "hrm_review_no_delete_trigger",
    function: "hrm_review_no_delete",
  },
  {
    table: "hrm_exit_records",
    trigger: "hrm_exit_record_no_delete_trigger",
    function: "hrm_exit_record_no_delete",
  },
  {
    table: "hrm_review_templates",
    trigger: "hrm_review_template_no_delete_trigger",
    function: "hrm_review_template_no_delete",
  },
  {
    table: "hrm_benefit_events",
    trigger: "hrm_benefit_event_no_delete_trigger",
    function: "hrm_benefit_event_no_delete",
  },
  {
    table: "hrm_benefit_enrollments",
    trigger: "hrm_benefit_enrollment_no_delete_trigger",
    function: "hrm_benefit_enrollment_no_delete",
  },
  {
    table: "hrm_benefit_payroll_inputs",
    trigger: "hrm_benefit_payroll_input_no_delete_trigger",
    function: "hrm_benefit_payroll_input_no_delete",
  },
  {
    table: "financial_changes",
    trigger: "financial_change_guard",
    function: "financial_change_guard",
  },
  {
    table: "lease_agreement_schedule_lines",
    trigger: "lease_schedule_history_guard",
    function: "lease_schedule_history_guard",
  },
  {
    table: "lease_agreements",
    trigger: "lease_agreement_revision_guard",
    function: "lease_agreement_revision_guard",
  },
  {
    table: "recognition_schedule_lines",
    trigger: "recognition_revision_history_guard",
    function: "recognition_revision_history_guard",
  },
  {
    table: "asset_basis_changes",
    trigger: "asset_basis_change_guard",
    function: "asset_basis_change_guard",
  },
  {
    table: "asset_transfer_bases",
    trigger: "asset_transfer_history_guard",
    function: "asset_transfer_history_guard",
  },
  {
    table: "asset_transfer_consolidation_entries",
    trigger: "asset_transfer_history_guard",
    function: "asset_transfer_history_guard",
  },
  {
    table: "asset_transfer_measurements",
    trigger: "asset_transfer_measurement_guard",
    function: "asset_transfer_measurement_guard",
  },
  {
    table: "consolidation_control_losses",
    trigger: "control_loss_history_guard",
    function: "control_loss_history_guard",
  },
  {
    table: "consolidated_fx_rates",
    trigger: "control_loss_rate_guard",
    function: "control_loss_source_guard",
  },
  {
    table: "hrm_comp_events",
    trigger: "hrm_comp_events_immutable",
    function: "hrm_compensation_history_guard",
  },
  {
    table: "hrm_pay_bands",
    trigger: "hrm_pay_bands_history",
    function: "hrm_compensation_history_guard",
  },
  {
    table: "hrm_comp_cycle_lines",
    trigger: "hrm_comp_cycle_lines_history",
    function: "hrm_compensation_history_guard",
  },
  {
    table: "hrm_comp_statements",
    trigger: "hrm_comp_statements_history",
    function: "hrm_compensation_history_guard",
  },
  {
    table: "hrm_pay_gap_snapshots",
    trigger: "hrm_pay_gap_snapshots_frozen",
    function: "hrm_compensation_plans_guard",
  },
  {
    table: "hrm_headcount_plans",
    trigger: "hrm_headcount_plans_history",
    function: "hrm_compensation_plans_guard",
  },
  {
    table: "hrm_headcount_plan_lines",
    trigger: "hrm_headcount_plan_lines_history",
    function: "hrm_compensation_plans_guard",
  },
  {
    table: "hrm_pay_information_requests",
    trigger: "hrm_pay_information_requests_history",
    function: "hrm_compensation_plans_guard",
  },
  {
    table: "hrm_allowance_payroll_inputs",
    trigger: "hrm_allowance_payroll_input_no_delete_trigger",
    function: "hrm_allowance_payroll_input_no_delete",
  },
  {
    table: "hrm_compliance_findings",
    trigger: "hrm_compliance_findings_no_delete_trigger",
    function: "hrm_compliance_findings_no_delete",
  },
  {
    table: "hrm_qualification_events",
    trigger: "hrm_qualification_events_no_delete_trigger",
    function: "hrm_qualification_events_no_delete",
  },
  {
    table: "hrm_feedback",
    trigger: "hrm_feedback_no_delete_trigger",
    function: "hrm_feedback_no_delete",
  },
  {
    table: "hrm_calibration_events",
    trigger: "hrm_calibration_event_no_delete_trigger",
    function: "hrm_calibration_event_no_delete",
  },
  {
    table: "hrm_talent_reviews",
    trigger: "hrm_talent_review_no_delete_trigger",
    function: "hrm_talent_review_no_delete",
  },
  {
    table: "hrm_scorecards",
    trigger: "hrm_scorecards_submitted_immutable",
    function: "hrm_scorecard_submitted_immutable",
  },
  {
    table: "hrm_offer_versions",
    trigger: "hrm_offer_versions_append_only",
    function: "hrm_recruiting_depth_append_only",
  },
  {
    table: "hrm_posting_events",
    trigger: "hrm_posting_events_append_only",
    function: "hrm_recruiting_depth_append_only",
  },
  {
    table: "hrm_retention_runs",
    trigger: "hrm_retention_runs_append_only",
    function: "hrm_recruiting_depth_append_only",
  },
  {
    table: "hrm_document_events",
    trigger: "hrm_document_events_immutable",
    function: "hrm_documents_history_guard",
  },
  {
    table: "hrm_retention_actions",
    trigger: "hrm_retention_actions_immutable",
    function: "hrm_documents_history_guard",
  },
  {
    table: "hrm_survey_responses",
    trigger: "hrm_survey_responses_immutable",
    function: "hrm_documents_history_guard",
  },
  {
    table: "ai_decisions",
    trigger: "ai_decisions_refuse_update",
    function: "ai_decisions_refuse_update",
  },
  {
    table: "depreciation_schedule_lines",
    trigger: "depreciation_non_gl_recognition_guard",
    function: "depreciation_non_gl_recognition_guard",
  },
  {
    table: "price_levels",
    trigger: "price_level_base_guard",
    function: "protect_org_base_price_level",
  },
  {
    table: "customer_roles",
    trigger: "customer_role_pricing_guard",
    function: "protect_pricing_customer_role",
  },
  {
    table: "hrm_exit_record_events",
    trigger: "hrm_exit_record_event_no_delete_trigger",
    function: "hrm_exit_record_event_no_delete",
  },
  {
    table: "journal_lines",
    trigger: "journal_line_open_balance",
    function: "trg_journal_line_open_balance",
  },
  {
    table: "pay_component_earning_classifications",
    trigger: "pay_component_earning_classifications_protect_parent",
    function: "pay_component_earning_classifications_prevent_orphan_delete",
  },
  {
    table: "pay_component_statutory_treatments",
    trigger: "pay_component_statutory_treatment_preserve_committed",
    function: "pay_component_statutory_treatment_preserve_committed",
  },
  {
    table: "payroll_work_location_allocations",
    trigger: "payroll_work_location_allocation_lock_committed",
    function: "payroll_work_location_allocation_lock_committed",
  },
  {
    table: "payroll_work_location_allocations",
    trigger: "payroll_work_location_allocation_audit",
    function: "payroll_work_location_allocation_audit",
  },
  {
    table: "journal_lines",
    trigger: "journal_lines_balanced_stmt_del",
    function: "journal_lines_check_balanced_stmt_del",
  },
  {
    table: "fulfillment_documents",
    trigger: "fulfillment_documents_guard",
    function: "fulfillment_documents_guard",
  },
  {
    table: "fulfillment_lines",
    trigger: "fulfillment_lines_guard",
    function: "fulfillment_lines_guard",
  },
  {
    table: "order_line_cancellations",
    trigger: "order_line_cancellations_append_only",
    function: "order_line_cancellations_append_only_guard",
  },
  {
    table: "usage_rating_plan_versions",
    trigger: "usage_rating_plan_versions_immutable",
    function: "usage_rating_published_immutable_guard",
  },
  {
    table: "usage_rating_bands",
    trigger: "usage_rating_bands_draft_only",
    function: "usage_rating_bands_draft_only_guard",
  },
  {
    table: "usage_prepaid_draws",
    trigger: "usage_prepaid_draws_append_only",
    function: "usage_prepaid_draws_append_only_guard",
  },
  {
    table: "segment_values",
    trigger: "segment_values_clear_default_for_wipe",
    function: "segment_values_clear_default_for_wipe",
  },
  {
    table: "nonprofit_frameworks",
    trigger: "nonprofit_frameworks_guard",
    function: "nonprofit_frameworks_guard",
  },
  {
    table: "saas_metrics_fx_evidence",
    trigger: "saas_metrics_fx_evidence_guard",
    function: "saas_metrics_fx_evidence_guard",
  },
  {
    table: "saas_metrics_normalization_requests",
    trigger: "saas_metrics_normalization_requests_guard",
    function: "saas_metrics_normalization_request_guard",
  },
  {
    table: "journal_lines",
    trigger: "journal_lines_fx_residual_stmt_del",
    function: "journal_lines_check_fx_residual_stmt_del",
  },
  {
    table: "provision_obligations",
    trigger: "provision_identity_immutable",
    function: "provision_identity_guard",
  },
  {
    table: "assembly_disassemblies",
    trigger: "assembly_disassembly_immutable",
    function: "assembly_disassembly_immutable",
  },
  {
    table: "drop_ship_agent_allocations",
    trigger: "drop_ship_allocation_guard",
    function: "drop_ship_allocation_guard",
  },
  {
    table: "net_investment_entries",
    trigger: "net_investment_evidence_guard",
    function: "net_investment_evidence_guard",
  },
  {
    table: "net_investment_sources",
    trigger: "net_investment_evidence_guard",
    function: "net_investment_evidence_guard",
  },
  {
    table: "subsidiary_ownership_interests",
    trigger: "net_investment_configuration_guard",
    function: "net_investment_configuration_guard",
  },
  {
    table: "intercompany_pairs",
    trigger: "net_investment_configuration_guard",
    function: "net_investment_configuration_guard",
  },
  {
    table: "consolidated_fx_rates",
    trigger: "net_investment_configuration_guard",
    function: "net_investment_configuration_guard",
  },
  {
    table: "document_goods_tax_snapshots",
    trigger: "goods_tax_snapshot_guard",
    function: "goods_tax_snapshot_guard",
  },
  {
    table: "tax_registrations",
    trigger: "goods_tax_registration_history_guard",
    function: "goods_tax_registration_history_guard",
  },
] as const;
