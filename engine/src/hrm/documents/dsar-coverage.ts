import type { DsarModule } from "./dsar.ts";

/**
 * C-79 structural DSAR coverage: the personal-data inventory for HR
 * subject-access exports, derived from the live schema rather than a
 * hand-kept module list.
 *
 * Every table in the HR remit (hrm_* plus the named employment, time and
 * pay tables below) that holds personal data about a party must appear
 * here exactly once: either gathered by a DSAR domain, or explicitly
 * excluded with a reviewed reason. `dsar-coverage.integration.test.ts`
 * discovers person-linked tables from information_schema and fails when
 * one has neither, so a new personal-data table cannot land without a
 * coverage decision.
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
  { table: "worker_employments", domain: "employments", linkage: "direct" },
  { table: "worker_employment_versions", domain: "employments", linkage: "transitive" },
  { table: "employment_assignments", domain: "employments", linkage: "transitive" },
  { table: "employment_assignment_versions", domain: "employments", linkage: "transitive" },
  { table: "employment_changes", domain: "employments", linkage: "direct" },
  { table: "hrm_exit_records", domain: "employments", linkage: "direct" },
  { table: "hrm_compliance_findings", domain: "employments", linkage: "direct" },
  { table: "hrm_employment_classifications", domain: "employments", linkage: "direct" },
  { table: "hrm_processes", domain: "employments", linkage: "direct" },
  { table: "hrm_employment_change_requests", domain: "change_requests", linkage: "direct" },
  { table: "hrm_leave_requests", domain: "leave", linkage: "direct" },
  { table: "hrm_absences", domain: "leave", linkage: "direct" },
  { table: "time_entries", domain: "time", linkage: "direct" },
  { table: "hrm_reviews", domain: "reviews", linkage: "direct" },
  { table: "hrm_review_answers", domain: "reviews", linkage: "transitive" },
  { table: "hrm_goals", domain: "reviews", linkage: "direct" },
  { table: "hrm_goal_updates", domain: "reviews", linkage: "transitive" },
  { table: "hrm_succession_candidates", domain: "reviews", linkage: "direct" },
  { table: "hrm_talent_reviews", domain: "reviews", linkage: "direct" },
  { table: "hrm_benefit_enrollments", domain: "benefits", linkage: "direct" },
  { table: "hrm_benefit_dependents", domain: "benefits", linkage: "direct" },
  { table: "hrm_documents", domain: "documents", linkage: "direct" },
  { table: "pay_stubs", domain: "payroll", linkage: "direct" },
  { table: "pay_stub_lines", domain: "payroll", linkage: "transitive" },
  { table: "hrm_allowance_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "hrm_benefit_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "hrm_payroll_inputs", domain: "payroll", linkage: "direct" },
  { table: "hrm_per_diem_entries", domain: "payroll", linkage: "direct" },
  { table: "hrm_travel_pay_entries", domain: "payroll", linkage: "direct" },
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
];

/**
 * Person-link columns the coverage discovery uses: any remit table carrying
 * one is personal data about somebody until the registry says otherwise.
 */
export const DSAR_PERSON_LINK_COLUMNS: readonly string[] = [
  "party_id",
  "worker_party_id",
  "employee_party_id",
  "subject_party_id",
  "reviewer_party_id",
  "interviewer_party_id",
  "candidate_id",
  "employment_id",
];

/**
 * HR remit for the derived coverage test: the tables a subject-access
 * export can reasonably cover. Finance, CRM, vendor and platform tables
 * with party links live outside the HR export and are enforced by their
 * own inventories.
 */
export const DSAR_REMIT_TABLE_PATTERN = "hrm_%";

export const DSAR_REMIT_EXTRA_TABLES: readonly string[] = [
  "parties",
  "worker_employments",
  "worker_employment_versions",
  "employment_assignments",
  "employment_assignment_versions",
  "employment_changes",
  "time_entries",
  "time_clock_events",
  "pay_stubs",
  "pay_stub_lines",
  // Named so the worker_clock_pins exclusion below is enforced rather than
  // silently droppable: the table carries a person link but is credential
  // material, never exportable personal data.
  "worker_clock_pins",
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
