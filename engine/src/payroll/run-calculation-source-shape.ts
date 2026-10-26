import { type HolidayFactsSource, isHolidayFactsSource } from "./holiday-facts-store.ts";
import { type StatutoryHolidayEmploymentSource } from "./holidays.ts";
import {
  validateOpeningLevySourceFacts,
  type OpeningLevySourceFacts,
} from "./opening-levy-source-facts.ts";
import { type CaBonusIncomeReferenceSource } from "./canada/bonus-income-reference.ts";
import { type HistoricalEmploymentRosterSource } from "./employment-roster.ts";
import { type EmployerAssignmentSource } from "./employer-assignment-history.ts";
import { type CompensationPackageAssignmentSource } from "./compensation-package-source.ts";
import { type HolidayObligationSource } from "./holiday-obligation-source.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { canonicalDecimal, multiplyDecimal } from "../money/exact-decimal.ts";
import { cmp, roundMoney } from "../money/money.ts";
import { bankCashFundingSplit, type BankCashPayDateValuation } from "./run-bank-cash-evidence.ts";
import {
  canonicalLevySourceKey,
  isEmployerLevyProgramKey,
} from "./run-levy-adjustment-evidence.ts";
import { PAYROLL_COUNTRY_PACKS } from "./pack-registry.ts";
import { hourlyPayRate, isPayRateBasis } from "../projects/pay-rate-basis.ts";
import { isDeclaredVacationAccrualInput } from "./run-vacation-accrual-input.ts";
import { lockLeavePayrollInputSources } from "./leave-payroll-inputs.ts";
import { lockAllowancePayrollInputSources } from "./allowance-payroll-inputs.ts";

export type OpeningEmployerAuthoritySource = {
  id: string;
  openingBalanceId: string;
  employeePartyId: string;
  taxYear: number;
  subsidiaryId: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  openingSha256: string;
};

export type IncomeTaxOverrideSource = {
  adjustmentId: string;
  employeePartyId: string;
  componentId: string;
  amount: string;
  reason: string;
  sourceReference: string;
  requestId: string;
};

export type EmployerLevyAdjustmentSource = {
  adjustmentId: string;
  employeePartyId: string;
  componentId: string;
  amount: string;
  programKey: string;
  workerCompGroupId: string | null;
  sourceKey: string;
  reason: string;
  sourceReference: string;
  requestId: string;
};

export type BankCashInputSource = {
  adjustmentId: string;
  employeePartyId: string;
  componentId: string;
  amount: string;
  hours: string;
  bankPlanId: string;
  bankPlanUnit: string;
  bankPlanDirection: string;
  bankPlanAllowsNegativeBalance: boolean;
  bankPlanPayoutComponentId: string | null;
  bankPlanDepositComponentId: string | null;
  reason: string;
  sourceReference: string;
  requestId: string;
  rate: string | null;
  /** Portion of an issued withdrawal paid outside the entitlement bank. */
  outsideBankAmount?: string;
  /** Native pay-date wage source the split's bank-funded portion is valued at; null records that none resolved. */
  bankValuation?: BankCashPayDateValuation | null;
};

export type DeclaredVacationAccrualSource = {
  adjustmentId: string;
  employeePartyId: string;
  componentId: string;
  planId: string;
  amount: string;
  reason: string;
  sourceReference: string;
  requestId: string;
};

export function isEmployerLevyAdjustmentSource(
  value: unknown,
): value is EmployerLevyAdjustmentSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["adjustmentId", "employeePartyId", "componentId", "requestId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) &&
    row.adjustmentId === row.requestId &&
    isEmployerLevyProgramKey(row.programKey) &&
    (row.programKey === "ca_wcb"
      ? typeof row.workerCompGroupId === "string" && isUuid(row.workerCompGroupId)
      : row.workerCompGroupId === null) &&
    canonicalLevySourceKey(row.sourceKey) === row.sourceKey &&
    typeof row.amount === "string" &&
    canonicalDecimal(canonicalDecimal(row.amount, 4), 2) !== null &&
    cmp(canonicalDecimal(canonicalDecimal(row.amount, 4), 2)!, "0") > 0 &&
    typeof row.reason === "string" &&
    row.reason.trim().length > 0 &&
    row.reason.length <= 500 &&
    typeof row.sourceReference === "string" &&
    row.sourceReference.trim().length > 0 &&
    row.sourceReference.length <= 300
  );
}

export function isIncomeTaxOverrideSource(value: unknown): value is IncomeTaxOverrideSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["adjustmentId", "employeePartyId", "componentId", "requestId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) &&
    typeof row.amount === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(row.amount) &&
    canonicalDecimal(canonicalDecimal(row.amount, 4), 2) !== null &&
    typeof row.reason === "string" &&
    row.reason.trim().length > 0 &&
    row.reason.length <= 500 &&
    typeof row.sourceReference === "string" &&
    row.sourceReference.trim().length > 0 &&
    row.sourceReference.length <= 300
  );
}
export type OpeningLevySourceAuthoritySource = OpeningEmployerAuthoritySource & {
  id: string;
  employerAuthorityId: string;
  allocationSha256: string;
  openingChildrenSha256: string;
  originalCountry: string;
  originalCurrency: string;
  coverageStart: string;
  coverageEnd: string;
  coverageComplete: true;
  allocations: {
    programKey: string;
    region: string;
    subRegion: string;
    filingAccountId: string | null;
    federalAccountId: string | null;
    amount: string;
  }[];
};

export type OpeningBalanceSourceState = {
  openingBalanceId: string;
  sourceDigest: string;
};

export function isBankCashPayDateValuation(value: unknown): value is BankCashPayDateValuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const basis = row.basis;
  if (
    typeof row.rateId !== "string" ||
    !isUuid(row.rateId) ||
    !["employee", "job_title", "trade", "department", "subsidiary", "org"].includes(
      row.scope as string,
    ) ||
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !isPayRateBasis(basis) ||
    typeof row.effectiveFrom !== "string" ||
    !isIsoCalendarDate(row.effectiveFrom) ||
    !(
      row.effectiveTo === null ||
      (typeof row.effectiveTo === "string" &&
        isIsoCalendarDate(row.effectiveTo) &&
        row.effectiveTo >= row.effectiveFrom)
    ) ||
    !(
      row.updatedAt === null ||
      (typeof row.updatedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.updatedAt))
    )
  )
    return false;
  const hourlyWage =
    typeof row.hourlyWage === "string" ? canonicalDecimal(row.hourlyWage, 4) : null;
  const rate = typeof row.rate === "string" ? canonicalDecimal(row.rate, 4) : null;
  if (hourlyWage === null || rate === null || cmp(hourlyWage, "0") <= 0 || cmp(rate, "0") <= 0)
    return false;
  if (basis === "hour") {
    return (
      row.annualHoursUsed === null && row.annualHoursSource === null && cmp(hourlyWage, rate) === 0
    );
  }
  if (
    !(row.annualHoursSource === "rate" || row.annualHoursSource === "labor_costing_settings") ||
    typeof row.annualHoursUsed !== "string"
  )
    return false;
  const annualHours = canonicalDecimal(row.annualHoursUsed, 4);
  if (annualHours === null || cmp(annualHours, "0") <= 0) return false;
  return cmp(hourlyPayRate(rate, basis, annualHours), hourlyWage) === 0;
}

export function isBankCashInputSource(value: unknown): value is BankCashInputSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    !["adjustmentId", "employeePartyId", "componentId", "requestId", "bankPlanId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) ||
    typeof row.amount !== "string" ||
    typeof row.hours !== "string" ||
    !["hours", "money"].includes(row.bankPlanUnit as string) ||
    !["accrue", "owe"].includes(row.bankPlanDirection as string) ||
    typeof row.bankPlanAllowsNegativeBalance !== "boolean" ||
    !(
      row.bankPlanPayoutComponentId === null ||
      (typeof row.bankPlanPayoutComponentId === "string" && isUuid(row.bankPlanPayoutComponentId))
    ) ||
    !(
      row.bankPlanDepositComponentId === null ||
      (typeof row.bankPlanDepositComponentId === "string" && isUuid(row.bankPlanDepositComponentId))
    ) ||
    typeof row.reason !== "string" ||
    !row.reason.trim() ||
    row.reason.length > 500 ||
    typeof row.sourceReference !== "string" ||
    !row.sourceReference.trim() ||
    row.sourceReference.length > 300 ||
    !(row.rate === null || typeof row.rate === "string") ||
    !(row.outsideBankAmount === undefined || typeof row.outsideBankAmount === "string") ||
    !(
      row.bankValuation === undefined ||
      row.bankValuation === null ||
      isBankCashPayDateValuation(row.bankValuation)
    )
  )
    return false;
  if (
    row.requestId !== row.adjustmentId ||
    row.bankPlanPayoutComponentId === row.bankPlanDepositComponentId
  )
    return false;
  const amount = canonicalDecimal(row.amount, 4);
  const hours = canonicalDecimal(row.hours, 2);
  if (
    amount === null ||
    hours === null ||
    cmp(amount, "0") === 0 ||
    cmp(hours, "0") === 0 ||
    cmp(amount, "0") > 0 !== cmp(hours, "0") > 0 ||
    amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15 ||
    hours.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10 ||
    cmp(roundMoney(amount, 2), amount) !== 0 ||
    (cmp(hours, "0") > 0
      ? row.bankPlanPayoutComponentId !== row.componentId
      : row.bankPlanDirection !== "accrue" || row.bankPlanDepositComponentId !== row.componentId)
  )
    return false;
  if (row.rate !== null) {
    const rate = canonicalDecimal(row.rate, 2);
    if (
      rate === null ||
      rate !== row.rate ||
      cmp(rate, "0") <= 0 ||
      rate.split(".")[0]!.replace(/^0+/, "").length > 15
    )
      return false;
    const priced = multiplyDecimal(rate, hours.replace(/^[+-]/, ""), 2);
    if (cmp(cmp(hours, "0") < 0 ? `-${priced}` : priced, amount) !== 0) return false;
  }
  if ((row.outsideBankAmount === undefined) !== (row.bankValuation === undefined)) return false;
  if (row.outsideBankAmount !== undefined && !bankCashFundingSplit(amount, row.outsideBankAmount))
    return false;
  // A retained valuation that no longer prices the split is not corrupt
  // evidence: it is a changed pay-date wage, and the digest comparison
  // reads it stale. The calculation itself refuses the mismatch when the
  // earning lines are constructed, so a stored snapshot never certifies
  // a split its own valuation fails to price.
  return true;
}

export function isDeclaredVacationAccrualSource(
  value: unknown,
): value is DeclaredVacationAccrualSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["adjustmentId", "employeePartyId", "componentId", "planId", "requestId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) &&
    row.adjustmentId === row.requestId &&
    typeof row.amount === "string" &&
    typeof row.reason === "string" &&
    typeof row.sourceReference === "string" &&
    isDeclaredVacationAccrualInput({ ...row, kind: "declared_vacation_accrual" })
  );
}

export function isOpeningEmployerAuthoritySource(
  value: unknown,
): value is OpeningEmployerAuthoritySource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    [
      "id",
      "openingBalanceId",
      "employeePartyId",
      "subsidiaryId",
      "sourceFileId",
      "sourceVersionId",
    ].every((key) => {
      const value = row[key];
      return typeof value === "string" && isUuid(value);
    }) &&
    typeof row.taxYear === "number" &&
    Number.isSafeInteger(row.taxYear) &&
    ["sourceSha256", "openingSha256"].every((key) => {
      const value = row[key];
      return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    })
  );
}

export function isOpeningLevySourceAuthoritySource(
  value: unknown,
): value is OpeningLevySourceAuthoritySource {
  if (!isOpeningEmployerAuthoritySource(value) || !value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.employerAuthorityId === "string" &&
    isUuid(row.employerAuthorityId) &&
    typeof row.openingChildrenSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.openingChildrenSha256) &&
    typeof row.allocationSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(row.allocationSha256) &&
    typeof row.originalCountry === "string" &&
    /^[A-Z]{2}$/.test(row.originalCountry) &&
    typeof row.originalCurrency === "string" &&
    /^[A-Z]{3}$/.test(row.originalCurrency) &&
    row.coverageComplete === true &&
    typeof row.coverageStart === "string" &&
    isIsoCalendarDate(row.coverageStart) &&
    typeof row.coverageEnd === "string" &&
    isIsoCalendarDate(row.coverageEnd) &&
    (() => {
      try {
        validateOpeningLevySourceFacts(
          row as unknown as OpeningLevySourceFacts,
          row.taxYear as number,
          PAYROLL_COUNTRY_PACKS[String(row.originalCountry)],
        );
        return true;
      } catch {
        return false;
      }
    })() &&
    Array.isArray(row.allocations) &&
    (!PAYROLL_COUNTRY_PACKS[row.originalCountry]?.openingLevySource ||
      row.allocations.length > 0) &&
    row.allocations.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const allocation = value as Record<string, unknown>;
      return (
        typeof allocation.programKey === "string" &&
        typeof allocation.region === "string" &&
        typeof allocation.subRegion === "string" &&
        (allocation.filingAccountId === null ||
          (typeof allocation.filingAccountId === "string" && isUuid(allocation.filingAccountId))) &&
        (allocation.federalAccountId === null ||
          (typeof allocation.federalAccountId === "string" &&
            isUuid(allocation.federalAccountId))) &&
        typeof allocation.amount === "string" &&
        /^\d{1,15}(?:\.\d{1,4})?$/.test(allocation.amount)
      );
    })
  );
}

export function isOpeningBalanceSourceState(value: unknown): value is OpeningBalanceSourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.openingBalanceId === "string" &&
    isUuid(row.openingBalanceId) &&
    typeof row.sourceDigest === "string" &&
    /^[a-f0-9]{64}$/.test(row.sourceDigest)
  );
}

export function isHolidayEmploymentSource(
  value: unknown,
): value is StatutoryHolidayEmploymentSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["orgId", "employeePartyId", "employmentId", "subsidiaryId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) &&
    Number.isSafeInteger(row.employmentRevision) &&
    Number(row.employmentRevision) > 0 &&
    (row.versionId === null || (typeof row.versionId === "string" && isUuid(row.versionId))) &&
    (row.versionNo === null ||
      (Number.isSafeInteger(row.versionNo) && Number(row.versionNo) > 0)) &&
    (row.status === null || typeof row.status === "string") &&
    ["effectiveFrom", "effectiveTo"].every(
      (key) =>
        row[key] === null ||
        (typeof row[key] === "string" && isIsoCalendarDate(row[key] as string)),
    ) &&
    (row.recordedAt === null ||
      (typeof row.recordedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.recordedAt)))
  );
}

export interface PayRunCalculationSourceSnapshot {
  version: 2;
  holidayFacts: HolidayFactsSource;
  timeEntries: {
    id: string;
    employeePartyId: string;
    workedOn: string;
    hours: string;
    timeTypeId: string | null;
    projectId: string | null;
    departmentId: string | null;
    isBillable: boolean;
    createdAt: string;
    updatedAt: string;
    claimable: boolean;
  }[];
  timeTypes: {
    id: string;
    name: string;
    classification: string;
    costMultiplier: string;
    excludeFromWages: boolean;
    updatedAt: string;
  }[];
  payRates: {
    employeePartyId: string;
    payBasis: string;
    runCurrency: string | null;
    rateId: string | null;
    basis: string | null;
    rate: string | null;
    annualHours: string | null;
    payrollRateScale: number;
    payrollAmountRounding: string;
    currency: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    updatedAt: string | null;
    fx: {
      id: string;
      fromCurrency: string;
      toCurrency: string;
      asOf: string;
      rate: string;
      direction: "direct" | "inverse";
      resolvedRate: string;
      updatedAt: string;
    } | null;
  }[];
  /**
   * The payroll-costing account of every service item the run's locked time
   * entries point at. A routing input like time types and rates: it changes
   * the run's output (which account a cost lands in), so an edit after
   * Calculate must read stale — a misstated cost of sales is a wrong number
   * even when net pay is identical.
   */
  itemAccounts: {
    id: string;
    payrollExpenseAccountId: string | null;
    updatedAt: string;
  }[];
  compensationPackages: CompensationPackageAssignmentSource[];
  employerAssignments: EmployerAssignmentSource[];
  assignmentRunPolicies: {
    id: string;
    employeePartyId: string;
    employmentId: string | null;
    componentId: string;
    policy: string;
    from: string;
    to: string | null;
  }[];
  /** Exact component assessability versions consumed by earning lines at pay date. */
  payComponentStatutoryTreatments: ComponentStatutoryTreatmentSource[];
  historicalEmploymentRoster: HistoricalEmploymentRosterSource[];
  holidayEmployments: StatutoryHolidayEmploymentSource[];
  holidayObligations: HolidayObligationSource[];
  bonusIncomeReferences: CaBonusIncomeReferenceSource[];
  /** Exact retained employer and original-report identity of consumed opening history. */
  openingEmployerAuthorities: OpeningEmployerAuthoritySource[];
  /** Audited operator-entered absolute withholding amounts consumed by Canadian tax calculation. */
  incomeTaxOverrides: IncomeTaxOverrideSource[];
  /** Audited operator-entered hours and optional keyed rates for bank cash lines. */
  bankCashInputs: BankCashInputSource[];
  /** Audited issued employer levy amounts recorded as issued on this run. */
  employerLevyAdjustments: EmployerLevyAdjustmentSource[];
  /** Audited per-cheque vacation bank accruals explicitly declared by an operator. */
  declaredVacationAccruals: DeclaredVacationAccrualSource[];
  /** Exact sealed source allocations consumed by this pay run, including EIN and jurisdiction identities. */
  openingLevySourceAuthorities: OpeningLevySourceAuthoritySource[];
  /** Opening rows that can affect employer-wide levies or make their source ambiguous. */
  openingBalanceSources: OpeningBalanceSourceState[];
  /** Original dated state-account affiliations used by current payroll and its statutory prior. */
  usFilingAccountLineages: UsFilingAccountLineageSource[];
  /** The accounts each bank this run settles posts to: the plan liability and its accrual credit. */
  entitlementSettlementPlans: EntitlementSettlementPlanSource[];
  claimEntryIds: string[];
}

/**
 * Everything the entitlement settlement stamp reads for one plan whose bank
 * the run withdraws from or deposits into. Changing any of it after
 * Calculate changes which account the settlement lines post to.
 */
export type EntitlementSettlementPlanSource = {
  planId: string;
  planActive: boolean;
  liabilityAccountId: string | null;
  accrualComponentId: string | null;
  accrualLiabilityAccountId: string | null;
};

export function isEntitlementSettlementPlanSource(
  value: unknown,
): value is EntitlementSettlementPlanSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    isUuid(row.planId) &&
    typeof row.planActive === "boolean" &&
    ["liabilityAccountId", "accrualComponentId", "accrualLiabilityAccountId"].every(
      (key) => row[key] === null || isUuid(row[key]),
    )
  );
}

export type UsFilingAccountLineageSource = {
  id: string;
  filingAccountId: string;
  federalAccountId: string;
  subsidiaryId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceReference: string;
  updatedAt: string;
};

export function isUsFilingAccountLineageSource(
  value: unknown,
): value is UsFilingAccountLineageSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["id", "filingAccountId", "federalAccountId", "subsidiaryId"].every((key) =>
      isUuid(row[key]),
    ) &&
    isIsoCalendarDate(row.effectiveFrom) &&
    (row.effectiveTo === null ||
      (isIsoCalendarDate(row.effectiveTo) && row.effectiveTo >= row.effectiveFrom)) &&
    typeof row.sourceReference === "string" &&
    row.sourceReference.trim().length > 0 &&
    row.sourceReference.length <= 2000 &&
    typeof row.updatedAt === "string" &&
    Number.isFinite(Date.parse(row.updatedAt))
  );
}

/** One treatment version as current calculation captures it. */
export type ComponentStatutoryTreatmentSource = {
  id: string;
  componentId: string;
  workerCompGroupId: string | null;
  employeeWorkerCompGroupId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  programExclusions: string[];
  vacationable: boolean;
};

/** Validate the complete component treatment consumed by calculation. */
export function isComponentStatutoryTreatmentSource(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    ["id", "componentId"].every(
      (key) => typeof row[key] === "string" && isUuid(row[key] as string),
    ) &&
    ["workerCompGroupId", "employeeWorkerCompGroupId"].every(
      (key) => row[key] === null || (typeof row[key] === "string" && isUuid(row[key] as string)),
    ) &&
    typeof row.effectiveFrom === "string" &&
    isIsoCalendarDate(row.effectiveFrom) &&
    (row.effectiveTo === null ||
      (typeof row.effectiveTo === "string" &&
        isIsoCalendarDate(row.effectiveTo) &&
        row.effectiveTo >= row.effectiveFrom)) &&
    Array.isArray(row.programExclusions) &&
    row.programExclusions.every((key) => typeof key === "string") &&
    typeof row.vacationable === "boolean"
  );
}

/** Lock the dated group authority and policy rows before producing the source snapshot. */
export async function lockStatutoryTreatmentSources(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  await executor.execute(sql`
    select profile.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join employee_payroll_profiles profile
        on profile.org_id=stub.org_id and profile.employee_party_id=stub.employee_party_id
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     order by profile.employee_party_id
     for share of profile
  `);
  await executor.execute(sql`
    select assignment.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join payroll_employee_employer_assignments assignment
        on assignment.org_id=stub.org_id and assignment.employee_party_id=stub.employee_party_id
       and assignment.assignment_kind='worker_comp'
       and run.pay_date between assignment.effective_from and assignment.effective_to
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     order by assignment.id
     for share of assignment
  `);
  await executor.execute(sql`
    select role.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join employee_roles role on role.org_id=stub.org_id and role.party_id=stub.employee_party_id and role.is_active
      join worker_comp_groups worker_group
        on worker_group.org_id=role.org_id and worker_group.id=role.worker_comp_group_id and worker_group.is_active
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (
         select 1 from payroll_employee_employer_assignments assignment
          where assignment.org_id=stub.org_id and assignment.employee_party_id=stub.employee_party_id
            and assignment.assignment_kind='worker_comp'
            and run.pay_date between assignment.effective_from and assignment.effective_to
       )
     order by role.id
     for share of role, worker_group
  `);
  await executor.execute(sql`
    select component.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
      join pay_components component on component.org_id=line.org_id and component.id=line.component_id
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       and line.kind='earning' and line.component_id is not null
     order by component.id
     for share of component
  `);
  await executor.execute(sql`
    select treatment.id
      from pay_component_statutory_treatments treatment
     where treatment.org_id=${orgId}
       and exists (
         select 1
           from pay_runs run
           join documents d on d.org_id=run.org_id and d.id=run.document_id
           join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
           join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
          where run.org_id=${orgId} and run.document_id=${documentId}
            ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
            and line.kind='earning' and line.component_id is not null
            and treatment.pay_component_id=line.component_id
            and treatment.effective_from<=run.pay_date
            and (treatment.effective_to is null or treatment.effective_to>=run.pay_date)
            and (treatment.worker_comp_group_id is null
              or treatment.worker_comp_group_id is not distinct from
                 public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, run.pay_date))
            and treatment.id=(
              select selected.id
                from pay_component_statutory_treatments selected
               where selected.org_id=line.org_id and selected.pay_component_id=line.component_id
                 and selected.effective_from<=run.pay_date
                 and (selected.effective_to is null or selected.effective_to>=run.pay_date)
                 and (selected.worker_comp_group_id is null
                   or selected.worker_comp_group_id is not distinct from
                     public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, run.pay_date))
               order by (selected.worker_comp_group_id is not null) desc,
                 selected.effective_from desc, selected.id
               limit 1
            )
       )
     order by treatment.id
     for share of treatment
  `);
}

export type CalculationSourceRow = {
  run_exists: boolean;
  pay_date: string;
  employee_party_ids: string[];
  time_entries: PayRunCalculationSourceSnapshot["timeEntries"];
  time_types: PayRunCalculationSourceSnapshot["timeTypes"];
  pay_rates: PayRunCalculationSourceSnapshot["payRates"];
  item_accounts: PayRunCalculationSourceSnapshot["itemAccounts"];
  claim_entry_ids: string[];
};

/** Stable JSON independent of jsonb's object-key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function payRunCalculationSourceDigest(snapshot: PayRunCalculationSourceSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function parsePayRunCalculationSource(
  value: unknown,
): PayRunCalculationSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PayRunCalculationSourceSnapshot>;
  if (
    snapshot.version !== 2 ||
    !isHolidayFactsSource(snapshot.holidayFacts) ||
    !Array.isArray(snapshot.timeEntries) ||
    !Array.isArray(snapshot.timeTypes) ||
    !Array.isArray(snapshot.payRates) ||
    !Array.isArray(snapshot.claimEntryIds) ||
    !Array.isArray(snapshot.itemAccounts) ||
    !Array.isArray(snapshot.compensationPackages) ||
    !Array.isArray(snapshot.assignmentRunPolicies) ||
    !Array.isArray(snapshot.historicalEmploymentRoster) ||
    !Array.isArray(snapshot.employerAssignments) ||
    !Array.isArray(snapshot.holidayObligations) ||
    !Array.isArray(snapshot.bonusIncomeReferences) ||
    !Array.isArray(snapshot.payComponentStatutoryTreatments) ||
    snapshot.payComponentStatutoryTreatments.some(
      (row) => !isComponentStatutoryTreatmentSource(row),
    ) ||
    !Array.isArray(snapshot.holidayEmployments) ||
    snapshot.holidayEmployments.some((row) => !isHolidayEmploymentSource(row)) ||
    !Array.isArray(snapshot.incomeTaxOverrides) ||
    snapshot.incomeTaxOverrides.some((row) => !isIncomeTaxOverrideSource(row)) ||
    !Array.isArray(snapshot.bankCashInputs) ||
    snapshot.bankCashInputs.some((row) => !isBankCashInputSource(row)) ||
    !Array.isArray(snapshot.employerLevyAdjustments) ||
    snapshot.employerLevyAdjustments.some((row) => !isEmployerLevyAdjustmentSource(row)) ||
    !Array.isArray(snapshot.declaredVacationAccruals) ||
    snapshot.declaredVacationAccruals.some((row) => !isDeclaredVacationAccrualSource(row)) ||
    !Array.isArray(snapshot.openingEmployerAuthorities) ||
    snapshot.openingEmployerAuthorities.some((row) => !isOpeningEmployerAuthoritySource(row)) ||
    !Array.isArray(snapshot.usFilingAccountLineages) ||
    snapshot.usFilingAccountLineages.some((row) => !isUsFilingAccountLineageSource(row)) ||
    !Array.isArray(snapshot.openingLevySourceAuthorities) ||
    snapshot.openingLevySourceAuthorities.some((row) => !isOpeningLevySourceAuthoritySource(row)) ||
    !Array.isArray(snapshot.openingBalanceSources) ||
    snapshot.openingBalanceSources.some((row) => !isOpeningBalanceSourceState(row)) ||
    !Array.isArray(snapshot.entitlementSettlementPlans) ||
    snapshot.entitlementSettlementPlans.some((row) => !isEntitlementSettlementPlanSource(row)) ||
    snapshot.payRates.some(
      (row) =>
        !row ||
        !Number.isSafeInteger(row.payrollRateScale) ||
        typeof row.payrollAmountRounding !== "string",
    )
  )
    return null;
  return snapshot as PayRunCalculationSourceSnapshot;
}

/**
 * Hold every input a locked calculation re-derives: statutory treatments,
 * declared vacation accruals with their accrual plans, and bank cash inputs
 * with their components and payout plans, in one fixed order.
 */
export async function lockCalculationInputSources(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  await lockLeavePayrollInputSources(executor, orgId, documentId);
  await lockAllowancePayrollInputSources(executor, orgId, documentId);
  await lockStatutoryTreatmentSources(executor, orgId, documentId, allowedSubsidiaryIds);
  await executor.execute(sql`
    select adjustment.id
      from pay_run_adjustments adjustment
     where adjustment.org_id=${orgId} and adjustment.pay_run_document_id=${documentId}
       and adjustment.adjustment_type='line'
       and adjustment.note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     order by adjustment.id
     for share of adjustment
  `);
  await executor.execute(sql`
    select adjustment.id
      from pay_run_adjustments adjustment
      join pay_components component
        on component.org_id=adjustment.org_id and component.id=adjustment.component_id
      join entitlement_plans plan
        on plan.org_id=adjustment.org_id and plan.accrual_component_id=adjustment.component_id
       and plan.system_key='vacation'
     where adjustment.org_id=${orgId} and adjustment.pay_run_document_id=${documentId}
       and adjustment.adjustment_type='line'
       and adjustment.note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     order by adjustment.id,plan.id
     for share of adjustment,component,plan
  `);
  await executor.execute(sql`
    select adjustment.id
      from pay_run_adjustments adjustment
      join pay_components component
        on component.org_id=adjustment.org_id and component.id=adjustment.component_id
     where adjustment.org_id=${orgId} and adjustment.pay_run_document_id=${documentId}
       and adjustment.adjustment_type='line'
       and adjustment.note ~ '"kind"[[:space:]]*:[[:space:]]*"bank_cash_input"'
     order by adjustment.id
     for share of adjustment, component
  `);
  await executor.execute(sql`
    select plan.id
      from entitlement_plans plan
     where plan.org_id=${orgId}
       and exists (
         select 1 from pay_run_adjustments adjustment
          where adjustment.org_id=plan.org_id and adjustment.pay_run_document_id=${documentId}
            and adjustment.adjustment_type='line'
            and adjustment.note ~ '"kind"[[:space:]]*:[[:space:]]*"bank_cash_input"'
            and (adjustment.component_id=plan.payout_component_id or adjustment.component_id=plan.deposit_component_id)
       )
     order by plan.id
     for share of plan
  `);
}
