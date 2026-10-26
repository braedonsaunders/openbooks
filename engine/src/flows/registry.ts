import { nativeCommandSubjects, nativeCommandSubjectProfiles } from "./native-command-subjects.ts";
import {
  RECRUITING_OFFER_SUBJECT_KIND,
  recruitingOfferSubjectProfile,
  recruitingOffersFlowAdapter,
} from "./recruiting-offers-adapter.ts";
import {
  METRICS_NORMALIZATION_SUBJECT_KIND,
  metricsNormalizationSubjectProfile,
  metricsNormalizationFlowAdapter,
} from "./metrics-normalization-adapter.ts";
import {
  SALES_QUOTA_SUBJECT_KIND,
  salesQuotaSubjectProfile,
  salesQuotasFlowAdapter,
} from "./sales-quotas-adapter.ts";
import {
  STOCK_COUNT_SUBJECT_KIND,
  stockCountSubjectProfile,
  stockCountsFlowAdapter,
} from "./stock-counts-adapter.ts";
import {
  CLOSE_REOPEN_SUBJECT_KIND,
  closeReopenRequestsFlowAdapter,
  closeReopenSubjectProfile,
} from "./close-reopen-requests-adapter.ts";
import {
  scheduleBoardsFlowAdapter,
  scheduleBoardSubjectProfile,
} from "./schedule-board-adapter.ts";
import {
  SCHEDULE_DISTRIBUTION_SUBJECT_KIND,
  scheduleDistributionSubjectProfile,
  scheduleDistributionsFlowAdapter,
} from "./schedule-distribution-adapter.ts";
import {
  SCHEDULE_REQUEST_SUBJECT_KIND,
  scheduleRequestSubjectProfile,
  scheduleRequestsFlowAdapter,
} from "./schedule-request-adapter.ts";
import {
  SCHEDULE_PUBLICATION_SUBJECT_KIND,
  schedulePublicationSubjectProfile,
  schedulePublicationsFlowAdapter,
} from "./schedule-publication-adapter.ts";
import {
  SERVICE_VISIT_COMPLETION_SUBJECT_KIND,
  serviceVisitCompletionSubjectProfile,
  serviceVisitCompletionsFlowAdapter,
} from "./service-visit-adapter.ts";
import { CHECKLIST_STEP_SUBJECT_KIND } from "@openbooks/forms-core";
import {
  checklistStepsFlowAdapter,
  checklistStepSubjectProfile,
} from "./checklist-steps-adapter.ts";
import { BENEFIT_ENROLLMENT_SUBJECT_KIND } from "@openbooks/schema/src/hrm-benefits.ts";
import {
  benefitEnrollmentsFlowAdapter,
  benefitEnrollmentSubjectProfile,
} from "./benefit-enrollments-adapter.ts";
import { BENEFIT_AWARD_SUBJECT_KIND } from "@openbooks/schema/src/benefits-programs.ts";
import { benefitAwardsFlowAdapter, benefitAwardSubjectProfile } from "./benefit-awards-adapter.ts";
import {
  FINANCIAL_CHANGE_SUBJECT_KIND,
  financialChangeSubjectProfile,
  financialChangesFlowAdapter,
} from "./financial-changes-adapter.ts";
import type { FlowSubjectAdapter } from "./types.ts";
import { subjectSubsidiarySql } from "./subject-scope.ts";
import {
  EQUITY_ACTION_SUBJECT_KIND,
  equityActionSubjectProfile,
  equityActionsFlowAdapter,
} from "./equity-actions-adapter.ts";
import {
  COMPENSATION_VERSION_SUBJECT_KIND,
  COMPENSATION_ASSIGNMENT_SUBJECT_KIND,
} from "@openbooks/schema/src/payroll-compensation.ts";
import {
  compensationVersionsFlowAdapter,
  compensationAssignmentsFlowAdapter,
  compensationVersionSubjectProfile,
  compensationAssignmentSubjectProfile,
} from "./compensation-packages-adapter.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { DOCUMENT_FLOW_KINDS, documentSubjectProfile } from "./subject-profiles.ts";
import {
  BANK_ACCOUNT_SUBJECT_KIND,
  bankAccountSubjectProfile,
  bankAccountsFlowAdapter,
} from "./bank-accounts-adapter.ts";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import {
  BUDGET_SCENARIO_SUBJECT_KIND,
  budgetScenarioSubjectProfile,
  budgetScenariosFlowAdapter,
} from "./budget-scenarios-adapter.ts";
import {
  CLOSE_RUN_SUBJECT_KIND,
  closeRunSubjectProfile,
  closeRunsFlowAdapter,
} from "./close-runs-adapter.ts";
import {
  ALLOCATION_RUN_SUBJECT_KIND,
  allocationRunSubjectProfile,
  allocationRunsFlowAdapter,
} from "./allocation-runs-adapter.ts";
import {
  FUND_RELEASE_SUBJECT_KIND,
  fundReleaseSubjectProfile,
  fundReleasesFlowAdapter,
} from "./fund-releases-adapter.ts";
import {
  INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
  intercompanyNettingRunSubjectProfile,
  intercompanyNettingRunsFlowAdapter,
} from "./intercompany-netting-runs-adapter.ts";
import {
  FIELD_TICKET_SUBJECT_KIND,
  fieldTicketSubjectProfile,
  fieldTicketsFlowAdapter,
} from "./field-tickets-adapter.ts";
import {
  PAY_RUN_SUBJECT_KIND,
  payRunSubjectProfile,
  payRunsFlowAdapter,
} from "./pay-runs-adapter.ts";
import {
  INBOUND_PAYMENT_RUN_SUBJECT_KIND,
  inboundPaymentRunSubjectProfile,
  inboundPaymentRunsFlowAdapter,
  OUTBOUND_PAYMENT_RUN_SUBJECT_KIND,
  outboundPaymentRunSubjectProfile,
  outboundPaymentRunsFlowAdapter,
} from "./payment-runs-adapter.ts";
import {
  PREBILL_SUBJECT_KIND,
  prebillSubjectProfile,
  prebillsFlowAdapter,
} from "./prebills-adapter.ts";
import {
  TIMESHEET_WEEK_SUBJECT_KIND,
  timesheetWeekSubjectProfile,
  timesheetWeeksFlowAdapter,
} from "./timesheet-weeks-adapter.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import {
  hrmChangeRequestFlowAdapter,
  hrmChangeRequestSubjectProfile,
} from "./hrm-change-requests-adapter.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import {
  hrmLeaveRequestFlowAdapter,
  hrmLeaveRequestSubjectProfile,
} from "./leave-requests-adapter.ts";
import { RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/resourcing.ts";
import {
  resourcingRequestFlowAdapter,
  resourcingRequestSubjectProfile,
} from "./resourcing-requests-adapter.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { hrmCompCycleFlowAdapter, hrmCompCycleSubjectProfile } from "./comp-cycles-adapter.ts";
// Crew time batches approve through Flows.
import {
  CREW_TIME_BATCH_SUBJECT_KIND,
  crewBatchFlowAdapter,
  crewBatchSubjectProfile,
} from "./crew-batches-adapter.ts";
import {
  WORK_ORDER_SUBJECT_KIND,
  manufacturingFlowAdapter,
  workOrderSubjectProfile,
} from "./manufacturing-adapter.ts";
import {
  employmentMigrationFlowAdapter,
  employmentMigrationSubjectProfile,
} from "./employment-migration-adapter.ts";
import { HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND } from "@openbooks/schema/src/hrm.ts";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * subjectKind → FlowSubjectAdapter. The gate-resume path and every dispatch site rebuild
 * the right adapter from a stored subjectKind string. The documents adapter
 * covers every document kind; party_bank_account is the first non-document
 * subject; future adapters
 * (custom record types, …) register here.
 */

const adapterCache = new Map<string, FlowSubjectAdapter>();

export function getFlowAdapter(subjectKind: string): FlowSubjectAdapter | null {
  const commandSubject = nativeCommandSubjects.find(
    (adapter) => adapter.subjectKind === subjectKind,
  );
  if (commandSubject) return commandSubject;
  if (subjectKind === RECRUITING_OFFER_SUBJECT_KIND) return recruitingOffersFlowAdapter;
  if (subjectKind === METRICS_NORMALIZATION_SUBJECT_KIND) return metricsNormalizationFlowAdapter;
  if (subjectKind === SALES_QUOTA_SUBJECT_KIND) return salesQuotasFlowAdapter;
  if (subjectKind === STOCK_COUNT_SUBJECT_KIND) return stockCountsFlowAdapter;
  if (subjectKind === CLOSE_REOPEN_SUBJECT_KIND) return closeReopenRequestsFlowAdapter;
  if (subjectKind === "schedule_board") return scheduleBoardsFlowAdapter;
  if (subjectKind === COMPENSATION_VERSION_SUBJECT_KIND) return compensationVersionsFlowAdapter;
  if (subjectKind === COMPENSATION_ASSIGNMENT_SUBJECT_KIND)
    return compensationAssignmentsFlowAdapter;
  if (subjectKind === SCHEDULE_DISTRIBUTION_SUBJECT_KIND) return scheduleDistributionsFlowAdapter;
  if (subjectKind === SCHEDULE_REQUEST_SUBJECT_KIND) return scheduleRequestsFlowAdapter;
  if (subjectKind === SCHEDULE_PUBLICATION_SUBJECT_KIND) return schedulePublicationsFlowAdapter;
  if (subjectKind === SERVICE_VISIT_COMPLETION_SUBJECT_KIND)
    return serviceVisitCompletionsFlowAdapter;
  if (subjectKind === CHECKLIST_STEP_SUBJECT_KIND) return checklistStepsFlowAdapter;
  if (subjectKind === BENEFIT_ENROLLMENT_SUBJECT_KIND) return benefitEnrollmentsFlowAdapter;
  if (subjectKind === BENEFIT_AWARD_SUBJECT_KIND) return benefitAwardsFlowAdapter;
  if (subjectKind === FINANCIAL_CHANGE_SUBJECT_KIND) return financialChangesFlowAdapter;
  if (subjectKind === EQUITY_ACTION_SUBJECT_KIND) return equityActionsFlowAdapter;
  if (subjectKind === BANK_ACCOUNT_SUBJECT_KIND) return bankAccountsFlowAdapter;
  if (subjectKind === BUDGET_SCENARIO_SUBJECT_KIND) return budgetScenariosFlowAdapter;
  if (subjectKind === CLOSE_RUN_SUBJECT_KIND) return closeRunsFlowAdapter;
  if (subjectKind === ALLOCATION_RUN_SUBJECT_KIND) return allocationRunsFlowAdapter;
  if (subjectKind === FUND_RELEASE_SUBJECT_KIND) return fundReleasesFlowAdapter;
  if (subjectKind === INTERCOMPANY_NETTING_RUN_SUBJECT_KIND)
    return intercompanyNettingRunsFlowAdapter;
  if (subjectKind === FIELD_TICKET_SUBJECT_KIND) return fieldTicketsFlowAdapter;
  if (subjectKind === PREBILL_SUBJECT_KIND) return prebillsFlowAdapter;
  if (subjectKind === OUTBOUND_PAYMENT_RUN_SUBJECT_KIND) return outboundPaymentRunsFlowAdapter;
  if (subjectKind === INBOUND_PAYMENT_RUN_SUBJECT_KIND) return inboundPaymentRunsFlowAdapter;
  if (subjectKind === TIMESHEET_WEEK_SUBJECT_KIND) return timesheetWeeksFlowAdapter;
  if (subjectKind === HRM_CHANGE_REQUEST_SUBJECT_KIND) return hrmChangeRequestFlowAdapter;
  if (subjectKind === HRM_LEAVE_REQUEST_SUBJECT_KIND) return hrmLeaveRequestFlowAdapter;
  if (subjectKind === RESOURCING_REQUEST_SUBJECT_KIND) return resourcingRequestFlowAdapter;
  // Compensation cycles approve through Flows.
  if (subjectKind === HRM_COMP_CYCLE_SUBJECT_KIND) return hrmCompCycleFlowAdapter;
  // Crew time batches approve through Flows.
  if (subjectKind === CREW_TIME_BATCH_SUBJECT_KIND) return crewBatchFlowAdapter;
  if (subjectKind === WORK_ORDER_SUBJECT_KIND) return manufacturingFlowAdapter;
  if (subjectKind === HRM_EMPLOYMENT_MIGRATION_SUBJECT_KIND) return employmentMigrationFlowAdapter;
  // A pay run is a document, but with payroll's own authoring vocabulary; the
  // adapter is the documents adapter with those fields layered on.
  if (subjectKind === PAY_RUN_SUBJECT_KIND) return payRunsFlowAdapter;
  if (!DOCUMENT_FLOW_KINDS.includes(subjectKind)) return null;
  let adapter = adapterCache.get(subjectKind);
  if (!adapter) {
    adapter = createDocumentsFlowAdapter(subjectKind);
    adapterCache.set(subjectKind, adapter);
  }
  return adapter;
}

/**
 * Subject kinds whose approval release delegates to a registered handler
 * (adapter.releaseApproval → releaseFlowApproval). Derived from the subject
 * registry: every authorable kind whose adapter declares releaseViaHandler.
 * The boot registrations (engine installEngineSeams + web boot) must cover
 * exactly this set — a kind here without a handler strands its approval
 * gates pending forever (decideGate throws, the transaction rolls back,
 * the gate never resolves).
 */
export function handlerReleasedSubjectKinds(): string[] {
  return listFlowSubjectProfiles()
    .map((profile) => profile.subjectKind)
    .filter((kind) => getFlowAdapter(kind)?.releaseViaHandler === true);
}

/**
 * SQL for the owning subsidiary of the subject a flow run or gate row names,
 * across every registered subject kind's declared scope (see
 * subjectSubsidiarySql). Null where no entity is provable.
 */
export function flowSubjectSubsidiarySql(ref: { kind: SQL; id: SQL; org: SQL }): SQL {
  const kinds = listFlowSubjectProfiles().flatMap(({ subjectKind }) => {
    const scope = getFlowAdapter(subjectKind)?.scope;
    return scope ? [{ subjectKind, scope }] : [];
  });
  return subjectSubsidiarySql(kinds, ref);
}

/** Document kinds with a dedicated profile; the generic document profile never duplicates them. */
const DEDICATED_PROFILE_KINDS: ReadonlySet<string> = new Set([
  PAY_RUN_SUBJECT_KIND,
  FIELD_TICKET_SUBJECT_KIND,
]);

/**
 * Every subject kind flows can be authored over, with its profile (builder
 * UI). One entry per subject kind: kinds with a dedicated profile (pay runs
 * carry payroll's own vocabulary) are excluded from the generic document
 * profiles, so the record-type picker offers each kind once and the builder
 * resolves the dedicated vocabulary instead of the generic shadow.
 */
export function listFlowSubjectProfiles(): FlowSubjectProfile[] {
  return [
    ...nativeCommandSubjectProfiles,
    recruitingOfferSubjectProfile,
    metricsNormalizationSubjectProfile,
    salesQuotaSubjectProfile,
    scheduleDistributionSubjectProfile,
    scheduleRequestSubjectProfile,
    schedulePublicationSubjectProfile,
    serviceVisitCompletionSubjectProfile,
    scheduleBoardSubjectProfile,
    checklistStepSubjectProfile,
    ...DOCUMENT_FLOW_KINDS.filter((kind) => !DEDICATED_PROFILE_KINDS.has(kind)).map((kind) =>
      documentSubjectProfile(kind),
    ),
    compensationVersionSubjectProfile,
    compensationAssignmentSubjectProfile,
    benefitAwardSubjectProfile,
    benefitEnrollmentSubjectProfile,
    financialChangeSubjectProfile,
    equityActionSubjectProfile,
    bankAccountSubjectProfile,
    budgetScenarioSubjectProfile,
    closeRunSubjectProfile,
    closeReopenSubjectProfile,
    stockCountSubjectProfile,
    allocationRunSubjectProfile,
    fundReleaseSubjectProfile,
    intercompanyNettingRunSubjectProfile,
    fieldTicketSubjectProfile,
    prebillSubjectProfile,
    payRunSubjectProfile,
    outboundPaymentRunSubjectProfile,
    inboundPaymentRunSubjectProfile,
    timesheetWeekSubjectProfile,
    hrmChangeRequestSubjectProfile,
    hrmLeaveRequestSubjectProfile,
    resourcingRequestSubjectProfile,
    hrmCompCycleSubjectProfile,
    crewBatchSubjectProfile,
    workOrderSubjectProfile,
    employmentMigrationSubjectProfile,
  ];
}

type CustomFlowFieldRow = {
  key: string;
  label: string;
  field_type: string;
  config: { options?: string[] } | null;
};

/**
 * Tenant-aware authoring profile. Runtime adapters stay module-level and
 * deterministic; the builder/linter additionally need this org's custom
 * roles and active custom header fields so authors never type schema or IAM
 * identifiers by hand.
 */
export async function flowSubjectProfileForOrg(
  orgId: string,
  subjectKind: string,
): Promise<FlowSubjectProfile | null> {
  const base = listFlowSubjectProfiles().find((profile) => profile.subjectKind === subjectKind);
  if (!base) return null;

  const roleResult = await db.execute<{ key: string }>(
    sql`
    select key from app_roles where org_id = ${orgId} order by name
  `,
    "objects",
  );

  // Pay runs live in the documents table, so their custom header fields come
  // from the same catalog as every other document kind.
  const isDocumentKind =
    DOCUMENT_FLOW_KINDS.includes(subjectKind) || subjectKind === PAY_RUN_SUBJECT_KIND;
  if (!isDocumentKind) {
    return { ...base, roles: roleResult.map((role) => role.key) };
  }

  const fieldResult = await db.execute<CustomFlowFieldRow>(
    sql`
    select key, label, field_type, config
      from custom_field_defs
     where org_id = ${orgId} and target_table = 'documents'
       and (target_kind is null or target_kind = ${subjectKind}) and is_active
     order by sort_order, label
  `,
    "objects",
  );
  const existing = new Set(base.fields.map((field) => field.key));
  const customFields = fieldResult
    .filter((field) => !existing.has(field.key))
    .map((field) => ({
      key: field.key,
      label: field.label,
      type:
        field.field_type === "number" || field.field_type === "currency"
          ? ("number" as const)
          : field.field_type === "boolean"
            ? ("bool" as const)
            : field.field_type === "date"
              ? ("date" as const)
              : field.field_type === "select" || field.field_type === "multi_select"
                ? ("enum" as const)
                : ("text" as const),
      writable: true,
      ...(field.config?.options?.length
        ? {
            options: field.config.options.map((option) => ({
              value: option,
              label: option,
            })),
          }
        : {}),
    }));

  return {
    ...base,
    fields: [...base.fields, ...customFields],
    roles: roleResult.map((role) => role.key),
  };
}
