import type { DsarModule } from "./dsar.ts";

/**
 * C-79 structural DSAR coverage: the personal-data inventory for HR
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
 * Exclusions come in two honest kinds: remit exclusions (another module
 * owns the data — finance, CRM, vendor, ops, compliance, legal, platform —
 * or the link is actor-side / counterparty / credential material), and
 * gather-pending notes for subject data with no gatherer yet. A pending
 * note names the link and the required gatherer; it is a tracked gap,
 * not a silent omission.
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
  { table: "hrm_per_diem_entries", domain: "payroll", linkage: "direct" },
  { table: "hrm_travel_pay_entries", domain: "payroll", linkage: "direct" },
  { table: "payroll_work_location_allocations", domain: "payroll", linkage: "direct" },
  { table: "payroll_roe_separation_events", domain: "payroll", linkage: "direct" },
  { table: "payroll_roe_separation_payments", domain: "payroll", linkage: "transitive" },
  { table: "it_addizionali_opening_balances", domain: "payroll", linkage: "direct" },
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
    table: "worker_clock_pins",
    reason:
      "salted one-way PIN credential hashes: authentication material, unusable " +
      "without the preimage, and exporting them would leak credential material " +
      "rather than personal data.",
  },
  // SUBJECT DATA — gatherer pending. Each note names the subject link and
  // the required gatherer; these are tracked gaps, not silent omissions.
  {
    table: "employee_pay_components",
    reason:
      "SUBJECT DATA — gatherer pending: the subject's pay component values " +
      "(employee_party_id/employment_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_opening_balances",
    reason:
      "SUBJECT DATA — gatherer pending: YTD carry-ins " +
      "(employee_party_id/employment_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_prior_stubs",
    reason:
      "SUBJECT DATA — gatherer pending: pre-migration stub register " +
      "(employee_party_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_retro_settlements",
    reason:
      "SUBJECT DATA — gatherer pending: recomputation settlements " +
      "(employee_party_id/employment_id); quantified_source_snapshot needs " +
      "a secrecy review before inclusion. Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_parallel_findings",
    reason:
      "SUBJECT DATA — gatherer pending: parallel-run comparisons including " +
      "employee_name (employee_party_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_anomaly_flags",
    reason:
      "SUBJECT DATA — gatherer pending: run anomaly flags about the " +
      "subject's pay (employment_id, unconstrained). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_opening_program_bases",
    reason:
      "SUBJECT DATA — gatherer pending: program opening bases " +
      "(employee_party_id, unconstrained). Needs a payroll-domain gatherer.",
  },
  {
    table: "payroll_opening_account_bases",
    reason:
      "SUBJECT DATA — gatherer pending: filing-account-scoped YTD bases " +
      "(employee_party_id, unconstrained). Needs a payroll-domain gatherer.",
  },
  {
    table: "pay_run_adjustments",
    reason:
      "SUBJECT DATA — gatherer pending: per-employee run adjustments " +
      "(employee_party_id/employment_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "pay_run_holiday_assertions",
    reason:
      "SUBJECT DATA — gatherer pending: holiday assertions including " +
      "absent_without_consent (same links). Needs a payroll-domain gatherer.",
  },
  {
    table: "labor_cost_rates",
    reason:
      "SUBJECT DATA — gatherer pending: the subject's costing rate " +
      "(employee_party_id). Needs a payroll-domain gatherer.",
  },
  {
    table: "work_schedules",
    reason:
      "SUBJECT DATA — gatherer pending: the subject's schedule pattern " +
      "(employee_party_id). Needs a payroll/time-domain gatherer.",
  },
  {
    table: "crew_time_batch_lines",
    reason:
      "SUBJECT DATA — gatherer pending: crew time records " +
      "(employee_party_id). Needs a time-domain gatherer; envelopes stay " +
      "foreman-side (see crew_time_batches).",
  },
  {
    table: "field_ticket_labor_lines",
    reason:
      "SUBJECT DATA — gatherer pending behind a field-ticket remit " +
      "decision: lines name the employee, but the parent ticket is a " +
      "customer billing document outside the HR remit.",
  },
  {
    table: "timesheet_weeks",
    reason:
      "SUBJECT DATA — gatherer pending: approval envelopes " +
      "(employee_party_id, unconstrained) over gathered time_entries. " +
      "Needs a time-domain gatherer.",
  },
  // Remit exclusions: another module owns the data, the link is
  // actor-side or counterparty, or the payload is credential material.
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
    table: "journal_lines",
    reason:
      "general ledger; finance remit. Payroll postings derive from gathered pay stubs.",
  },
  { table: "payment_cards", reason: "financial instruments; finance remit." },
  { table: "payment_instructions", reason: "financial instruments; finance remit." },
  { table: "payment_links", reason: "financial instruments; finance remit." },
  { table: "payment_mandates", reason: "financial instruments; finance remit." },
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
    table: "crm_account_profiles",
    reason: "CRM remit; account links are counterparties.",
  },
  { table: "crm_opportunities", reason: "CRM remit; account counterparty." },
  { table: "revenue_contracts", reason: "commercial contracts; customer counterparty." },
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
  { table: "wip_prebill_lines", reason: "construction billing detail. Ops remit." },
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
