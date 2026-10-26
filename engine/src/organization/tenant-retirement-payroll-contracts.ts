/** Trigger contracts for workforce and payroll records. */
export const PAYROLL_TRIGGER_CONTRACTS = [
  {
    table: "hrm_benefit_programs",
    trigger: "hrm_benefit_program_no_delete_trigger",
    function: "hrm_benefit_program_no_delete",
  },
  {
    table: "hrm_benefit_awards",
    trigger: "hrm_benefit_award_no_delete_trigger",
    function: "hrm_benefit_award_no_delete",
  },
  {
    table: "hrm_benefit_award_events",
    trigger: "hrm_benefit_award_event_no_delete_trigger",
    function: "hrm_benefit_award_event_no_delete",
  },
  {
    table: "crm_sales_evidence",
    trigger: "sales_evidence_immutable",
    function: "sales_evidence_immutable",
  },
  {
    table: "crm_sales_territory_versions",
    trigger: "sales_territory_version_immutable",
    function: "sales_evidence_immutable",
  },
  {
    table: "crm_sales_quotas",
    trigger: "sales_quota_version_guard",
    function: "sales_quota_version_guard",
  },
  {
    table: "data_transfer_chunks",
    trigger: "data_transfer_chunks_evidence_guard",
    function: "data_transfer_evidence_guard",
  },
  {
    table: "data_transfer_rows",
    trigger: "data_transfer_rows_evidence_guard",
    function: "data_transfer_evidence_guard",
  },
  {
    table: "data_transfer_events",
    trigger: "data_transfer_events_evidence_guard",
    function: "data_transfer_evidence_guard",
  },
  {
    table: "hrm_benefit_recovery_sources",
    trigger: "benefit_recovery_source_trigger",
    function: "benefit_recovery_source_guard",
  },
  {
    table: "hrm_benefit_contribution_rules",
    trigger: "benefit_rule_history_trigger",
    function: "benefit_recurring_history_guard",
  },
  {
    table: "hrm_benefit_enrollment_terms",
    trigger: "benefit_term_history_trigger",
    function: "benefit_recurring_history_guard",
  },
  {
    table: "hrm_benefit_contribution_tiers",
    trigger: "benefit_tier_history_trigger",
    function: "benefit_recurring_history_guard",
  },
  {
    table: "pay_run_benefit_allocations",
    trigger: "benefit_allocation_history_trigger",
    function: "benefit_recurring_history_guard",
  },
  {
    table: "hrm_benefit_contribution_classes",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "hrm_benefit_contribution_tiers",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "hrm_benefit_contribution_rules",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "hrm_benefit_recovery_sources",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "hrm_benefit_enrollment_terms",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "pay_run_benefit_allocations",
    trigger: "benefit_recurring_audit_trigger",
    function: "benefit_recurring_audit",
  },
  {
    table: "hrm_benefit_contribution_classes",
    trigger: "benefit_recurring_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_contribution_tiers",
    trigger: "benefit_recurring_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_contribution_rules",
    trigger: "benefit_recurring_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_recovery_sources",
    trigger: "benefit_recurring_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_enrollment_terms",
    trigger: "benefit_recurring_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_enrollments",
    trigger: "benefit_enrollment_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "hrm_benefit_plans",
    trigger: "benefit_plan_configuration_lock_trigger",
    function: "benefit_recurring_configuration_lock",
  },
  {
    table: "payroll_vacation_terms",
    trigger: "payroll_vacation_terms_history",
    function: "payroll_service_configuration_guard",
  },
  {
    table: "payroll_service_credits",
    trigger: "payroll_service_credits_history",
    function: "payroll_service_configuration_guard",
  },
  {
    table: "entitlement_service_tiers",
    trigger: "entitlement_service_tiers_history",
    function: "payroll_service_configuration_guard",
  },
  {
    table: "payroll_vacation_terms",
    trigger: "payroll_vacation_terms_audit",
    function: "payroll_service_configuration_audit",
  },
  {
    table: "payroll_service_credits",
    trigger: "payroll_service_credits_audit",
    function: "payroll_service_configuration_audit",
  },
  {
    table: "entitlement_service_tiers",
    trigger: "entitlement_service_tiers_audit",
    function: "payroll_service_configuration_audit",
  },
  {
    table: "hrm_process_template_versions",
    trigger: "hrm_checklist_version_immutable",
    function: "hrm_checklist_version_immutable",
  },
  {
    table: "hrm_process_template_steps",
    trigger: "hrm_checklist_step_publication_guard",
    function: "hrm_checklist_publication_guard",
  },
  {
    table: "hrm_benefit_catalog",
    trigger: "benefit_catalog_identity_guard_trigger",
    function: "benefit_catalog_identity_guard",
  },
  {
    table: "document_tenders",
    trigger: "document_tender_lifecycle",
    function: "document_tender_lifecycle_guard",
  },
  {
    table: "stored_value_entries",
    trigger: "stored_value_entries_immutable_trigger",
    function: "stored_value_entries_immutable",
  },
  {
    table: "contract_cost_amortization",
    trigger: "contract_cost_amortization_immutable_trigger",
    function: "contract_cost_amortization_immutable",
  },
  {
    table: "document_supply_evidence",
    trigger: "document_supply_evidence_guard",
    function: "document_supply_evidence_guard",
  },
  {
    table: "fx_rate_age_policies",
    trigger: "fx_rate_age_policy_history_guard",
    function: "fx_rate_age_policy_history_guard",
  },
  {
    table: "payroll_compensation_calculations",
    trigger: "payroll_compensation_calculation_history",
    function: "payroll_compensation_calculation_guard",
  },
  {
    table: "payroll_compensation_packages",
    trigger: "payroll_compensation_configuration",
    function: "payroll_compensation_configuration_guard",
  },
  {
    table: "payroll_compensation_versions",
    trigger: "payroll_compensation_configuration",
    function: "payroll_compensation_configuration_guard",
  },
  {
    table: "payroll_compensation_assignments",
    trigger: "payroll_compensation_configuration",
    function: "payroll_compensation_configuration_guard",
  },
  {
    table: "hrm_training_courses",
    trigger: "hrm_training_guard",
    function: "hrm_training_guard",
  },
  {
    table: "hrm_training_sessions",
    trigger: "hrm_training_guard",
    function: "hrm_training_guard",
  },
  {
    table: "hrm_training_participants",
    trigger: "hrm_training_guard",
    function: "hrm_training_guard",
  },
  {
    table: "hrm_training_feedback",
    trigger: "hrm_training_guard",
    function: "hrm_training_guard",
  },
  {
    table: "hrm_comp_cycles",
    trigger: "preserve_historical_compensation_cycle",
    function: "preserve_historical_compensation_cycle",
  },
  {
    table: "payroll_period_openings",
    trigger: "payroll_period_opening_guard",
    function: "payroll_period_opening_guard",
  },
  {
    table: "payroll_opening_balances",
    trigger: "payroll_annual_period_bounds_guard",
    function: "payroll_annual_period_bounds_guard",
  },
  {
    table: "payroll_opening_program_bases",
    trigger: "payroll_program_period_bounds_fence",
    function: "payroll_program_period_bounds_guard",
  },
  {
    table: "payroll_opening_program_bases",
    trigger: "payroll_program_period_bounds_guard",
    function: "payroll_program_period_bounds_guard",
  },
  {
    table: "org_business_calendars",
    trigger: "org_business_calendars_history_guard",
    function: "org_business_calendars_history_guard",
  },
  {
    table: "aging_bucket_policies",
    trigger: "aging_bucket_policies_history_guard",
    function: "aging_bucket_policies_history_guard",
  },
  {
    table: "payroll_employee_employer_assignments",
    trigger: "payroll_employee_employer_assignment_guard",
    function: "payroll_employee_employer_assignment_guard",
  },
] as const;
