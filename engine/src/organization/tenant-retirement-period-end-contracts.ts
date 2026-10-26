/** Trigger contracts for period-end and retained financial evidence. */
export const PERIOD_END_TRIGGER_CONTRACTS = [
  {
    table: "payroll_prior_earnings",
    trigger: "payroll_prior_earnings_guard",
    function: "payroll_prior_earnings_guard",
  },
  {
    table: "period_end_journal_policies",
    trigger: "period_end_journal_policy_guard",
    function: "period_end_journal_policy_guard",
  },
  {
    table: "period_end_journal_sets",
    trigger: "period_end_journal_set_guard",
    function: "period_end_journal_set_guard",
  },
  {
    table: "period_end_journal_entries",
    trigger: "period_end_journal_entry_guard",
    function: "period_end_journal_entry_guard",
  },
  {
    table: "expense_amortization_schedules",
    trigger: "expense_amortization_schedule_guard",
    function: "expense_amortization_schedule_guard",
  },
  {
    table: "expense_amortization_schedule_lines",
    trigger: "expense_amortization_line_guard",
    function: "expense_amortization_line_guard",
  },
  {
    table: "expense_amortization_schedule_events",
    trigger: "expense_amortization_event_guard",
    function: "expense_amortization_event_guard",
  },
  {
    table: "account_merges",
    trigger: "account_merge_immutable",
    function: "account_merge_immutable",
  },
  {
    table: "fair_value_prices",
    trigger: "fair_value_used_policy",
    function: "fair_value_used_policy_guard",
  },
  {
    table: "hrm_benefit_program_revisions",
    trigger: "hrm_benefit_program_revision_immutable",
    function: "hrm_benefit_program_revision_immutable",
  },
  {
    table: "intercompany_fulfillment_charges",
    trigger: "intercompany_fulfillment_charge_immutable",
    function: "intercompany_fulfillment_charge_immutable",
  },
  {
    table: "intercompany_fund_transfers",
    trigger: "intercompany_fund_transfer_guard",
    function: "intercompany_fund_transfer_guard",
  },
  {
    table: "intercompany_netting_lines",
    trigger: "intercompany_netting_line_guard",
    function: "intercompany_netting_line_guard",
  },
  {
    table: "intercompany_netting_runs",
    trigger: "intercompany_netting_run_guard",
    function: "intercompany_netting_run_guard",
  },
  {
    table: "intercompany_transaction_pairs",
    trigger: "intercompany_transaction_pair_guard",
    function: "intercompany_transaction_pair_guard",
  },
  {
    table: "intercompany_transfer_pricing_policies",
    trigger: "intercompany_transfer_pricing_policy_guard",
    function: "intercompany_transfer_pricing_policy_guard",
  },
  {
    table: "journal_reversal_instructions",
    trigger: "journal_reversal_instruction_guard",
    function: "journal_reversal_instruction_guard",
  },
  {
    table: "payroll_opening_balances",
    trigger: "payroll_opening_qualified_source_guard",
    function: "payroll_opening_qualified_source_guard",
  },
  {
    table: "payroll_opening_employer_authorities",
    trigger: "payroll_opening_employer_authority_guard",
    function: "payroll_opening_employer_authority_guard",
  },
  {
    table: "payroll_roe_historical_periods",
    trigger: "payroll_roe_historical_periods_guard",
    function: "payroll_roe_reporting_evidence_guard",
  },
  {
    table: "payroll_roe_issued_event_sources",
    trigger: "payroll_roe_issued_event_source_guard",
    function: "payroll_roe_issued_event_source_guard",
  },
  {
    table: "payroll_roe_line_evidence",
    trigger: "payroll_roe_line_evidence_guard",
    function: "payroll_roe_reporting_evidence_guard",
  },
  {
    table: "payroll_roe_line_evidence",
    trigger: "payroll_roe_used_line_exclusion_guard",
    function: "payroll_roe_used_exclusion_guard",
  },
  {
    table: "payroll_roe_separation_events",
    trigger: "payroll_roe_separation_facts_guard",
    function: "payroll_roe_separation_facts_guard",
  },
  {
    table: "payroll_roe_separation_events",
    trigger: "payroll_roe_used_event_exclusion_guard",
    function: "payroll_roe_used_exclusion_guard",
  },
  {
    table: "payroll_roe_separation_payments",
    trigger: "payroll_roe_separation_payment_basis_reference_guard",
    function: "payroll_roe_separation_basis_reference_guard",
  },
  {
    table: "payroll_roe_subsequent_service_sources",
    trigger: "payroll_roe_subsequent_service_source_guard",
    function: "payroll_roe_subsequent_service_source_guard",
  },
  {
    table: "rebate_accruals",
    trigger: "rebate_accruals_immutable",
    function: "rebate_fact_immutable",
  },
  {
    table: "rebate_agreements",
    trigger: "rebate_agreement_guard",
    function: "rebate_agreement_guard",
  },
  {
    table: "rebate_claims",
    trigger: "rebate_claim_guard",
    function: "rebate_claim_guard",
  },
  {
    table: "rebate_cost_attestations",
    trigger: "rebate_costs_immutable",
    function: "rebate_fact_immutable",
  },
  {
    table: "rebate_settlement_reversals",
    trigger: "rebate_reversals_immutable",
    function: "rebate_fact_immutable",
  },
  {
    table: "recognition_control_events",
    trigger: "recognition_controls_immutable",
    function: "recognition_control_immutable",
  },
  {
    table: "subscription_renewal_occurrences",
    trigger: "renewal_occurrence_guard",
    function: "renewal_policy_guard",
  },
  {
    table: "subscription_renewal_policies",
    trigger: "renewal_policy_guard",
    function: "renewal_policy_guard",
  },
  {
    table: "time_types",
    trigger: "time_type_financial_semantics_guard",
    function: "time_type_financial_semantics_guard",
  },
] as const;
