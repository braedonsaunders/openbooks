/** Trigger contracts for protected financial records. */
export const RECORD_PROTECTION_TRIGGER_CONTRACTS = [
  {
    table: "account_translation_policies",
    trigger: "account_translation_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "accounting_book_account_maps",
    trigger: "accounting_book_account_map_guard",
    function: "accounting_book_account_map_guard",
  },
  {
    table: "accounting_book_currencies",
    trigger: "accounting_book_currency_guard",
    function: "accounting_book_currency_guard",
  },
  {
    table: "accounting_book_replication_runs",
    trigger: "accounting_book_replication_runs_immutable",
    function: "accounting_book_replication_run_immutable",
  },
  {
    table: "ap_capture_corrections",
    trigger: "ap_capture_corrections_append_only",
    function: "openbooks_guard_ap_capture_evidence",
  },
  {
    table: "ap_capture_events",
    trigger: "ap_capture_events_append_only",
    function: "openbooks_guard_ap_capture_evidence",
  },
  {
    table: "ap_capture_fields",
    trigger: "ap_capture_fields_append_only",
    function: "openbooks_guard_ap_capture_evidence",
  },
  {
    table: "ap_capture_runs",
    trigger: "ap_capture_runs_immutable",
    function: "openbooks_guard_finished_ap_capture_run",
  },
  {
    table: "book_entry_replications",
    trigger: "book_entry_replications_immutable",
    function: "multibook_evidence_immutable",
  },
  {
    table: "file_blobs",
    trigger: "ap_capture_source_blob_immutable",
    function: "openbooks_guard_ap_capture_source_blob",
  },
  {
    table: "files",
    trigger: "ap_capture_source_file_immutable",
    function: "openbooks_guard_ap_capture_source_file",
  },
  {
    table: "file_versions",
    trigger: "ap_capture_source_version_immutable",
    function: "openbooks_guard_ap_capture_source_version",
  },
  {
    table: "applications",
    trigger: "application_evidence_guard",
    function: "application_evidence_guard",
  },
  {
    table: "application_idempotency_keys",
    trigger: "application_idempotency_guard",
    function: "protect_application_idempotency_key",
  },
  {
    table: "applications",
    trigger: "application_open_balance",
    function: "trg_application_open_balance",
  },
  {
    table: "asset_events",
    trigger: "asset_event_append_only_guard",
    function: "asset_event_append_only_guard",
  },
  {
    table: "audit_log",
    trigger: "audit_log_append_only",
    function: "audit_log_append_only_guard",
  },
  {
    table: "bank_statement_lines",
    trigger: "bank_statement_line_guard",
    function: "openbooks_bank_statement_line_guard",
  },
  {
    table: "billing_request_field_tickets",
    trigger: "billing_request_field_ticket_guard",
    function: "billing_request_field_ticket_guard",
  },
  {
    table: "budget_lines",
    trigger: "budget_line_guard",
    function: "openbooks_guard_budget_line",
  },
  {
    table: "budget_scenarios",
    trigger: "budget_scenario_guard",
    function: "openbooks_guard_budget_scenario",
  },
  {
    table: "close_events",
    trigger: "close_events_append_only",
    function: "close_append_only_guard",
  },
  {
    table: "close_task_evidence",
    trigger: "close_evidence_append_only",
    function: "close_append_only_guard",
  },
  {
    table: "close_signoffs",
    trigger: "close_signoffs_append_only",
    function: "close_append_only_guard",
  },
  {
    table: "expense_fx_policies",
    trigger: "expense_fx_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "gl_audit_number_assignments",
    trigger: "gl_audit_number_assignments_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "gl_audit_number_policies",
    trigger: "gl_audit_number_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "project_loss_policies",
    trigger: "project_loss_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "segment_balancing_policies",
    trigger: "segment_balancing_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "subsidiary_accounting_preferences",
    trigger: "subsidiary_accounting_preferences_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "tax_country_pack_installations",
    trigger: "country_tax_pack_installation_guard",
    function: "protect_country_tax_pack_installation",
  },
  {
    table: "file_attachments",
    trigger: "depreciation_evidence_attachment_guard",
    function: "depreciation_evidence_attachment_guard",
  },
  {
    table: "depreciation_inputs",
    trigger: "depreciation_input_evidence_guard",
    function: "openbooks_guard_depreciation_evidence",
  },
  {
    table: "document_links",
    trigger: "document_correction_lineage_guard",
    function: "document_correction_lineage_guard",
  },
  {
    table: "document_line_tax_components",
    trigger: "document_line_tax_component_guard",
    function: "document_line_tax_component_guard",
  },
  {
    table: "dunning_log",
    trigger: "dunning_log_no_mutate",
    function: "dunning_log_guard",
  },
  {
    table: "entitlement_ledger",
    trigger: "entitlement_ledger_append_only",
    function: "entitlement_ledger_append_only_guard",
  },
  {
    table: "field_ticket_labor_lines",
    trigger: "field_ticket_labor_line_immutable",
    function: "field_ticket_labor_line_immutable_guard",
  },
  {
    table: "field_ticket_labor_snapshots",
    trigger: "field_ticket_labor_snapshot_retention",
    function: "field_ticket_labor_snapshot_retention_guard",
  },
  {
    table: "field_ticket_signatures",
    trigger: "field_ticket_signature_immutable",
    function: "field_ticket_signature_immutable_guard",
  },
  {
    table: "field_ticket_signature_requests",
    trigger: "field_ticket_signature_request_immutable",
    function: "field_ticket_signature_request_guard",
  },
  {
    table: "journal_entries",
    trigger: "gl_activity_entry",
    function: "openbooks_gl_activity_entry",
  },
  {
    table: "journal_lines",
    trigger: "gl_activity_line",
    function: "openbooks_gl_activity_line",
  },
  {
    table: "inventory_movements",
    trigger: "inv_move_guard",
    function: "inv_move_guard",
  },
  {
    table: "lots",
    trigger: "inventory_lot_identity_guard_trigger",
    function: "inventory_lot_identity_guard",
  },
  {
    table: "inventory_provisional_costs",
    trigger: "inventory_provisional_cost_delete",
    function: "inventory_provisional_immutable",
  },
  {
    table: "inventory_provisional_settlements",
    trigger: "inventory_provisional_settlement_immutable",
    function: "inventory_provisional_immutable",
  },
  {
    table: "serials",
    trigger: "inventory_serial_lifecycle_guard_trigger",
    function: "inventory_serial_lifecycle_guard",
  },
  {
    table: "item_rate_books",
    trigger: "item_rate_books_currency_guard",
    function: "rate_book_currency_guard",
  },
  {
    table: "item_rate_lines",
    trigger: "item_rate_lines_version_guard",
    function: "rate_version_child_guard",
  },
  {
    table: "item_rate_versions",
    trigger: "item_rate_versions_immutable",
    function: "rate_version_immutable",
  },
  {
    table: "journal_entries",
    trigger: "je_guard",
    function: "je_guard",
  },
  {
    table: "journal_lines",
    trigger: "jl_guard",
    function: "jl_guard",
  },
  {
    table: "labor_rate_adjustment_targets",
    trigger: "labor_rate_adjustment_targets_version_guard",
    function: "rate_adjustment_target_version_guard",
  },
  {
    table: "labor_rate_adjustments",
    trigger: "labor_rate_adjustments_version_guard",
    function: "rate_version_child_guard",
  },
  {
    table: "labor_rate_terms",
    trigger: "labor_rate_terms_version_guard",
    function: "rate_version_child_guard",
  },
  {
    table: "labor_rate_version_policies",
    trigger: "labor_rate_version_policies_version_guard",
    function: "rate_version_child_guard",
  },
  {
    table: "labor_rate_version_scopes",
    trigger: "labor_rate_version_scopes_version_guard",
    function: "rate_version_child_guard",
  },
  {
    table: "landed_cost_allocations",
    trigger: "landed_cost_allocation_guard_trigger",
    function: "landed_cost_allocation_guard",
  },
  {
    table: "landed_cost_vouchers",
    trigger: "landed_cost_voucher_guard_trigger",
    function: "landed_cost_voucher_guard",
  },
  {
    table: "landed_cost_voucher_targets",
    trigger: "landed_cost_voucher_target_guard_trigger",
    function: "landed_cost_voucher_target_guard",
  },
  {
    table: "lease_escalations",
    trigger: "lease_escalations_applied_append_only",
    function: "property_financial_evidence_guard",
  },
  {
    table: "pay_run_bank_files",
    trigger: "pay_run_bank_file_immutable",
    function: "openbooks_guard_pay_run_bank_file",
  },
  {
    table: "payment_events",
    trigger: "payment_event_immutable",
    function: "payment_event_immutable",
  },
  {
    table: "applications",
    trigger: "party_payment_stats_maintain",
    function: "openbooks_party_payment_stats",
  },
  {
    table: "applications",
    trigger: "open_item_balances_application",
    function: "openbooks_open_item_balances_application",
  },
  {
    table: "journal_lines",
    trigger: "open_item_balances_line",
    function: "openbooks_open_item_balances_line",
  },
  {
    table: "payment_run_items",
    trigger: "payment_run_item_guard",
    function: "payment_run_item_guard",
  },
  {
    table: "file_blobs",
    trigger: "payroll_bank_file_blob_immutable",
    function: "openbooks_guard_payroll_bank_file_blob",
  },
  {
    table: "files",
    trigger: "payroll_bank_file_file_immutable",
    function: "openbooks_guard_payroll_bank_file_file",
  },
  {
    table: "file_versions",
    trigger: "payroll_bank_file_version_immutable",
    function: "openbooks_guard_payroll_bank_file_version",
  },
  {
    table: "project_financial_adjustments",
    trigger: "project_financial_adjustment_guard",
    function: "project_financial_adjustment_guard",
  },
  {
    table: "project_financial_profile_versions",
    trigger: "project_financial_profile_version_guard",
    function: "project_financial_profile_version_guard",
  },
  {
    table: "project_overhead_adjustments",
    trigger: "project_overhead_adjustment_guard",
    function: "project_overhead_adjustment_guard",
  },
  {
    table: "reconciliation_matches",
    trigger: "reconciliation_match_guard",
    function: "openbooks_reconciliation_match_guard",
  },
  {
    table: "role_assignments",
    trigger: "role_assignments_active_user_guard",
    function: "enforce_deleted_role_assignment",
  },
  {
    table: "security_deposit_transactions",
    trigger: "security_deposits_append_only",
    function: "property_financial_evidence_guard",
  },
  {
    table: "segment_definitions",
    trigger: "segment_definition_guard",
    function: "segment_definition_guard",
  },
  {
    table: "subscription_amendments",
    trigger: "subscription_amendment_immutable",
    function: "subscription_amendment_immutable_guard",
  },
  {
    table: "subscription_period_invoices",
    trigger: "subscription_period_invoice_immutable",
    function: "subscription_period_invoice_immutable_guard",
  },
  {
    table: "subscription_plan_versions",
    trigger: "subscription_plan_version_immutable",
    function: "subscription_plan_version_immutable_guard",
  },
  {
    table: "subscription_plan_version_components",
    trigger: "subscription_version_component_immutable",
    function: "subscription_version_component_immutable_guard",
  },
  {
    table: "subsidiaries",
    trigger: "subsidiary_tree_guard",
    function: "subsidiary_tree_guard",
  },
  {
    table: "tax_filings",
    trigger: "tax_filing_immutable",
    function: "tax_filing_immutable_guard",
  },
  {
    table: "tax_provision_runs",
    trigger: "tax_provision_history_guard",
    function: "protect_tax_provision_history",
  },
  {
    table: "temporary_differences",
    trigger: "temporary_difference_history_guard",
    function: "protect_temporary_difference_history",
  },
  {
    table: "prebill_events",
    trigger: "prebill_event_append_only",
    function: "prebill_event_append_only_guard",
  },
  {
    table: "recurring_occurrence_documents",
    trigger: "recurring_occurrence_document_immutable",
    function: "recurring_occurrence_document_immutable_guard",
  },
] as const;
