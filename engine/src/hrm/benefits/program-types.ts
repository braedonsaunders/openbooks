/**
 * Shared employer-defined benefit program and award vocabulary.
 *
 * The value lists live once in @openbooks/schema/src/benefits-programs.ts
 * beside the tables they constrain; this module re-exports them so domain,
 * calculation, and API layers share one vocabulary without a second source
 * of truth. Existing insured benefit plans (hrm_benefit_plans) stay
 * authoritative for health and retirement; these types describe the separate
 * employer-defined program model (rewards, allowances, incentives, custom)
 * stored in hrm_benefit_programs and delivered through payroll inputs or a
 * recorded external reference.
 */
import {
  BENEFIT_AWARD_STATUSES as SCHEMA_AWARD_STATUSES,
  BENEFIT_PROGRAM_ALLOCATIONS as SCHEMA_ALLOCATIONS,
  BENEFIT_PROGRAM_APPROVAL_MODES as SCHEMA_APPROVAL_MODES,
  BENEFIT_PROGRAM_DELIVERY as SCHEMA_DELIVERY,
  BENEFIT_PROGRAM_FAMILIES as SCHEMA_FAMILIES,
  BENEFIT_PROGRAM_FREQUENCIES as SCHEMA_FREQUENCIES,
  BENEFIT_PROGRAM_METRICS as SCHEMA_METRICS,
  BENEFIT_PROGRAM_PERIOD_BASES as SCHEMA_PERIOD_BASES,
  BENEFIT_PROGRAM_SCOPES as SCHEMA_SCOPES,
  BENEFIT_PROGRAM_STATUSES as SCHEMA_STATUSES,
  BENEFIT_PROGRAM_VALUATION as SCHEMA_VALUATION,
} from "@openbooks/schema/src/benefits-programs.ts";

export const BENEFIT_APPROVAL_MODES = SCHEMA_APPROVAL_MODES;
export type BenefitApprovalMode = (typeof BENEFIT_APPROVAL_MODES)[number];

export const BENEFIT_PROGRAM_FAMILIES = SCHEMA_FAMILIES;
export type BenefitProgramFamily = (typeof BENEFIT_PROGRAM_FAMILIES)[number];

export const BENEFIT_PROGRAM_STATUSES = SCHEMA_STATUSES;
export type BenefitProgramStatus = (typeof BENEFIT_PROGRAM_STATUSES)[number];

export const BENEFIT_DELIVERY_METHODS = SCHEMA_DELIVERY;
export type BenefitDeliveryMethod = (typeof BENEFIT_DELIVERY_METHODS)[number];

export const BENEFIT_VALUATIONS = SCHEMA_VALUATION;
export type BenefitValuation = (typeof BENEFIT_VALUATIONS)[number];

export const BENEFIT_METRICS = SCHEMA_METRICS;
export type BenefitMetric = (typeof BENEFIT_METRICS)[number];

export const BENEFIT_METRIC_SCOPES = SCHEMA_SCOPES;
export type BenefitMetricScope = (typeof BENEFIT_METRIC_SCOPES)[number];

export const BENEFIT_ALLOCATIONS = SCHEMA_ALLOCATIONS;
export type BenefitAllocation = (typeof BENEFIT_ALLOCATIONS)[number];

export const BENEFIT_FREQUENCIES = SCHEMA_FREQUENCIES;
export type BenefitFrequency = (typeof BENEFIT_FREQUENCIES)[number];

export const BENEFIT_PERIOD_BASES = SCHEMA_PERIOD_BASES;
export type BenefitPeriodBasis = (typeof BENEFIT_PERIOD_BASES)[number];

export const BENEFIT_AWARD_STATUSES = SCHEMA_AWARD_STATUSES;
export type BenefitAwardStatus = (typeof BENEFIT_AWARD_STATUSES)[number];

/** Allowed program transitions. Closed programs never reopen. */
export const PROGRAM_STATUS_TRANSITIONS: Record<
  BenefitProgramStatus,
  readonly BenefitProgramStatus[]
> = {
  draft: ["active"],
  active: ["closed"],
  closed: [],
};

export interface BenefitProgram {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly family: BenefitProgramFamily;
  readonly description: string | null;
  readonly legalEntityId: string | null;
  readonly currency: string;
  readonly status: BenefitProgramStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly payComponentId: string | null;
  readonly approvalMode: BenefitApprovalMode;
  readonly deliveryMethod: BenefitDeliveryMethod;
  readonly valuation: BenefitValuation;
  readonly metric: BenefitMetric | null;
  readonly metricScope: BenefitMetricScope | null;
  readonly scopeIds: readonly string[];
  readonly allocation: BenefitAllocation;
  readonly percentRate: string | null;
  readonly fixedAmount: string | null;
  readonly capAmount: string | null;
  readonly budgetAmount: string | null;
  readonly thresholdAmount: string | null;
  readonly frequency: BenefitFrequency;
  readonly periodBasis: BenefitPeriodBasis | null;
  readonly paymentDelayDays: number;
  readonly revision: number;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
}

export interface BenefitProgramMember {
  readonly id: string;
  readonly programId: string;
  readonly employmentId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly weight: string | null;
  readonly role: string | null;
}

export interface BenefitAward {
  readonly id: string;
  readonly programId: string;
  readonly employmentId: string;
  readonly periodFrom: string;
  readonly periodTo: string | null;
  readonly value: string;
  readonly currency: string;
  readonly status: BenefitAwardStatus;
  readonly evidence: Record<string, unknown> | null;
  readonly sourceKey: string | null;
  readonly adjustsAwardId: string | null;
  readonly externalRef: string | null;
  readonly payRunDocumentId: string | null;
  readonly payRunAdjustmentId: string | null;
  /** Exact native input consumed by a live committed run; does not prove payment. */
  readonly payrollProcessed: boolean;
  readonly flowRunId: string | null;
  readonly submittedBy: string | null;
  readonly submittedAt: string | null;
  readonly decisionSnapshot: Record<string, unknown> | null;
  readonly approvalHref: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly createdBy: string | null;
  readonly voidReason: string | null;
}
