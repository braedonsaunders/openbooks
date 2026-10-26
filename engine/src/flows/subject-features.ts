import { DOC_KIND_FEATURE } from "../records/document-kind-features.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { DOCUMENT_FLOW_KINDS } from "./subject-profiles.ts";

/**
 * The Features switchboard keys a flow subject kind belongs to. A flow can
 * only be authored over a subject whose owning features are all enabled for
 * the organization; parent and prerequisite switches close over the
 * requirement graph through `featureEnabled`, so only the owning leaf is
 * named here. An empty list declares a core subject that is available
 * whenever Flows itself is on.
 *
 * Document kinds derive their gate from the document-kind feature registry
 * (DOC_KIND_FEATURE). Every other subject kind is classified explicitly
 * below; a registered kind with no classification is refused rather than
 * defaulted, and a registry test keeps the classification complete.
 */
const SUBJECT_KIND_FEATURES: Readonly<Record<string, readonly string[]>> = {
  // Order-cycle documents are produced only by converting an order: a sales
  // fulfillment ships a sales order, and a purchase receipt brings stock in
  // against a purchase order.
  sales_fulfillment: ["orders"],
  purchase_receipt: ["orders", "inventory"],

  // Core financial governance.
  close_reopen_request: [],
  financial_change: [],
  party_bank_account: [],
  outbound_payment_run: [],
  inbound_payment_run: [],
  sandbox_change_set: [],
  close_run: ["continuousClose"],
  close_task: ["continuousClose"],
  bank_reconciliation_sign_off: ["banking"],
  bank_reconciliation_review: ["banking"],
  payment_dispute_review: ["banking"],
  budget_scenario: ["budgets"],
  allocation_run: ["allocations"],
  intercompany_netting_run: ["intercompanyNetting"],
  fund_release: ["fundAccounting"],
  equity_action: ["equity"],

  // Sales, billing and supply chain.
  sales_quota: ["salesManagement"],
  metrics_normalization: ["saasMetrics"],
  customer_rebate_agreement: ["rebateManagement"],
  customer_rebate_claim: ["rebateManagement"],
  vendor_rebate_agreement: ["rebateManagement"],
  vendor_rebate_claim: ["rebateManagement"],
  stock_count: ["inventory"],
  work_order: ["manufacturing"],

  // Projects and construction.
  customer_change_order: ["projects"],
  customer_pay_application: ["projects"],
  prebill: ["preBilling"],
  resourcing_request: ["resourceRequests"],
  timesheet_week: ["timeTracking"],
  crew_time_batch: ["fieldTime"],
  subcontract: ["subcontracts"],
  subcontract_change_order: ["subcontracts"],
  vendor_pay_application: ["subcontracts"],
  compliance_certificate: ["subcontractorCompliance"],
  compliance_waiver: ["subcontractorCompliance"],
  service_visit_completion: ["serviceDispatch"],
  schedule_board: ["hrmShiftPlanning"],
  schedule_distribution: ["hrmShiftPlanning"],
  schedule_entry_request: ["hrmShiftPlanning"],
  schedule_publication: ["hrmShiftPlanning"],

  // People.
  hrm_employment_change_request: ["hrm"],
  hrm_leave_request: ["hrm"],
  hrm_process_step: ["hrm"],
  hrm_employment_migration_mapping: ["hrm"],
  employment_change_action: ["hrm"],
  hrm_benefit_award: ["hrm"],
  hrm_benefit_enrollment: ["hrm"],
  recruiting_offer: ["hrmRecruiting"],
  hrm_calibration_session: ["hrmPerformance"],
  training_course: ["hrmTraining"],
  hrm_comp_cycle: ["hrmCompensation"],
  compensation_cycle_line: ["hrmCompensation"],
  headcount_plan: ["hrmCompensation"],
  headcount_plan_line: ["hrmCompensation"],
  per_diem_entry: ["hrmConstructionCompliance"],
  travel_pay_entry: ["hrmConstructionCompliance"],
  compensation_package_version: ["compensationPackages"],
  compensation_package_assignment: ["compensationPackages"],
};

/** Subject kinds classified explicitly rather than derived from document kinds. */
export function classifiedFlowSubjectKinds(): readonly string[] {
  return Object.keys(SUBJECT_KIND_FEATURES);
}

/**
 * The feature keys a subject kind requires, or null when the kind has no
 * classification (an unknown kind is never available).
 */
export function flowSubjectFeatureKeys(subjectKind: string): readonly string[] | null {
  if (Object.hasOwn(SUBJECT_KIND_FEATURES, subjectKind)) return SUBJECT_KIND_FEATURES[subjectKind]!;
  if (!DOCUMENT_FLOW_KINDS.includes(subjectKind)) return null;
  const feature = DOC_KIND_FEATURE[subjectKind];
  return feature ? [feature] : [];
}

/** Pure availability check against an already-resolved feature state. */
export function flowSubjectAvailable(state: FeatureState, subjectKind: string): boolean {
  const keys = flowSubjectFeatureKeys(subjectKind);
  return keys !== null && keys.every((key) => featureEnabled(state, key));
}

/** A flow cannot be authored over a subject whose owning feature is switched off. */
export class FlowSubjectFeatureDisabledError extends Error {
  readonly code = "flow_subject_feature_disabled";
  constructor(
    readonly subjectKind: string,
    readonly feature: string | null,
  ) {
    super(
      feature
        ? `Flows for ${subjectKind} records need the ${feature} feature, which is turned off for this organization.`
        : `Flows cannot be built for ${subjectKind} records.`,
    );
    this.name = "FlowSubjectFeatureDisabledError";
  }
}

/**
 * Recheck a subject kind's owning features inside the writer's transaction.
 * Each check takes the organization's feature row lock, so a concurrent
 * disable either commits first and refuses this write, or waits for it.
 */
export async function assertFlowSubjectFeaturesEnabled(
  runner: SqlExecutor,
  orgId: string,
  subjectKind: string,
): Promise<void> {
  const keys = flowSubjectFeatureKeys(subjectKind);
  if (keys === null) throw new FlowSubjectFeatureDisabledError(subjectKind, null);
  for (const key of keys) {
    if (!(await lockAndCheckOrgFeature(runner, orgId, key)))
      throw new FlowSubjectFeatureDisabledError(subjectKind, key);
  }
}
