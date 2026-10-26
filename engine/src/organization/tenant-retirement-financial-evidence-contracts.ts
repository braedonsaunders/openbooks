/** Trigger contracts for financial source evidence. */
export const FINANCIAL_EVIDENCE_TRIGGER_CONTRACTS = [
  {
    table: "field_ticket_source_certifications",
    trigger: "field_ticket_source_certification_guard",
    function: "field_ticket_source_certification_guard",
  },
  {
    table: "fx_revaluation_rate_evidence",
    trigger: "fx_revaluation_rate_evidence_guard",
    function: "fx_revaluation_rate_evidence_guard",
  },
  {
    table: "payroll_ca_opening_reporting_authorities",
    trigger: "payroll_ca_opening_reporting_authority_guard",
    function: "payroll_ca_opening_reporting_authority_guard",
  },
  {
    table: "payroll_ca_opening_reporting_allocations",
    trigger: "payroll_ca_opening_reporting_allocation_guard",
    function: "payroll_ca_opening_reporting_allocation_guard",
  },
  {
    table: "payroll_filing_accounts",
    trigger: "payroll_ca_opening_reporting_account_guard",
    function: "payroll_ca_opening_reporting_account_guard",
  },
  {
    table: "payroll_us_filing_account_employer_lineage",
    trigger: "payroll_us_filing_account_lineage_guard",
    function: "payroll_us_filing_account_lineage_guard",
  },
  {
    table: "payroll_opening_balance_components",
    trigger: "payroll_opening_levy_source_components_guard",
    function: "payroll_opening_levy_opening_source_guard",
  },
  {
    table: "payroll_opening_program_bases",
    trigger: "payroll_opening_levy_source_program_bases_guard",
    function: "payroll_opening_levy_opening_source_guard",
  },
  {
    table: "payroll_opening_account_bases",
    trigger: "payroll_opening_levy_source_account_bases_guard",
    function: "payroll_opening_levy_opening_source_guard",
  },
  {
    table: "payroll_opening_sui_wages",
    trigger: "payroll_opening_levy_source_sui_wages_guard",
    function: "payroll_opening_levy_opening_source_guard",
  },
  {
    table: "payroll_opening_levy_source_allocations",
    trigger: "payroll_opening_levy_source_allocation_guard",
    function: "payroll_opening_levy_source_allocation_guard",
  },
  {
    table: "payroll_opening_levy_source_authorities",
    trigger: "payroll_opening_levy_source_authority_guard",
    function: "payroll_opening_levy_source_authority_guard",
  },
  {
    table: "journal_lines",
    trigger: "historical_translation_line_retention",
    function: "historical_translation_source_retention",
  },
  {
    table: "journal_entries",
    trigger: "historical_translation_entry_retention",
    function: "historical_translation_source_retention",
  },
  {
    table: "file_versions",
    trigger: "historical_translation_version_retention",
    function: "historical_translation_file_retention",
  },
  {
    table: "file_blobs",
    trigger: "historical_translation_blob_retention",
    function: "historical_translation_file_retention",
  },
  {
    table: "historical_translation_contributions",
    trigger: "historical_translation_basis_guard",
    function: "historical_translation_basis_guard",
  },
  {
    table: "historical_translation_layers",
    trigger: "historical_translation_layer_guard",
    function: "historical_translation_layer_guard",
  },
] as const;
