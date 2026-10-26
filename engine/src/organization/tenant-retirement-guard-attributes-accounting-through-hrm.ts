/** Runtime attributes for accounting through HRM guards. */
export const ACCOUNTING_THROUGH_HRM_GUARD_ATTRIBUTES = [
  {
    name: "account_group_member_scope_guard",
    config: [],
  },
  {
    name: "accounting_book_account_map_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "accounting_book_currency_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "accounting_book_replication_run_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "aging_bucket_policies_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "ai_decisions_refuse_update",
    config: [],
  },
  {
    name: "allocation_rule_target_guard",
    config: [],
  },
  {
    name: "application_evidence_guard",
    config: [],
  },
  {
    name: "assembly_disassembly_immutable",
    config: [],
  },
  {
    name: "asset_basis_change_guard",
    config: [],
  },
  {
    name: "asset_event_append_only_guard",
    config: [],
  },
  {
    name: "asset_transfer_history_guard",
    config: [],
  },
  {
    name: "asset_transfer_measurement_guard",
    config: [],
  },
  {
    name: "audit_log_append_only_guard",
    config: [],
  },
  {
    name: "benefit_catalog_identity_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "benefit_recovery_source_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "benefit_recurring_audit",
    config: [],
  },
  {
    name: "benefit_recurring_configuration_lock",
    config: [],
  },
  {
    name: "benefit_recurring_history_guard",
    config: [],
  },
  {
    name: "benefit_transaction_rule_audit",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "benefit_transaction_rule_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "billing_request_field_ticket_guard",
    config: [],
  },
  {
    name: "change_set_items_lifecycle_guard",
    config: [],
  },
  {
    name: "close_append_only_guard",
    config: [],
  },
  {
    name: "consignment_event_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "consignment_position_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "contract_cost_amortization_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "control_loss_history_guard",
    config: [],
  },
  {
    name: "control_loss_source_guard",
    config: [],
  },
  {
    name: "data_transfer_evidence_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "depreciation_book_policy_history_guard",
    config: [],
  },
  {
    name: "depreciation_evidence_attachment_guard",
    config: [],
  },
  {
    name: "depreciation_non_gl_recognition_guard",
    config: [],
  },
  {
    name: "document_correction_lineage_guard",
    config: [],
  },
  {
    name: "document_line_immutability_guard",
    config: [],
  },
  {
    name: "document_line_tax_component_guard",
    config: [],
  },
  {
    name: "document_lines_total_line_refresh",
    config: [],
  },
  {
    name: "document_lines_total_line_tieout",
    config: [],
  },
  {
    name: "document_supply_evidence_guard",
    config: [],
  },
  {
    name: "document_tender_lifecycle_guard",
    config: [],
  },
  {
    name: "drop_ship_allocation_guard",
    config: [],
  },
  {
    name: "dunning_log_guard",
    config: [],
  },
  {
    name: "einvoice_documents_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "employment_assignment_versions_closure_guard",
    config: [],
  },
  {
    name: "employment_changes_immutable_guard",
    config: [],
  },
  {
    name: "enforce_deleted_role_assignment",
    config: [],
  },
  {
    name: "enforce_payment_instruction_posting_claim",
    config: [],
  },
  {
    name: "entitlement_ledger_append_only_guard",
    config: [],
  },
  {
    name: "expense_amortization_event_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "expense_amortization_line_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "expense_amortization_schedule_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "field_ticket_labor_line_immutable_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "field_ticket_labor_snapshot_retention_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "field_ticket_signature_immutable_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "field_ticket_signature_request_guard",
    config: [],
  },
  {
    name: "financial_change_guard",
    config: [],
  },
  {
    name: "equity_record_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "equity_action_request_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "financial_policy_version_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "fulfillment_documents_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "fulfillment_lines_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "fx_rate_age_policy_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "goods_tax_registration_history_guard",
    config: [],
  },
  {
    name: "goods_tax_snapshot_guard",
    config: [],
  },
  {
    name: "handling_unit_content_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "handling_unit_lifecycle_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "hrm_absence_no_delete",
    config: [],
  },
  {
    name: "hrm_allowance_payroll_input_no_delete",
    config: [],
  },
  {
    name: "hrm_application_events_immutable",
    config: [],
  },
  {
    name: "hrm_benefit_award_event_no_delete",
    config: [],
  },
  {
    name: "hrm_benefit_award_no_delete",
    config: [],
  },
  {
    name: "hrm_benefit_enrollment_no_delete",
    config: [],
  },
  {
    name: "hrm_benefit_event_no_delete",
    config: [],
  },
  {
    name: "hrm_benefit_payroll_input_no_delete",
    config: [],
  },
  {
    name: "hrm_benefit_program_no_delete",
    config: [],
  },
  {
    name: "hrm_calibration_event_no_delete",
    config: [],
  },
  {
    name: "hrm_checklist_publication_guard",
    config: [],
  },
  {
    name: "hrm_checklist_version_immutable",
    config: [],
  },
  {
    name: "hrm_compensation_history_guard",
    config: [],
  },
  {
    name: "hrm_compensation_plans_guard",
    config: [],
  },
] as const;
