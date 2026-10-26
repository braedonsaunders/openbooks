/** Runtime attributes for explicitly governed guards. */
export const EXPLICIT_GUARD_ATTRIBUTES = [
  { name: "source_retired_time_guard", config: ["search_path=public,pg_catalog"] },
  { name: "depreciation_source_authority_guard", config: ["search_path=public,pg_catalog"] },
  { name: "calibration_entry_published_guard", config: ["search_path=public,pg_catalog"] },
  {
    name: "subcontract_change_pending_terms_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "native_command_pending_terms_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "flow_submission_receipt_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "account_merge_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "fair_value_used_policy_guard",
    config: [],
  },
  {
    name: "hrm_benefit_program_revision_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_fulfillment_charge_immutable",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_fund_transfer_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_netting_line_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_netting_run_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_transaction_pair_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "intercompany_transfer_pricing_policy_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "journal_reversal_instruction_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_opening_employer_authority_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_opening_qualified_source_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_issued_event_source_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_reporting_evidence_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_separation_basis_reference_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_separation_facts_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_subsequent_service_source_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_roe_used_exclusion_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "rebate_agreement_guard",
    config: [],
  },
  {
    name: "rebate_claim_guard",
    config: [],
  },
  {
    name: "rebate_fact_immutable",
    config: [],
  },
  {
    name: "recognition_control_immutable",
    config: [],
  },
  {
    name: "renewal_policy_guard",
    config: [],
  },
  {
    name: "time_type_financial_semantics_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "field_ticket_source_certification_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "fx_revaluation_rate_evidence_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_ca_opening_reporting_authority_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_ca_opening_reporting_allocation_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_ca_opening_reporting_account_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_us_filing_account_lineage_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "payroll_opening_levy_opening_source_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_opening_levy_source_allocation_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "payroll_opening_levy_source_authority_guard",
    config: ["search_path=public,pg_catalog"],
  },
  {
    name: "historical_translation_basis_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "historical_translation_layer_guard",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "historical_translation_source_retention",
    config: ["search_path=pg_catalog,public"],
  },
  {
    name: "historical_translation_file_retention",
    config: ["search_path=pg_catalog,public"],
  },
] as const;
