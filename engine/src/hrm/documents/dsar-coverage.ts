import type { DsarModule } from "./dsar.ts";

/**
 * Structural DSAR coverage: the personal-data inventory for HR
 * subject-access exports, derived from the live schema rather than a
 * hand-kept module list.
 *
 * Every table with a person link — a foreign key to parties,
 * worker_employments or hrm_candidates on any column but the tenancy
 * link (orgs are party rows, so org_id references parties without the
 * row being about a person), or a *_party_id / *_employment_id /
 * candidate_id column where the catalog constrains nothing — must appear
 * here exactly once: either gathered by a DSAR domain, or explicitly
 * excluded with a reviewed reason. `dsar-coverage.integration.test.ts`
 * derives that surface from pg_constraint plus the name safety net and
 * fails when one has neither, so a new personal-data table cannot land
 * without a coverage decision.
 *
 * Exclusions are remit exclusions only (another module owns the data —
 * finance, CRM, vendor, ops, compliance, legal, platform — or the link is
 * actor-side / counterparty / credential material). Subject data always
 * ships with a gatherer in dsar.ts: the coverage test refuses any
 * gather-pending note, so the gap cannot reopen — a new personal-data
 * table lands gathered, or excluded with a reviewed remit reason.
 *
 * Linkage kinds:
 * - direct: the table carries its own subject/employment link and the
 *   domain gatherer reads it by that link;
 * - transitive: the table hangs off a gathered parent (application events
 *   under applications, answers under reviews) and the gatherer follows
 *   the chain — listed so the registry, not tribal knowledge, says so.
 */

export type DsarTableLinkage = "direct" | "transitive";

export interface DsarGatheredTable {
  table: string;
  domain: DsarModule;
  linkage: DsarTableLinkage;
}

export const DSAR_GATHERED_TABLES: readonly DsarGatheredTable[] = [
  { table: "parties", domain: "party", linkage: "direct" },
  { table: "addresses", domain: "party", linkage: "direct" },
  { table: "contacts", domain: "party", linkage: "direct" },
  { table: "worker_employments", domain: "employments", linkage: "direct" },
  { table: "worker_employment_versions", domain: "employments", linkage: "transitive" },
  { table: "employment_assignments", domain: "employments", linkage: "transitive" },
  { table: "employment_assignment_versions", domain: "employments", linkage: "transitive" },
  { table: "employment_changes", domain: "employments", linkage: "direct" },
  { table: "hrm_exit_records", domain: "employments", linkage: "direct" },
  { table: "hrm_compliance_findings", domain: "employments", linkage: "direct" },
  { table: "hrm_employment_classifications", domain: "employments", linkage: "direct" },
  { table: "hrm_processes", domain: "employments", linkage: "direct" },
  { table: "hrm_process_steps", domain: "employments", linkage: "transitive" },
  { table: "employee_roles", domain: "employments", linkage: "direct" },
  { table: "reporting_relationships", domain: "employments", linkage: "direct" },
  { table: "hrm_employment_change_requests", domain: "change_requests", linkage: "direct" },
  { table: "hrm_leave_requests", domain: "leave", linkage: "direct" },
  { table: "hrm_absences", domain: "leave", linkage: "direct" },
  { table: "entitlement_ledger", domain: "leave", linkage: "direct" },
  { table: "entitlement_plan_limits", domain: "leave", linkage: "direct" },
  { table: "time_entries", domain: "time", linkage: "direct" },
  { table: "res_assignments", domain: "time", linkage: "direct" },
  { table: "schedule_entries", domain: "time", linkage: "direct" },
  { table: "res_requests", domain: "time", linkage: "direct" },
  { table: "crew_time_batch_lines", domain: "time", linkage: "direct" },
  { table: "timesheet_weeks", domain: "time", linkage: "direct" },
  { table: "field_ticket_labor_lines", domain: "time", linkage: "direct" },
  { table: "hrm_shift_templates", domain: "time", linkage: "transitive" },
  { table: "hrm_shift_assignments", domain: "time", linkage: "direct" },
  { table: "hrm_shift_publications", domain: "time", linkage: "transitive" },
  { table: "hrm_shifts", domain: "time", linkage: "direct" },
  { table: "hrm_shift_requests", domain: "time", linkage: "direct" },
  { table: "hrm_attendance_identities", domain: "time", linkage: "direct" },
  { table: "hrm_attendance_events", domain: "time", linkage: "direct" },
  { table: "hrm_attendance_observations", domain: "time", linkage: "direct" },
  { table: "hrm_attendance_event_claims", domain: "time", linkage: "transitive" },
  { table: "hrm_attendance_observation_events", domain: "time", linkage: "transitive" },
  { table: "hrm_reviews", domain: "reviews", linkage: "direct" },
  { table: "hrm_review_answers", domain: "reviews", linkage: "transitive" },
  { table: "hrm_goals", domain: "reviews", linkage: "direct" },
  { table: "hrm_goal_updates", domain: "reviews", linkage: "transitive" },
  { table: "hrm_succession_candidates", domain: "reviews", linkage: "direct" },
  { table: "hrm_feedback", domain: "reviews", linkage: "direct" },
  { table: "hrm_one_on_ones", domain: "reviews", linkage: "direct" },
  { table: "hrm_one_on_one_items", domain: "reviews", linkage: "transitive" },
  { table: "hrm_succession_plans", domain: "reviews", linkage: "direct" },
  { table: "hrm_talent_reviews", domain: "reviews", linkage: "direct" },
  { table: "hrm_benefit_enrollments", domain: "benefits", linkage: "direct" },
  { table: "hrm_benefit_enrollment_terms", domain: "benefits", linkage: "transitive" },
  { table: "hrm_benefit_program_members", domain: "benefits", linkage: "direct" },
  { table: "hrm_benefit_transaction_responsibilities", domain: "benefits", linkage: "direct" },
  { table: "hrm_benefit_awards", domain: "benefits", linkage: "direct" },
  { table: "hrm_benefit_award_events", domain: "benefits", linkage: "transitive" },
  { table: "hrm_benefit_dependents", domain: "benefits", linkage: "direct" },
  { table: "hrm_documents", domain: "documents", linkage: "direct" },
  { table: "hrm_document_signers", domain: "documents", linkage: "direct" },
  { table: "pay_stubs", domain: "payroll", linkage: "direct" },
  { table: "pay_stub_lines", domain: "payroll", linkage: "transitive" },
  { table: "hrm_allowance_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "hrm_benefit_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "hrm_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "employee_tax_certificates", domain: "payroll", linkage: "direct" },
  { table: "employee_payroll_profiles", domain: "payroll", linkage: "direct" },
  { table: "payroll_service_credits", domain: "payroll", linkage: "direct" },
  { table: "payroll_vacation_terms", domain: "payroll", linkage: "direct" },
  { table: "pay_run_benefit_allocations", domain: "payroll", linkage: "direct" },
  { table: "hrm_per_diem_entries", domain: "payroll", linkage: "direct" },
  { table: "hrm_travel_pay_entries", domain: "payroll", linkage: "direct" },
  { table: "payroll_work_location_allocations", domain: "payroll", linkage: "direct" },
  { table: "payroll_roe_separation_events", domain: "payroll", linkage: "direct" },
  { table: "payroll_roe_separation_payments", domain: "payroll", linkage: "transitive" },
  { table: "it_addizionali_opening_balances", domain: "payroll", linkage: "direct" },
  { table: "employee_pay_components", domain: "payroll", linkage: "direct" },
  { table: "payroll_opening_balances", domain: "payroll", linkage: "direct" },
  { table: "payroll_period_openings", domain: "payroll", linkage: "direct" },
  { table: "payroll_employee_employer_assignments", domain: "payroll", linkage: "direct" },
  { table: "payroll_opening_program_bases", domain: "payroll", linkage: "direct" },
  { table: "payroll_opening_account_bases", domain: "payroll", linkage: "direct" },
  { table: "payroll_prior_stubs", domain: "payroll", linkage: "direct" },
  { table: "payroll_retro_settlements", domain: "payroll", linkage: "direct" },
  { table: "payroll_parallel_findings", domain: "payroll", linkage: "direct" },
  { table: "payroll_anomaly_flags", domain: "payroll", linkage: "direct" },
  { table: "pay_run_adjustments", domain: "payroll", linkage: "direct" },
  { table: "pay_run_holiday_assertions", domain: "payroll", linkage: "direct" },
  { table: "labor_cost_rates", domain: "payroll", linkage: "direct" },
  { table: "work_schedules", domain: "payroll", linkage: "direct" },
  { table: "payroll_compensation_assignments", domain: "payroll", linkage: "direct" },
  { table: "payroll_compensation_calculations", domain: "payroll", linkage: "direct" },
  { table: "hrm_candidates", domain: "recruiting", linkage: "direct" },
  { table: "hrm_candidate_consents", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_applications", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_application_events", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_interviews", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_scorecards", domain: "recruiting", linkage: "direct" },
  { table: "hrm_scorecard_ratings", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_offers", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_offer_versions", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_talent_pool_members", domain: "recruiting", linkage: "transitive" },
  { table: "hrm_interview_panel", domain: "recruiting", linkage: "direct" },
  { table: "hrm_worker_qualifications", domain: "qualifications", linkage: "direct" },
  { table: "hrm_qualification_events", domain: "qualifications", linkage: "transitive" },
  { table: "hrm_training_participants", domain: "qualifications", linkage: "direct" },
  { table: "hrm_training_sessions", domain: "qualifications", linkage: "transitive" },
  { table: "hrm_training_courses", domain: "qualifications", linkage: "transitive" },
  { table: "hrm_training_feedback", domain: "qualifications", linkage: "transitive" },
  { table: "hrm_comp_statements", domain: "statements", linkage: "direct" },
  { table: "hrm_comp_cycle_lines", domain: "statements", linkage: "direct" },
  { table: "hrm_pay_information_requests", domain: "statements", linkage: "direct" },
  { table: "hrm_survey_invitations", domain: "surveys", linkage: "direct" },
  { table: "hrm_survey_responses", domain: "surveys", linkage: "direct" },
  { table: "time_clock_events", domain: "clock_events", linkage: "direct" },
  { table: "hrm_data_subject_exports", domain: "exports", linkage: "direct" },
];

export interface DsarExcludedTable {
  table: string;
  reason: string;
}

export const DSAR_EXCLUDED_TABLES: readonly DsarExcludedTable[] = [
  {
    table: "withholding_standings",
    reason: "a subcontractor's statutory withholding standing is a counterparty tax record; finance remit.",
  },
  {
    table: "withholding_deductions",
    reason: "statutory deductions from payments to a subcontractor are filed tax evidence; finance remit.",
  },
  {
    table: "withholding_enrollments",
    reason: "the tax authority a contractor remits to is a counterparty reference, not a personal record.",
  },
  {
    table: "customer_item_refs",
    reason: "customer product codes and item mappings are business reference data, not personal records.",
  },
  {
    table: "party_tax_ids",
    reason: "customer tax identifiers and their validation evidence are counterparty business records; finance remit.",
  },
  {
    table: "demand_item_policies",
    reason: "replenishment planning facts with a vendor counterparty link; vendor remit.",
  },
  {
    table: "promotions",
    reason: "merchant-authored discount offers are commercial configuration, not personal records.",
  },
  {
    table: "restocking_fee_policies",
    reason: "merchant-authored return fee rules are commercial configuration, not personal records.",
  },
  {
    table: "worker_clock_pins",
    reason:
      "salted one-way PIN credential hashes: authentication material, unusable " +
      "without the preimage, and exporting them would leak credential material " +
      "rather than personal data.",
  },
  // Remit exclusions: another module owns the data, the link is
  // actor-side or counterparty, or the payload is credential material.
  {
    table: "saas_metrics_fx_evidence",
    reason:
      "market-data FX observations for SaaS normalization under the finance " +
      "remit; rows carry no person link and are never HR file data.",
  },
  {
    table: "saas_metrics_normalization_requests",
    reason:
      "operator workflow rows under the finance control remit; requester and " +
      "approver are actor-side user identities, not subject records, and " +
      "attempt history lives in audit_log outside HR file data.",
  },
  {
    table: "party_bank_accounts",
    reason:
      "financial credential material (account_number_encrypted) under the " +
      "finance remit; bank detail is not HR file data.",
  },
  {
    table: "documents",
    reason:
      "finance-owned document store (invoices, bills, expenses); HR file " +
      "documents gather via hrm_documents. A subject-linked non-HR document " +
      "needs its own remit decision before inclusion.",
  },
  {
    table: "document_lines",
    reason:
      "same store as documents; employee_id lines are billing detail, not " +
      "HR file data.",
  },
  {
    table: "fulfillment_documents",
    reason:
      "same finance-owned document store as documents (pick lists and " +
      "shipments); the ship-to address snapshot follows its document's remit " +
      "decision.",
  },
  {
    table: "journal_lines",
    reason:
      "general ledger; finance remit. Payroll postings derive from gathered pay stubs.",
  },
  {
    table: "gifts",
    reason: "nonprofit contribution records; donor counterparty. Finance remit.",
  },
  {
    table: "pledges",
    reason: "nonprofit contribution records; donor counterparty. Finance remit.",
  },
  { table: "payment_cards", reason: "financial instruments; finance remit." },
  { table: "payment_instructions", reason: "financial instruments; finance remit." },
  { table: "payment_links", reason: "financial instruments; finance remit." },
  { table: "customer_payment_methods", reason: "stored payment tokens; finance remit." },
  { table: "autopay_enrollments", reason: "collection mandates; finance remit." },
  { table: "payment_mandates", reason: "financial instruments; finance remit." },
  { table: "subscription_usage_links", reason: "usage pricing config; customer counterparty." },
  { table: "subscriptions", reason: "recurring billing config; customer counterparty. Finance remit." },
  { table: "customer_billing_relationships", reason: "payer hierarchy config; customer counterparty. Finance remit." },
  { table: "consolidation_groups", reason: "consolidated billing config; customer counterparty. Finance remit." },
  { table: "stored_value_accounts", reason: "stored-value balances; customer counterparty. Finance remit." },
  { table: "channel_orders", reason: "storefront order records; customer counterparty. Finance remit." },
  { table: "channel_order_economics", reason: "per-line margin facts; customer counterparty via the order. Finance remit." },
  { table: "channel_order_economics_pending", reason: "margin restatement queue; order link only. Finance remit." },
  { table: "channel_ad_spend", reason: "imported marketing spend; no person link. Finance remit." },
  { table: "channel_order_events", reason: "storefront order events; customer counterparty. Finance remit." },
  { table: "channel_daily_summaries", reason: "aggregated storefront sales batches; no person link. Finance remit." },
  { table: "customer_portal_links", reason: "portal access tokens; customer counterparty. Finance remit." },
  { table: "customer_portal_events", reason: "portal action history; customer counterparty. Finance remit." },
  { table: "customer_portal_settings", reason: "portal configuration; no person link. Finance remit." },
  { table: "sales_channel_posting_policies", reason: "merchant posting configuration; no person link. Finance remit." },
  { table: "usage_prepaid_grants", reason: "prepaid balances; customer counterparty." },
  {
    table: "information_return_recipients",
    reason: "tax filing counterparties; tax remit.",
  },
  { table: "lien_waivers", reason: "construction legal instruments; legal remit." },
  {
    table: "fixed_assets",
    reason:
      "asset register; the custodian link is an assignment, not a subject " +
      "record. Asset remit.",
  },
  {
    table: "grants",
    reason: "grant awards; sponsor counterparty. Finance remit.",
  },
  {
    table: "functional_mappings",
    reason:
      "functional expense classification configuration; department and project mapping with actor attribution. Finance remit.",
  },
  {
    table: "property_leases",
    reason: "lease register; tenant link. Property remit.",
  },
  {
    table: "pay_components",
    reason:
      "component definitions; remittance_party_id names a counterparty payee, " +
      "not the subject.",
  },
  {
    table: "union_agreements",
    reason: "agreement config; remittance counterparty.",
  },
  {
    table: "customer_price_level_assignments",
    reason: "commercial config; customer counterparty.",
  },
  { table: "customer_roles", reason: "commercial config; customer counterparty." },
  {
    table: "item_price_schedules",
    reason: "pricing config; customer counterparty.",
  },
  {
    table: "item_rate_book_assignments",
    reason: "pricing config; customer counterparty.",
  },
  {
    table: "res_retainers",
    reason: "customer commercial record; its customer-party link is a counterparty reference.",
  },
  {
    table: "crm_account_profiles",
    reason: "CRM remit; account links are counterparties.",
  },
  { table: "crm_opportunities", reason: "CRM remit; account counterparty." },
  { table: "revenue_contracts", reason: "commercial contracts; customer counterparty." },
  {
    table: "contract_cost_assets",
    reason:
      "capitalized sales costs; the customer is a counterparty and the sales-rep link is commission attribution in the finance record, not HR file data.",
  },
  { table: "saas_metrics_monthly", reason: "derived revenue metrics; customer counterparty." },
  { table: "usage_records", reason: "usage evidence; customer counterparty." },
  { table: "subcontracts", reason: "vendor remit." },
  { table: "subcontract_payment_controls", reason: "vendor remit." },
  { table: "vendor_roles", reason: "vendor remit." },
  {
    table: "ap_capture_items",
    reason: "AP capture; vendor_candidate_id is a vendor counterparty.",
  },
  { table: "compliance_records", reason: "compliance module remit." },
  { table: "compliance_release_checks", reason: "compliance module remit." },
  { table: "compliance_waivers", reason: "compliance module remit." },
  {
    table: "projects",
    reason:
      "construction ops remit; customer counterparty, foreman/manager actor-side.",
  },
  {
    table: "field_tickets",
    reason:
      "construction billing documents; customer doc with foreman actor-side. Ops remit.",
  },
  { table: "field_ticket_policies", reason: "customer billing config. Ops remit." },
  {
    table: "crew_time_batches",
    reason: "foreman-side capture envelopes; ops time capture.",
  },
  { table: "prebill_lines", reason: "construction billing detail. Ops remit." },
  { table: "hrm_benefit_transaction_policies", reason: "Employer incentive policy configuration; dated subject responsibilities and awards are exported without other recipients or company source measurements." },
  { table: "hrm_benefit_transaction_items", reason: "Employer incentive policy configuration; dated subject responsibilities and awards are exported without other recipients or company source measurements." },
  { table: "hrm_benefit_transaction_positions", reason: "Employer incentive policy configuration; dated subject responsibilities and awards are exported without other recipients or company source measurements." },
  { table: "hrm_benefit_transaction_limits", reason: "Employer incentive policy configuration; dated subject responsibilities and awards are exported without other recipients or company source measurements." },
  { table: "hrm_benefit_programs", reason: "Employer policy configuration; the subject's memberships and award policy identity are exported." },
  { table: "hrm_benefit_program_sources", reason: "Employer financial account configuration; subject awards are exported without company ledger source snapshots." },
  { table: "hrm_benefit_program_scopes", reason: "Employer department and project measurement configuration; subject memberships and awards are exported." },
  {
    table: "hrm_benefit_plans",
    reason:
      "plan definitions; provider counterparty. The subject instances " +
      "(enrollments) gather.",
  },
  {
    table: "hrm_calibration_sessions",
    reason:
      "facilitator actor-side; the session is about ratees, not the " +
      "facilitator's record.",
  },
  {
    table: "hrm_comp_cycle_budgets",
    reason:
      "manager-side budget envelopes; outcomes gather via statements and lines.",
  },
  {
    table: "hrm_requisitions",
    reason: "hiring config; hiring-manager actor-side.",
  },
  {
    table: "hrm_process_template_versions",
    reason: "published process configuration; employee execution evidence stays on checklist instances.",
  },
  {
    table: "hrm_process_template_steps",
    reason: "template defaults; instances on subject processes are deferred above.",
  },
  {
    table: "party_subsidiaries",
    reason: "org membership administration; platform remit.",
  },
];

export interface DsarCoverageManifest {
  gathered: { module: string; status: string; detail?: string }[];
  excluded: { table: string; reason: string }[];
}

export function dsarCoverageManifest(
  gathered: { module: string; status: string; detail?: string }[],
): DsarCoverageManifest {
  return {
    gathered,
    excluded: DSAR_EXCLUDED_TABLES.map(({ table, reason }) => ({ table, reason })),
  };
}
