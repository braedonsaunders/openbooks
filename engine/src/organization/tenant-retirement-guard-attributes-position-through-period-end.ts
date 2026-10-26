/** Runtime attributes for position through period-end guards. */
export const POSITION_THROUGH_PERIOD_END_GUARD_ATTRIBUTES = [
  {
    name: "position_changes_immutable_guard",
    config: [],
  },
  {
    name: "position_versions_closure_guard",
    config: [],
  },
  {
    name: "preserve_historical_compensation_cycle",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "primary_book_history_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "project_delivery_evidence_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "project_financial_adjustment_guard",
    config: [],
  },
  {
    name: "project_financial_profile_version_guard",
    config: [],
  },
  {
    name: "project_overhead_adjustment_guard",
    config: [],
  },
  {
    name: "property_financial_evidence_guard",
    config: [],
  },
  {
    name: "protect_application_idempotency_key",
    config: [],
  },
  {
    name: "protect_country_tax_pack_installation",
    config: [],
  },
  {
    name: "protect_org_base_price_level",
    config: [],
  },
  {
    name: "protect_pricing_customer_role",
    config: [],
  },
  {
    name: "protect_tax_provision_history",
    config: [],
  },
  {
    name: "protect_temporary_difference_history",
    config: [],
  },
  {
    name: "provision_identity_guard",
    config: [],
  },
  {
    name: "rate_adjustment_target_version_guard",
    config: [],
  },
  {
    name: "rate_book_currency_guard",
    config: [],
  },
  {
    name: "rate_version_child_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "rate_version_immutable",
    config: [],
  },
  {
    name: "recognition_revision_history_guard",
    config: [],
  },
  {
    name: "recurring_occurrence_document_immutable_guard",
    config: [],
  },
  {
    name: "reporting_relationships_closure_guard",
    config: [],
  },
  {
    name: "saas_metrics_fx_evidence_guard",
    config: [],
  },
  {
    name: "saas_metrics_normalization_request_guard",
    config: [],
  },
  {
    name: "sales_evidence_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "sales_quota_version_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_boards_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_codes_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_distribution_snapshot_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_entries_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_roster_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_attendance_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "service_record_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "service_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "schedule_source_records_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "scheduler_outbox_terminal_audit_append_only_guard",
    config: [],
  },
  {
    name: "segment_definition_guard",
    config: [],
  },
  {
    name: "segment_values_clear_default_for_wipe",
    config: [],
  },
  {
    name: "stored_value_entries_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "subscription_amendment_immutable_guard",
    config: [],
  },
  {
    name: "subscription_period_invoice_immutable_guard",
    config: [],
  },
  {
    name: "subscription_plan_version_immutable_guard",
    config: [],
  },
  {
    name: "subscription_version_component_immutable_guard",
    config: [],
  },
  {
    name: "subsidiary_tree_guard",
    config: [],
  },
  {
    name: "tax_filing_immutable_guard",
    config: [],
  },
  {
    name: "trg_application_open_balance",
    config: [],
  },
  {
    name: "trg_journal_line_open_balance",
    config: [],
  },
  {
    name: "usage_prepaid_draws_append_only_guard",
    config: [],
  },
  {
    name: "usage_rating_bands_draft_only_guard",
    config: [],
  },
  {
    name: "usage_rating_published_immutable_guard",
    config: [],
  },
  {
    name: "warehouse_execution_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "warehouse_execution_task_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "prebill_event_append_only_guard",
    config: [],
  },
  {
    name: "withholding_deductions_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "withholding_returns_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "worker_employment_versions_closure_guard",
    config: [],
  },
  {
    name: "inventory_inspection_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "inventory_inspection_plan_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "manufacturing_completion_trace_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "manufacturing_loss_event_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "manufacturing_routing_operation_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "manufacturing_snapshot_configuration_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "operating_profile_version_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_bom_revision_complete_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_bom_revision_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_mrp_run_evidence_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_subcontract_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_subcontract_material_return_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_subcontract_return_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_subcontract_service_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_subcontract_shipment_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "production_time_history_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_prior_earnings_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "period_end_journal_policy_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "period_end_journal_set_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "period_end_journal_entry_guard",
    config: ["search_path=public,pg_catalog"],
  },
] as const;
