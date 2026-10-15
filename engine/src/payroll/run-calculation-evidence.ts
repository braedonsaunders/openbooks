import { statutoryHolidayEmploymentSource, type StatutoryHolidayEmploymentSource } from './holidays.ts';
import { currentOpeningLevySourceSql } from './opening-levy-source-correction-authority.ts';
import { validateOpeningLevySourceFacts, type OpeningLevySourceFacts } from './opening-levy-source-facts.ts';
import { resolveCaBonusIncomeReference, type CaBonusIncomeReferenceScope, type CaBonusIncomeReferenceSource } from './canada/bonus-income-reference.ts';
import { PayrollError } from './error.ts';
import { historicalEmploymentRosterSource, type HistoricalEmploymentRosterSource } from "./employment-roster.ts";
import { employeeEmployerAssignmentHistory, type EmployerAssignmentSource } from './employer-assignment-history.ts';
import { compensationPackageRunSource, type CompensationPackageAssignmentSource } from './compensation-package-source.ts';
import { holidayObligationRunSource, type HolidayObligationSource } from './holiday-obligation-source.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { canonicalDecimal, multiplyDecimal } from "../money/exact-decimal.ts";
import { cmp, roundMoney } from "../money/money.ts";
import { bankCashFundingSplit, isBankCashInputEvidenceCandidate, parseBankCashInputEvidence, type BankCashPayDateValuation } from "./run-bank-cash-evidence.ts";
import { EMPLOYER_LEVY_PROGRAMS, canonicalLevySourceKey, isEmployerLevyProgramKey, parseEmployerLevyAdjustmentEvidence } from "./run-levy-adjustment-evidence.ts";
import { resolveBankPayDateValuation } from "./run-bank-valuation.ts";
import { PAYROLL_COUNTRY_PACKS } from "./pack-registry.ts";
import { hourlyPayRate, isPayRateBasis } from "../projects/pay-rate-basis.ts";
import { isDeclaredVacationAccrualInput, parseDeclaredVacationAccrualEvidence } from "./run-vacation-accrual-input.ts";

export type OpeningEmployerAuthoritySource = {
  id: string; openingBalanceId: string; employeePartyId: string; taxYear: number; subsidiaryId: string;
  sourceFileId: string; sourceVersionId: string; sourceSha256: string; openingSha256: string;
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

function isEmployerLevyAdjustmentSource(value: unknown): value is EmployerLevyAdjustmentSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["adjustmentId", "employeePartyId", "componentId", "requestId"]
    .every(key => typeof row[key] === "string" && isUuid(row[key] as string))
    && row.adjustmentId === row.requestId
    && isEmployerLevyProgramKey(row.programKey)
    && (row.programKey === "ca_wcb"
      ? typeof row.workerCompGroupId === "string" && isUuid(row.workerCompGroupId)
      : row.workerCompGroupId === null)
    && canonicalLevySourceKey(row.sourceKey) === row.sourceKey
    && typeof row.amount === "string" && canonicalDecimal(canonicalDecimal(row.amount, 4), 2) !== null
    && cmp(canonicalDecimal(canonicalDecimal(row.amount, 4), 2)!, "0") > 0
    && typeof row.reason === "string" && row.reason.trim().length > 0 && row.reason.length <= 500
    && typeof row.sourceReference === "string" && row.sourceReference.trim().length > 0 && row.sourceReference.length <= 300;
}

function isIncomeTaxOverrideSource(value: unknown): value is IncomeTaxOverrideSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["adjustmentId", "employeePartyId", "componentId", "requestId"]
    .every(key => typeof row[key] === "string" && isUuid(row[key] as string))
    && typeof row.amount === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(row.amount)
    && canonicalDecimal(canonicalDecimal(row.amount, 4), 2) !== null
    && typeof row.reason === "string" && row.reason.trim().length > 0 && row.reason.length <= 500
    && typeof row.sourceReference === "string" && row.sourceReference.trim().length > 0 && row.sourceReference.length <= 300;
}
export type OpeningLevySourceAuthoritySource = OpeningEmployerAuthoritySource & {
  id: string;
  employerAuthorityId: string;
  allocationSha256: string;
  openingChildrenSha256: string;
  originalCountry: string; originalCurrency: string;
  coverageStart: string; coverageEnd: string; coverageComplete: true;
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

function isBankCashPayDateValuation(value: unknown): value is BankCashPayDateValuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const basis = row.basis;
  if (typeof row.rateId !== "string" || !isUuid(row.rateId)
    || !["employee", "job_title", "trade", "department", "subsidiary", "org"].includes(row.scope as string)
    || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)
    || !isPayRateBasis(basis)
    || typeof row.effectiveFrom !== "string" || !isIsoCalendarDate(row.effectiveFrom)
    || !(row.effectiveTo === null || typeof row.effectiveTo === "string" && isIsoCalendarDate(row.effectiveTo) && row.effectiveTo >= row.effectiveFrom)
    || !(row.updatedAt === null || typeof row.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.updatedAt))) return false;
  const hourlyWage = typeof row.hourlyWage === "string" ? canonicalDecimal(row.hourlyWage, 4) : null;
  const rate = typeof row.rate === "string" ? canonicalDecimal(row.rate, 4) : null;
  if (hourlyWage === null || rate === null || cmp(hourlyWage, "0") <= 0 || cmp(rate, "0") <= 0) return false;
  if (basis === "hour") {
    return row.annualHoursUsed === null && row.annualHoursSource === null && cmp(hourlyWage, rate) === 0;
  }
  if (!(row.annualHoursSource === "rate" || row.annualHoursSource === "labor_costing_settings")
    || typeof row.annualHoursUsed !== "string") return false;
  const annualHours = canonicalDecimal(row.annualHoursUsed, 4);
  if (annualHours === null || cmp(annualHours, "0") <= 0) return false;
  return cmp(hourlyPayRate(rate, basis, annualHours), hourlyWage) === 0;
}

function isBankCashInputSource(value: unknown): value is BankCashInputSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!["adjustmentId", "employeePartyId", "componentId", "requestId", "bankPlanId"].every(key =>
    typeof row[key] === "string" && isUuid(row[key] as string))
    || typeof row.amount !== "string" || typeof row.hours !== "string"
    || !["hours", "money"].includes(row.bankPlanUnit as string) || !["accrue", "owe"].includes(row.bankPlanDirection as string)
    || typeof row.bankPlanAllowsNegativeBalance !== "boolean"
    || !(row.bankPlanPayoutComponentId === null || typeof row.bankPlanPayoutComponentId === "string" && isUuid(row.bankPlanPayoutComponentId))
    || !(row.bankPlanDepositComponentId === null || typeof row.bankPlanDepositComponentId === "string" && isUuid(row.bankPlanDepositComponentId))
    || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500
    || typeof row.sourceReference !== "string" || !row.sourceReference.trim() || row.sourceReference.length > 300
    || !(row.rate === null || typeof row.rate === "string")
    || !(row.outsideBankAmount === undefined || typeof row.outsideBankAmount === "string")
    || !(row.bankValuation === undefined || row.bankValuation === null || isBankCashPayDateValuation(row.bankValuation))) return false;
  if (row.requestId !== row.adjustmentId || row.bankPlanPayoutComponentId === row.bankPlanDepositComponentId) return false;
  const amount = canonicalDecimal(row.amount, 4);
  const hours = canonicalDecimal(row.hours, 2);
  if (amount === null || hours === null || cmp(amount, "0") === 0 || cmp(hours, "0") === 0
    || (cmp(amount, "0") > 0) !== (cmp(hours, "0") > 0)
    || amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15
    || hours.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10
    || cmp(roundMoney(amount, 2), amount) !== 0
    || (cmp(hours, "0") > 0 ? row.bankPlanPayoutComponentId !== row.componentId
      : row.bankPlanDirection !== "accrue" || row.bankPlanDepositComponentId !== row.componentId)) return false;
  if (row.rate !== null) {
    const rate = canonicalDecimal(row.rate, 2);
    if (rate === null || rate !== row.rate || cmp(rate, "0") <= 0
      || rate.split(".")[0]!.replace(/^0+/, "").length > 15) return false;
    const priced = multiplyDecimal(rate, hours.replace(/^[+-]/, ""), 2);
    if (cmp(cmp(hours, "0") < 0 ? `-${priced}` : priced, amount) !== 0) return false;
  }
  if ((row.outsideBankAmount === undefined) !== (row.bankValuation === undefined)) return false;
  if (row.outsideBankAmount !== undefined && !bankCashFundingSplit(amount, row.outsideBankAmount)) return false;
  // A retained valuation that no longer prices the split is not corrupt
  // evidence: it is a changed pay-date wage, and the digest comparison
  // reads it stale. The calculation itself refuses the mismatch when the
  // earning lines are constructed, so a stored snapshot never certifies
  // a split its own valuation fails to price.
  return true;
}

function isDeclaredVacationAccrualSource(value: unknown): value is DeclaredVacationAccrualSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["adjustmentId", "employeePartyId", "componentId", "planId", "requestId"]
    .every(key => typeof row[key] === "string" && isUuid(row[key] as string))
    && row.adjustmentId === row.requestId
    && typeof row.amount === "string" && typeof row.reason === "string"
    && typeof row.sourceReference === "string"
    && isDeclaredVacationAccrualInput({ ...row, kind: "declared_vacation_accrual" });
}

function isOpeningEmployerAuthoritySource(value: unknown): value is OpeningEmployerAuthoritySource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["id", "openingBalanceId", "employeePartyId", "subsidiaryId", "sourceFileId", "sourceVersionId"]
    .every(key => { const value = row[key]; return typeof value === "string" && isUuid(value); })
    && typeof row.taxYear === "number" && Number.isSafeInteger(row.taxYear)
    && ["sourceSha256", "openingSha256"].every(key => { const value = row[key]; return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); });
}

function isOpeningLevySourceAuthoritySource(value: unknown): value is OpeningLevySourceAuthoritySource {
  if (!isOpeningEmployerAuthoritySource(value) || !value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.employerAuthorityId === 'string' && isUuid(row.employerAuthorityId)
    && typeof row.openingChildrenSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.openingChildrenSha256)
    && typeof row.allocationSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.allocationSha256)
    && typeof row.originalCountry === 'string' && /^[A-Z]{2}$/.test(row.originalCountry)
    && typeof row.originalCurrency === 'string' && /^[A-Z]{3}$/.test(row.originalCurrency)
    && row.coverageComplete === true && typeof row.coverageStart === 'string' && isIsoCalendarDate(row.coverageStart)
    && typeof row.coverageEnd === 'string' && isIsoCalendarDate(row.coverageEnd)
    && (() => { try { validateOpeningLevySourceFacts(row as unknown as OpeningLevySourceFacts, row.taxYear as number, PAYROLL_COUNTRY_PACKS[String(row.originalCountry)]); return true; } catch { return false; } })()
    && Array.isArray(row.allocations) && (row.originalCountry !== 'CA' && row.originalCountry !== 'US' || row.allocations.length > 0)
    && row.allocations.every((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const allocation = value as Record<string, unknown>;
      return typeof allocation.programKey === 'string' && typeof allocation.region === 'string'
        && typeof allocation.subRegion === 'string'
        && (allocation.filingAccountId === null || typeof allocation.filingAccountId === 'string' && isUuid(allocation.filingAccountId))
        && (allocation.federalAccountId === null || typeof allocation.federalAccountId === 'string' && isUuid(allocation.federalAccountId))
        && typeof allocation.amount === 'string' && /^\d{1,15}(?:\.\d{1,4})?$/.test(allocation.amount);
    });
}

function isOpeningBalanceSourceState(value: unknown): value is OpeningBalanceSourceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.openingBalanceId === 'string' && isUuid(row.openingBalanceId)
    && typeof row.sourceDigest === 'string' && /^[a-f0-9]{64}$/.test(row.sourceDigest);
}

function isHolidayEmploymentSource(value: unknown): value is StatutoryHolidayEmploymentSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row=value as Record<string,unknown>;
  return ['orgId','employeePartyId','employmentId','subsidiaryId'].every(key=>typeof row[key]==='string' && isUuid(row[key] as string))
    && Number.isSafeInteger(row.employmentRevision) && Number(row.employmentRevision)>0
    && (row.versionId===null || typeof row.versionId==='string' && isUuid(row.versionId))
    && (row.versionNo===null || Number.isSafeInteger(row.versionNo) && Number(row.versionNo)>0)
    && (row.status===null || typeof row.status==='string')
    && ['effectiveFrom','effectiveTo'].every(key=>row[key]===null || typeof row[key]==='string' && isIsoCalendarDate(row[key] as string))
    && (row.recordedAt===null || typeof row.recordedAt==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.recordedAt));
}

export interface PayRunCalculationSourceSnapshot {
  version: 1;
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
    /** Existing four-place/group defaults omit these keys to retain stored digests. */
    payrollRateScale?: number;
    payrollAmountRounding?: string;
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
  compensationPackages?: CompensationPackageAssignmentSource[];
  employerAssignments?: EmployerAssignmentSource[];
  assignmentRunPolicies?: { id: string; employeePartyId: string; employmentId: string | null; componentId: string; policy: string; from: string; to: string | null }[];
  /** Exact component assessability versions consumed by earning lines at pay date. */
  payComponentStatutoryTreatments?: { id: string; componentId: string; workerCompGroupId: string | null; employeeWorkerCompGroupId: string | null; effectiveFrom: string; effectiveTo: string | null; programExclusions: string[]; vacationable: boolean }[];
  historicalEmploymentRoster?: HistoricalEmploymentRosterSource[];
  holidayEmployments?: StatutoryHolidayEmploymentSource[];
  holidayObligations?: HolidayObligationSource[];
  bonusIncomeReferences?: CaBonusIncomeReferenceSource[];
  /** Exact retained employer and original-report identity of consumed opening history. */
  openingEmployerAuthorities?: OpeningEmployerAuthoritySource[];
  /** Audited operator-entered absolute withholding amounts consumed by Canadian tax calculation. */
  incomeTaxOverrides?: IncomeTaxOverrideSource[];
  /** Audited operator-entered hours and optional keyed rates for bank cash lines. */
  bankCashInputs?: BankCashInputSource[];
  /** Audited issued employer levy amounts recorded as issued on this run. */
  employerLevyAdjustments?: EmployerLevyAdjustmentSource[];
  /** Audited per-cheque vacation bank accruals explicitly declared by an operator. */
  declaredVacationAccruals?: DeclaredVacationAccrualSource[];
  /** Exact sealed source allocations consumed by this pay run, including EIN and jurisdiction identities. */
  openingLevySourceAuthorities?: OpeningLevySourceAuthoritySource[];
  /** Opening rows that can affect employer-wide levies or make their source ambiguous. */
  openingBalanceSources?: OpeningBalanceSourceState[];
  /** Original dated state-account affiliations used by current payroll and its statutory prior. */
  usFilingAccountLineages?: UsFilingAccountLineageSource[];
  claimEntryIds: string[];
}

type UsFilingAccountLineageSource = {
  id: string; filingAccountId: string; federalAccountId: string; subsidiaryId: string;
  effectiveFrom: string; effectiveTo: string | null; sourceReference: string; updatedAt: string;
};

function isUsFilingAccountLineageSource(value: unknown): value is UsFilingAccountLineageSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['id', 'filingAccountId', 'federalAccountId', 'subsidiaryId'].every(key => isUuid(row[key]))
    && isIsoCalendarDate(row.effectiveFrom)
    && (row.effectiveTo === null || isIsoCalendarDate(row.effectiveTo) && row.effectiveTo >= row.effectiveFrom)
    && typeof row.sourceReference === 'string' && row.sourceReference.trim().length > 0 && row.sourceReference.length <= 2000
    && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt));
}

function isComponentStatutoryTreatmentSource(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['id', 'componentId'].every(key => typeof row[key] === 'string' && isUuid(row[key] as string))
    && ['workerCompGroupId', 'employeeWorkerCompGroupId'].every(key =>
      row[key] === null || typeof row[key] === 'string' && isUuid(row[key] as string))
    && typeof row.effectiveFrom === 'string' && isIsoCalendarDate(row.effectiveFrom)
    && (row.effectiveTo === null || typeof row.effectiveTo === 'string'
      && isIsoCalendarDate(row.effectiveTo) && row.effectiveTo >= row.effectiveFrom)
    && Array.isArray(row.programExclusions) && row.programExclusions.every(key => typeof key === 'string')
    && typeof row.vacationable === 'boolean';
}

/** Lock the dated group authority and policy rows before producing the source snapshot. */
async function lockStatutoryTreatmentSources(
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

type CalculationSourceRow = {
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
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function payRunCalculationSourceDigest(
  snapshot: PayRunCalculationSourceSnapshot,
): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function parsePayRunCalculationSource(
  value: unknown,
): PayRunCalculationSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PayRunCalculationSourceSnapshot>;
  if (snapshot.version !== 1
      || !Array.isArray(snapshot.timeEntries)
      || !Array.isArray(snapshot.timeTypes)
      || !Array.isArray(snapshot.payRates)
      || !Array.isArray(snapshot.claimEntryIds)
      || (Object.hasOwn(snapshot, 'compensationPackages') && !Array.isArray(snapshot.compensationPackages))
      || (Object.hasOwn(snapshot, 'assignmentRunPolicies') && !Array.isArray(snapshot.assignmentRunPolicies))
      || (Object.hasOwn(snapshot, 'payComponentStatutoryTreatments') && (!Array.isArray(snapshot.payComponentStatutoryTreatments)
        || snapshot.payComponentStatutoryTreatments.some(row => !isComponentStatutoryTreatmentSource(row))))
      || (Object.hasOwn(snapshot, 'holidayEmployments') && (!Array.isArray(snapshot.holidayEmployments) || snapshot.holidayEmployments.some(row=>!isHolidayEmploymentSource(row))))
      || (Object.hasOwn(snapshot, 'historicalEmploymentRoster') && !Array.isArray(snapshot.historicalEmploymentRoster))
      || (Object.hasOwn(snapshot, 'employerAssignments') && !Array.isArray(snapshot.employerAssignments))
      || (Object.hasOwn(snapshot, 'holidayObligations') && !Array.isArray(snapshot.holidayObligations))
      || (Object.hasOwn(snapshot, 'bonusIncomeReferences') && !Array.isArray(snapshot.bonusIncomeReferences))
      || (Object.hasOwn(snapshot, 'incomeTaxOverrides') && (!Array.isArray(snapshot.incomeTaxOverrides)
        || snapshot.incomeTaxOverrides.some(row => !isIncomeTaxOverrideSource(row))))
      || (Object.hasOwn(snapshot, 'bankCashInputs') && (!Array.isArray(snapshot.bankCashInputs)
        || snapshot.bankCashInputs.some(row => !isBankCashInputSource(row))))
      || (Object.hasOwn(snapshot, 'employerLevyAdjustments') && (!Array.isArray(snapshot.employerLevyAdjustments)
        || snapshot.employerLevyAdjustments.some(row => !isEmployerLevyAdjustmentSource(row))))
      || (Object.hasOwn(snapshot, 'declaredVacationAccruals') && (!Array.isArray(snapshot.declaredVacationAccruals)
        || snapshot.declaredVacationAccruals.some(row => !isDeclaredVacationAccrualSource(row))))
      || (Object.hasOwn(snapshot, 'openingEmployerAuthorities') && (!Array.isArray(snapshot.openingEmployerAuthorities)
        || snapshot.openingEmployerAuthorities.some(row => !isOpeningEmployerAuthoritySource(row))))
      || (Object.hasOwn(snapshot, 'usFilingAccountLineages') && (!Array.isArray(snapshot.usFilingAccountLineages)
        || snapshot.usFilingAccountLineages.some(row => !isUsFilingAccountLineageSource(row))))
      || (Object.hasOwn(snapshot, 'openingLevySourceAuthorities') && (!Array.isArray(snapshot.openingLevySourceAuthorities)
        || snapshot.openingLevySourceAuthorities.some(row => !isOpeningLevySourceAuthoritySource(row))))
      || (Object.hasOwn(snapshot, 'openingBalanceSources') && (!Array.isArray(snapshot.openingBalanceSources)
        || snapshot.openingBalanceSources.some(row => !isOpeningBalanceSourceState(row))))) return null;
  // Snapshots stored before item routing existed carry no itemAccounts; they
  // read as "no mapped items", so the first post-upgrade commit compares
  // honestly and refuses with the items reason instead of a bare selection.
  return {
    ...snapshot,
    itemAccounts: Array.isArray(snapshot.itemAccounts) ? snapshot.itemAccounts : [],
  } as PayRunCalculationSourceSnapshot;
}

/**
 * Re-derive the exact calculation population. The locked form is the commit
 * fence: every existing source row is held through the exact-ID claim and the
 * terminal transition. A new row that becomes visible after this statement's
 * PostgreSQL snapshot is later than the fence and is never claimed by this
 * run; every row visible at the fence must match the stored calculation.
 *
 * The three source CTEs deliberately share ONE SQL statement so their reads
 * cannot be torn across READ COMMITTED snapshots. Calculation runs under
 * REPEATABLE READ as an additional guarantee that these final evidence rows
 * are the same versions its earlier per-stub reads consumed.
 */
export async function payRunCalculationSource(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  lockSources = false,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  calculatedBonusReferences?: readonly CaBonusIncomeReferenceSource[],
): Promise<PayRunCalculationSourceSnapshot | null> {
  if (lockSources) await lockStatutoryTreatmentSources(executor, orgId, documentId, allowedSubsidiaryIds);
  if (lockSources) await executor.execute(sql`
    select adjustment.id
      from pay_run_adjustments adjustment
     where adjustment.org_id=${orgId} and adjustment.pay_run_document_id=${documentId}
       and adjustment.adjustment_type='line'
       and adjustment.note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     order by adjustment.id
     for share of adjustment
  `);
  if (lockSources) await executor.execute(sql`
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
  if (lockSources) await executor.execute(sql`
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
  if (lockSources) await executor.execute(sql`
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
  const rowLock = lockSources ? sql`for update` : sql``;
  const entryRowLock = lockSources ? sql`for update of te` : sql``;
  const result = (await executor.execute<CalculationSourceRow>(sql`
    with run_scope as materialized (
      select r.org_id, r.document_id, r.period_start, r.period_end, r.pay_date, r.run_type,
             d.currency as run_currency, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    stub_employees as materialized (
      select s.employee_party_id, prof.pay_basis, r.period_end, r.run_currency
        from run_scope r
        join pay_stubs s
          on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
        left join parties p
          on p.id = s.employee_party_id and p.org_id = s.org_id
        join employee_payroll_profiles prof
          on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
       where true ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    locked_entries as materialized (
      select te.id, te.employee_party_id, te.worked_on, te.hours, te.time_type_id,
             te.project_id, te.department_id, te.item_id, te.is_billable,
             te.created_at, te.updated_at,
             exists (
               select 1
                 from pay_stub_lines line
                 join pay_stubs stub
                   on stub.id = line.stub_id and stub.org_id = line.org_id
                 join pay_components component
                   on component.id = line.component_id and component.org_id = line.org_id
                where stub.org_id = r.org_id
                  and stub.pay_run_document_id = r.document_id
                  and stub.employee_party_id = te.employee_party_id
                  and component.system_key in ('base_pay', 'overtime')
                  and line.hours is not null
                  and line.time_type_id is not distinct from te.time_type_id
                  and line.project_id is not distinct from te.project_id
                  and line.department_id is not distinct from te.department_id
                  and line.item_id is not distinct from te.item_id
             ) as claimable
        from run_scope r
        join stub_employees employee on true
        join time_entries te
          on te.org_id = r.org_id and te.employee_party_id = employee.employee_party_id
         and te.status = 'approved'
         and te.worked_on between r.period_start and r.period_end
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = r.document_id::text)
       where r.run_type not in ('bonus', 'retro')
       order by te.id
       ${entryRowLock}
    ),
    locked_time_types as materialized (
      select tt.id, tt.name, tt.classification, tt.cost_multiplier,
             tt.exclude_from_wages, tt.updated_at
        from time_types tt
       where tt.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.time_type_id = tt.id
         )
       order by tt.id
       ${rowLock}
    ),
    locked_items as materialized (
      select i.id, i.payroll_expense_account_id, i.updated_at
        from items i
       where i.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.item_id = i.id
         )
       order by i.id
       ${rowLock}
    ),
    locked_rates as materialized (
      select employee.employee_party_id, employee.pay_basis,
             employee.run_currency,
             wage.id as rate_id, wage.basis, wage.rate, wage.annual_hours,
             wage.currency, wage.payroll_rate_scale, wage.payroll_amount_rounding, wage.effective_from, wage.effective_to, wage.updated_at
        from stub_employees employee
        left join lateral (
          select w.id, w.basis, w.rate, w.annual_hours, w.currency, w.payroll_rate_scale, w.payroll_amount_rounding,
                 w.effective_from, w.effective_to, w.updated_at
            from labor_cost_rates w
           where w.org_id = ${orgId}
             and w.employee_party_id = employee.employee_party_id
             and w.is_active and w.effective_from <= employee.period_end
             and (w.effective_to is null or w.effective_to >= employee.period_end)
           order by w.effective_from desc
           limit 1
           ${rowLock}
        ) wage on true
       order by employee.employee_party_id
    ),
    locked_fx as materialized (
      select rate.employee_party_id,
             fx.id, fx.from_currency, fx.to_currency, fx.as_of, fx.rate,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then 'direct' else 'inverse' end as direction,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then fx.rate
                  else (1 / fx.rate)::numeric(19,10) end as resolved_rate,
             fx.updated_at
        from locked_rates rate
        left join lateral (
          select candidate.id, candidate.from_currency, candidate.to_currency,
                 candidate.as_of, candidate.rate, candidate.updated_at
            from fx_rates candidate
           where candidate.org_id = ${orgId}
             and candidate.rate_type = 'spot'
             and candidate.as_of <= (select period_end from run_scope)
             and rate.currency is distinct from rate.run_currency
             and ((candidate.from_currency = rate.currency
                   and candidate.to_currency = rate.run_currency)
               or (candidate.from_currency = rate.run_currency
                   and candidate.to_currency = rate.currency))
           order by candidate.as_of desc,
                    case when candidate.from_currency = rate.currency
                              and candidate.to_currency = rate.run_currency
                         then 0 else 1 end
           limit 1
           ${rowLock}
        ) fx on true
    )
    select exists (select 1 from run_scope) as run_exists,
           (select pay_date::text from run_scope) as pay_date,
           coalesce((select jsonb_agg(employee_party_id::text order by employee_party_id) from stub_employees),'[]'::jsonb) as employee_party_ids,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', entry.id::text,
               'employeePartyId', entry.employee_party_id::text,
               'workedOn', entry.worked_on::text,
               'hours', entry.hours::text,
               'timeTypeId', entry.time_type_id::text,
               'projectId', entry.project_id::text,
               'departmentId', entry.department_id::text,
               'isBillable', entry.is_billable,
               'createdAt', to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'updatedAt', to_char(entry.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'claimable', entry.claimable
             ) order by entry.id)
               from locked_entries entry
           ), '[]'::jsonb) as time_entries,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', tt.id::text,
               'name', tt.name,
               'classification', tt.classification,
               'costMultiplier', tt.cost_multiplier::text,
               'excludeFromWages', tt.exclude_from_wages,
               'updatedAt', to_char(tt.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by tt.id)
               from locked_time_types tt
           ), '[]'::jsonb) as time_types,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', item.id::text,
               'payrollExpenseAccountId', item.payroll_expense_account_id::text,
               'updatedAt', to_char(item.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by item.id)
               from locked_items item
           ), '[]'::jsonb) as item_accounts,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'employeePartyId', rate.employee_party_id::text,
               'payBasis', rate.pay_basis,
               'runCurrency', rate.run_currency,
               'rateId', rate.rate_id::text,
               'basis', rate.basis,
               'rate', rate.rate::text,
               'annualHours', rate.annual_hours::text,
               'currency', rate.currency,
               'effectiveFrom', rate.effective_from::text,
               'effectiveTo', rate.effective_to::text,
               'updatedAt', case when rate.updated_at is null then null else
                 to_char(rate.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
               'fx', case when fx.id is null then null else jsonb_build_object(
                 'id', fx.id::text,
                 'fromCurrency', fx.from_currency,
                 'toCurrency', fx.to_currency,
                 'asOf', fx.as_of::text,
                 'rate', fx.rate::text,
                 'direction', fx.direction,
                 'resolvedRate', fx.resolved_rate::text,
                 'updatedAt', to_char(fx.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               ) end
             ) || case when rate.payroll_rate_scale <> 4 or rate.payroll_amount_rounding <> 'dimension_group'
                  then jsonb_build_object('payrollRateScale', rate.payroll_rate_scale,
                    'payrollAmountRounding', rate.payroll_amount_rounding)
                  else '{}'::jsonb end order by rate.employee_party_id)
               from locked_rates rate
               left join locked_fx fx on fx.employee_party_id = rate.employee_party_id
           ), '[]'::jsonb) as pay_rates,
           coalesce((
             select jsonb_agg(to_jsonb(entry.id::text) order by entry.id)
               from locked_entries entry where entry.claimable
           ), '[]'::jsonb) as claim_entry_ids
  `));
  const row = result.rows[0];
  if (!row?.run_exists) return null;
  const incomeTaxOverrideRows = (await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string;
    amount: string;
    note: string | null;
  }>(sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note
      from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line' and a.replace_component and c.system_key='income_tax'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a, c` : sql``}
  `)).rows;
  const incomeTaxOverrides: IncomeTaxOverrideSource[] = incomeTaxOverrideRows.map((override) => {
    let note: unknown;
    try { note = JSON.parse(override.note ?? "null"); } catch { note = null; }
    const evidence = note && typeof note === "object" && !Array.isArray(note)
      ? note as Record<string, unknown>
      : null;
    const source: IncomeTaxOverrideSource = {
      adjustmentId: override.adjustmentId,
      employeePartyId: override.employeePartyId,
      componentId: override.componentId,
      amount: override.amount,
      reason: typeof evidence?.reason === "string" ? evidence.reason : "",
      sourceReference: typeof evidence?.sourceReference === "string" ? evidence.sourceReference : "",
      requestId: typeof evidence?.requestId === "string" ? evidence.requestId : "",
    };
    if (evidence?.kind !== "income_tax_override" || !isIncomeTaxOverrideSource(source)) {
      throw new PayrollError("The saved income-tax override lacks valid audited amount, reason or source-reference evidence — correct it through the audited override command before calculating or committing");
    }
    return source;
  });
  const employerLevyAdjustmentRows = (await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string;
    amount: string;
    note: string | null;
    systemKey: string;
  }>(sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note,
           c.system_key as "systemKey"
      from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line' and c.kind='employer_contribution'
       and c.system_key in ('eht', 'wcb')
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a, c` : sql``}
  `)).rows;
  const employerLevyAdjustments: EmployerLevyAdjustmentSource[] = employerLevyAdjustmentRows.map((adjustment) => {
    const evidence = parseEmployerLevyAdjustmentEvidence(adjustment.note);
    const source: EmployerLevyAdjustmentSource = {
      adjustmentId: adjustment.adjustmentId,
      employeePartyId: adjustment.employeePartyId,
      componentId: adjustment.componentId,
      amount: adjustment.amount,
      programKey: evidence?.programKey ?? "",
      workerCompGroupId: evidence?.workerCompGroupId ?? null,
      sourceKey: evidence?.sourceKey ?? "",
      reason: evidence?.reason ?? "",
      sourceReference: evidence?.sourceReference ?? "",
      requestId: evidence?.requestId ?? "",
    };
    if (!evidence || EMPLOYER_LEVY_PROGRAMS[evidence.programKey].systemKey !== adjustment.systemKey
      || !isEmployerLevyAdjustmentSource(source)) {
      throw new PayrollError("The saved employer levy adjustment lacks valid audited programme, amount, reason or source-reference evidence — correct it through the audited employer levy adjustment command before calculating or committing");
    }
    return source;
  });
  const bankCashRows = (await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string | null;
    amount: string;
    hours: string | null;
    note: string | null;
    runType: string;
    componentActive: boolean;
    componentKind: string;
    componentUnit: string | null;
    replaceComponent: boolean;
    earnedFrom: string | null;
    earnedTo: string | null;
    paymentKind: string;
    activeBankPlanCount: string;
    bankPlanId: string | null;
    bankPlanUnit: string | null;
    bankPlanDirection: string | null;
    bankPlanAllowsNegativeBalance: boolean | null;
    bankPlanPayoutComponentId: string | null;
    bankPlanDepositComponentId: string | null;
  }>(sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.hours::text as hours, a.note,
           run.run_type as "runType",
           c.is_active as "componentActive", c.kind as "componentKind", c.unit_of_measure as "componentUnit", c.payment_kind as "paymentKind",
           a.replace_component as "replaceComponent", a.earned_from::text as "earnedFrom", a.earned_to::text as "earnedTo",
           (select count(*)::text from entitlement_plans plan
             where plan.org_id=a.org_id and plan.is_active and plan.unit in ('hours','money')
               and (plan.payout_component_id=a.component_id or plan.deposit_component_id=a.component_id)) as "activeBankPlanCount",
           bank_plan.id::text as "bankPlanId", bank_plan.unit as "bankPlanUnit",
           bank_plan.direction as "bankPlanDirection", bank_plan.allow_negative_balance as "bankPlanAllowsNegativeBalance",
           bank_plan.payout_component_id::text as "bankPlanPayoutComponentId",
           bank_plan.deposit_component_id::text as "bankPlanDepositComponentId"
      from pay_run_adjustments a
      join pay_runs run on run.org_id=a.org_id and run.document_id=a.pay_run_document_id
      left join pay_components c on c.org_id=a.org_id and c.id=a.component_id
      left join lateral (
        select plan.id,plan.unit,plan.direction,plan.allow_negative_balance,
               plan.payout_component_id,plan.deposit_component_id
          from entitlement_plans plan
         where plan.org_id=a.org_id and plan.is_active and plan.unit in ('hours','money')
           and (plan.payout_component_id=a.component_id or plan.deposit_component_id=a.component_id)
         order by plan.id limit 1
      ) bank_plan on true
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a` : sql``}
  `)).rows;
  const bankCashInputs: BankCashInputSource[] = [];
  for (const input of bankCashRows) {
    if (!isBankCashInputEvidenceCandidate(input.note)) continue;
    const evidence = parseBankCashInputEvidence(input.note);
    const hours = input.hours === null ? null : canonicalDecimal(input.hours, 2);
    const amount = canonicalDecimal(input.amount, 4);
    const withdrawal = hours !== null && cmp(hours, "0") > 0;
    const deposit = hours !== null && cmp(hours, "0") < 0;
    if (!evidence || input.runType === "termination" || !input.componentId || input.hours === null || hours === null || amount === null
      || input.componentActive !== true || input.componentKind !== "earning" || input.paymentKind !== "cash"
      || input.componentUnit === "quantity" || input.replaceComponent !== false || input.earnedFrom !== null || input.earnedTo !== null
      || input.activeBankPlanCount !== "1"
      || !input.bankPlanId || typeof input.bankPlanUnit !== "string" || !["hours", "money"].includes(input.bankPlanUnit) || input.bankPlanDirection === null
      || typeof input.bankPlanAllowsNegativeBalance !== "boolean"
      || (withdrawal && input.bankPlanPayoutComponentId !== input.componentId)
      || (deposit && input.bankPlanDepositComponentId !== input.componentId)
      || (!withdrawal && !deposit)) {
      throw new PayrollError("The saved bank payout input no longer identifies one active cash bank component with valid signed hours; correct it through the audited bank cash input command before calculating or committing");
    }
    // A split is valued at the native wage on the PAY DATE, never the
    // period-end wage the run's payRates retain: resolve that dated source
    // here, on this executor and under the same source locks, and freeze
    // it with the input. Re-resolving at commit therefore stales on a
    // pay-date-only wage change even when the period-end wage is unchanged.
    // The observed wage currency is retained verbatim, including a foreign
    // one the line phase refuses: hiding it would let a later currency
    // edit pass as unchanged evidence instead of staling the calculation.
    let bankValuation: BankCashPayDateValuation | null | undefined;
    if (evidence.outsideBankAmount !== undefined) {
      if (!bankCashFundingSplit(amount, evidence.outsideBankAmount)) {
        throw new PayrollError("The saved bank payout split no longer has a positive bank-funded amount below the issued cash amount; correct it through the audited bank cash input command before calculating or committing");
      }
      bankValuation = await resolveBankPayDateValuation(executor, orgId, input.employeePartyId, row.pay_date, lockSources);
    }
    const source: BankCashInputSource = {
      adjustmentId: input.adjustmentId,
      employeePartyId: input.employeePartyId,
      componentId: input.componentId,
      amount,
      hours,
      bankPlanId: input.bankPlanId,
      bankPlanUnit: input.bankPlanUnit,
      bankPlanDirection: input.bankPlanDirection,
      bankPlanAllowsNegativeBalance: input.bankPlanAllowsNegativeBalance,
      bankPlanPayoutComponentId: input.bankPlanPayoutComponentId,
      bankPlanDepositComponentId: input.bankPlanDepositComponentId,
      reason: evidence.reason,
      sourceReference: evidence.sourceReference,
      requestId: evidence.requestId,
      rate: evidence.rate,
      ...(evidence.outsideBankAmount === undefined ? {} : { outsideBankAmount: evidence.outsideBankAmount }),
      ...(bankValuation === undefined ? {} : { bankValuation }),
    };
    if (evidence.requestId !== input.adjustmentId || !isBankCashInputSource(source)) {
      throw new PayrollError("The saved bank payout input amount, keyed rate or audited source evidence no longer agrees; correct it through the audited bank cash input command before calculating or committing");
    }
    bankCashInputs.push(source);
  }
  const declaredAccrualRows = (await executor.execute<{
    adjustmentId: string; employeePartyId: string; componentId: string | null; amount: string; note: string | null;
    componentActive: boolean | null; componentKind: string | null; planCount: string;
    planId: string | null; planUnit: string | null; planDirection: string | null;
    planSystemKey: string | null; planAccrualComponentId: string | null;
  }>(sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note,
           c.is_active as "componentActive", c.kind as "componentKind",
           plan.plan_count as "planCount", plan.id as "planId", plan.unit as "planUnit",
           plan.direction as "planDirection", plan.system_key as "planSystemKey",
           plan.accrual_component_id as "planAccrualComponentId"
      from pay_run_adjustments a
      left join pay_components c on c.org_id=a.org_id and c.id=a.component_id
      left join lateral (
        select count(*)::text as plan_count, min(p.id::text) as id, min(p.unit) as unit,
               min(p.direction) as direction, min(p.system_key) as system_key,
               min(p.accrual_component_id::text) as accrual_component_id
          from entitlement_plans p
         where p.org_id=a.org_id and p.is_active and p.system_key='vacation'
           and p.accrual_component_id=a.component_id
      ) plan on true
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
       and a.note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     order by a.employee_party_id,a.id
  `)).rows;
  const declaredVacationAccruals: DeclaredVacationAccrualSource[] = declaredAccrualRows.map((input) => {
    const evidence = parseDeclaredVacationAccrualEvidence(input.note);
    const amount = canonicalDecimal(input.amount, 4);
    const source = {
      adjustmentId: input.adjustmentId,
      employeePartyId: input.employeePartyId,
      componentId: input.componentId ?? "",
      planId: input.planId ?? "",
      amount: amount ?? "",
      reason: evidence?.reason ?? "",
      sourceReference: evidence?.sourceReference ?? "",
      requestId: evidence?.requestId ?? "",
    };
    if (!evidence || !input.componentId || !amount || input.componentActive !== true
      || input.componentKind !== "employer_contribution" || input.planCount !== "1"
      || input.planUnit !== "money" || input.planDirection !== "accrue"
      || input.planSystemKey !== "vacation" || input.planAccrualComponentId !== input.componentId
      || evidence.requestId !== input.adjustmentId || !isDeclaredVacationAccrualSource(source)) {
      throw new PayrollError("The saved declared vacation accrual no longer matches an active money vacation plan and audited cheque source; correct it through the declared accrual command before calculating or committing.");
    }
    return source;
  });
  const assignmentRunPolicies = (await executor.execute<NonNullable<PayRunCalculationSourceSnapshot['assignmentRunPolicies']>[number]>(sql`
    select a.id::text, a.employee_party_id::text as "employeePartyId", a.employment_id::text as "employmentId",
      a.component_id::text as "componentId", a.run_applicability as policy,
      a.effective_from::text as "from", a.effective_to::text as "to"
    from employee_pay_components a join pay_runs r on r.org_id=a.org_id and r.document_id=${documentId}
    where a.org_id=${orgId} and a.is_active and a.run_applicability <> 'standard_runs'
      and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
      and a.effective_from <= r.period_end and (a.effective_to is null or a.effective_to >= r.period_start)
    order by a.id
  `)).rows;
  const payComponentStatutoryTreatments = (await executor.execute<NonNullable<PayRunCalculationSourceSnapshot['payComponentStatutoryTreatments']>[number]>(sql`
    select treatment.id::text as id,
      treatment.pay_component_id::text as "componentId",
      treatment.worker_comp_group_id::text as "workerCompGroupId",
      (public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))::text as "employeeWorkerCompGroupId",
      treatment.effective_from::text as "effectiveFrom",
      treatment.effective_to::text as "effectiveTo",
      treatment.program_exclusions as "programExclusions",
      treatment.vacationable
    from pay_runs r
    join pay_stubs stub on stub.org_id=r.org_id and stub.pay_run_document_id=r.document_id
    join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
    join lateral (
      select treatment.*
        from pay_component_statutory_treatments treatment
       where treatment.org_id=line.org_id and treatment.pay_component_id=line.component_id
         and treatment.effective_from<=r.pay_date
         and (treatment.effective_to is null or treatment.effective_to>=r.pay_date)
         and (treatment.worker_comp_group_id is null
           or treatment.worker_comp_group_id is not distinct from
             public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))
       order by (treatment.worker_comp_group_id is not null) desc
       limit 1
    ) treatment on true
    where r.org_id=${orgId} and r.document_id=${documentId}
      and line.kind='earning' and line.component_id is not null
    group by treatment.id::text, treatment.pay_component_id::text, treatment.worker_comp_group_id::text,
      (public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))::text,
      treatment.effective_from::text, treatment.effective_to::text, treatment.program_exclusions, treatment.vacationable
     order by "componentId", "workerCompGroupId" nulls first, "effectiveFrom", id
  `)).rows;
  const uncoveredEarningComponents = (await executor.execute<{ component_id: string }>(sql`
    select distinct line.component_id::text as component_id
    from pay_runs r
      join pay_stubs stub on stub.org_id=r.org_id and stub.pay_run_document_id=r.document_id
      join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
     where r.org_id=${orgId} and r.document_id=${documentId}
       and line.kind='earning' and line.component_id is not null
       and not exists (
         select 1 from pay_component_statutory_treatments treatment
          where treatment.org_id=line.org_id and treatment.pay_component_id=line.component_id
            and treatment.effective_from<=r.pay_date
            and (treatment.effective_to is null or treatment.effective_to>=r.pay_date)
            and (treatment.worker_comp_group_id is null
              or treatment.worker_comp_group_id is not distinct from
                public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))
       )
     order by component_id
  `)).rows;
  if (uncoveredEarningComponents.length) {
    throw new PayrollError(`No effective statutory treatment covers earning component ${uncoveredEarningComponents[0]!.component_id} on this pay date; add a dated treatment in Payroll Setup before calculating.`);
  }
  const openingRows = (await executor.execute<OpeningEmployerAuthoritySource & { matches: boolean }>(sql`
    select a.id::text,a.opening_balance_id::text as "openingBalanceId",a.employee_party_id::text as "employeePartyId",
      a.tax_year as "taxYear",a.subsidiary_id::text as "subsidiaryId",a.source_file_id::text as "sourceFileId",
      a.source_version_id::text as "sourceVersionId",a.source_sha256 as "sourceSha256",a.opening_sha256 as "openingSha256",
      (a.opening_snapshot=to_jsonb(b)
        and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')) as matches
    from payroll_opening_employer_authorities a
      join payroll_opening_balances b on b.org_id=a.org_id and b.id=a.opening_balance_id
      join pay_runs r on r.org_id=a.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where a.org_id=${orgId} and a.tax_year=r.tax_year and a.subsidiary_id=d.subsidiary_id
      and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by a.employee_party_id,a.id
    ${lockSources ? sql`for share of a,b` : sql``}
  `)).rows;
  const openingEmployerAuthorities: OpeningEmployerAuthoritySource[] = openingRows.map(({ matches, ...source }) => {
    if (!matches || !isOpeningEmployerAuthoritySource(source)) {
      throw new PayrollError('The original opening employer source no longer matches its retained amounts — preserve its evidence and review the native opening qualification before calculating or committing');
    }
    return source;
  });
  const openingLevyRows = (await executor.execute<OpeningLevySourceAuthoritySource & { matches: boolean }>(sql`
    select h.id::text,h.opening_balance_id::text as "openingBalanceId",h.employee_party_id::text as "employeePartyId",
      h.tax_year as "taxYear",h.subsidiary_id::text as "subsidiaryId",h.source_file_id::text as "sourceFileId",
      h.source_version_id::text as "sourceVersionId",h.source_sha256 as "sourceSha256",h.opening_sha256 as "openingSha256",
      h.employer_authority_id::text as "employerAuthorityId",h.allocation_sha256 as "allocationSha256",
      h.allocation_snapshot as allocations,h.opening_children_sha256 as "openingChildrenSha256",
      h.original_country as "originalCountry",h.original_currency as "originalCurrency",
      h.coverage_start::text as "coverageStart",h.coverage_end::text as "coverageEnd",h.coverage_complete as "coverageComplete",
      (h.sealed and h.employer_authority_id=a.id and h.opening_sha256=a.opening_sha256
                and a.opening_snapshot=to_jsonb(b) and a.opening_sha256=encode(public.digest(to_jsonb(b)::text,'sha256'),'hex')
        and h.employee_party_id=b.employee_party_id and h.tax_year=b.tax_year and h.subsidiary_id=a.subsidiary_id
        and h.allocation_snapshot=(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=h.org_id and x.authority_id=h.id)
        and exists (select 1 from files f join file_versions v on v.file_id=f.id
          where f.org_id=h.org_id and f.id=h.source_file_id and v.id=h.source_version_id and v.content_hash=h.source_sha256)
        and h.opening_children_snapshot=public.payroll_opening_source_children(h.org_id,h.opening_balance_id,h.employee_party_id,h.tax_year)
        and h.opening_children_sha256=encode(public.digest(h.opening_children_snapshot::text,'sha256'),'hex')
        and h.allocation_sha256=encode(public.digest(h.allocation_snapshot::text,'sha256'),'hex')) as matches
      from payroll_opening_levy_source_authorities h
      join payroll_opening_balances b on b.org_id=h.org_id and b.id=h.opening_balance_id and ${currentOpeningLevySourceSql('h')}
      join payroll_opening_employer_authorities a on a.org_id=h.org_id and a.opening_balance_id=b.id
      join pay_runs r on r.org_id=h.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
     where h.org_id=${orgId} and h.tax_year=r.tax_year and h.subsidiary_id=d.subsidiary_id
     order by h.employee_party_id,h.id
     ${lockSources ? sql`for share of h,b,a` : sql``}
  `)).rows;
  const openingLevySourceAuthorities: OpeningLevySourceAuthoritySource[] = openingLevyRows.map(({ matches, ...source }) => {
    if (!matches || !isOpeningLevySourceAuthoritySource(source)) {
      throw new PayrollError('The original statutory levy opening allocations no longer match their retained legal employer, source version and exact allocation — preserve the evidence and review Payroll → Opening balances → Levy source');
    }
    return source;
  });
  const openingBalanceSources = (await executor.execute<OpeningBalanceSourceState>(sql`
    select b.id::text as "openingBalanceId",
      encode(public.digest(jsonb_build_object(
        'opening',to_jsonb(b),
        'employerAuthority',to_jsonb(a),
        'levyAuthority',to_jsonb(h),
        'allocations',(select coalesce(jsonb_agg(jsonb_build_object(
          'programKey',x.program_key,'region',x.region,'subRegion',x.sub_region,
          'filingAccountId',x.filing_account_id,'federalAccountId',x.federal_account_id,'amount',x.amount::text
        ) order by x.program_key,x.region,x.sub_region,x.filing_account_id nulls first,x.federal_account_id nulls first),'[]'::jsonb)
          from payroll_opening_levy_source_allocations x where x.org_id=b.org_id and x.authority_id=h.id)
      )::text,'sha256'),'hex') as "sourceDigest"
      from payroll_opening_balances b
      join pay_runs r on r.org_id=b.org_id and r.document_id=${documentId}
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      left join payroll_opening_employer_authorities a on a.org_id=b.org_id and a.opening_balance_id=b.id
      left join payroll_opening_levy_source_authorities h on h.org_id=b.org_id and h.opening_balance_id=b.id and ${currentOpeningLevySourceSql('h')}
     where b.org_id=${orgId} and b.tax_year=r.tax_year
       and (a.id is null or a.subsidiary_id=d.subsidiary_id)
     order by b.id
     ${lockSources ? sql`for share of b` : sql``}
  `)).rows;
  const historicalEmploymentRoster = await historicalEmploymentRosterSource(executor, orgId, documentId, allowedSubsidiaryIds);
  const holidaySubjects=(await executor.execute<{orgId:string;employeePartyId:string;employmentId:string;subsidiaryId:string;employeeName:string}>(sql`
    select s.org_id as "orgId",s.employee_party_id as "employeePartyId",s.employment_id as "employmentId",
      d.subsidiary_id as "subsidiaryId",p.display_name as "employeeName"
    from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    join orgs o on o.id=s.org_id join parties p on p.org_id=s.org_id and p.id=s.employee_party_id
    where s.org_id=${orgId} and r.document_id=${documentId} and s.country='CA' and r.run_type not in ('bonus','retro')
      and o.settings#>>'{payroll,statutoryHolidayPay}'='true'
      and s.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by s.employee_party_id,s.employment_id
  `)).rows;
  const holidayEmployments:StatutoryHolidayEmploymentSource[]=[];
  for(const subject of holidaySubjects) {
    if(lockSources) await executor.execute(sql`select id from worker_employments where org_id=${orgId} and id=${subject.employmentId} for share`);
    holidayEmployments.push(...await statutoryHolidayEmploymentSource(executor,subject));
  }

  const employerAssignments = await employeeEmployerAssignmentHistory(executor, { orgId, payDate: row.pay_date, employeePartyIds: row.employee_party_ids ?? [] });
  const compensationPackages = await compensationPackageRunSource(executor, orgId, documentId, allowedSubsidiaryIds, lockSources);
  const holidayObligations = await holidayObligationRunSource(executor, orgId, documentId, allowedSubsidiaryIds);
  // Calculate supplies the exact identities used by its successful statutory
  // passes. Commit/readiness re-resolve them through the same authoritative
  // service so a different selected history row changes the protected digest.
  const bonusSubjects = (await executor.execute<CaBonusIncomeReferenceScope & { income: string }>(sql`
    select s.org_id as "orgId",r.document_id as "documentId",
      s.employee_party_id as "employeePartyId",s.employment_id as "employmentId",
      d.subsidiary_id as "subsidiaryId",s.filing_account_id as "filingAccountId",
      d.currency,r.pay_schedule_id as "payScheduleId",s.tax_year as "taxYear",
      r.pay_date::text as "payDate",r.period_end::text as "periodEnd",
      s.factors->>'CA_BONUS_I_REFERENCE' as income
    from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${orgId} and r.document_id=${documentId} and s.country='CA'
      and s.factors ? 'CA_BONUS_I_REFERENCE'
      and s.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
    order by s.employee_party_id
  `)).rows;
  const bonusIncomeReferences: CaBonusIncomeReferenceSource[] = [];
  if (calculatedBonusReferences && calculatedBonusReferences.length !== bonusSubjects.length) {
    throw new PayrollError('Canadian bonus calculation source identities do not cover the calculated employee population — recalculate the pay run');
  }
  for (const subject of bonusSubjects) {
    const { income, ...scope } = subject;
    const source = calculatedBonusReferences
      ? calculatedBonusReferences.find(source => source.employeePartyId === subject.employeePartyId)
      : await resolveCaBonusIncomeReference(executor, scope);
    if (!source || (calculatedBonusReferences &&
      (Object.entries(scope).some(([key,value]) => source[key as keyof CaBonusIncomeReferenceScope] !== value)
        || source.income !== income))) {
      throw new PayrollError('Canadian bonus calculation source identity differs from the income actually used — recalculate the pay run');
    }
    bonusIncomeReferences.push(source);
  }
  const usFilingAccountLineages = (await executor.execute<UsFilingAccountLineageSource>(sql`
    select affiliation.id::text as id, affiliation.filing_account_id::text as "filingAccountId",
      affiliation.federal_account_id::text as "federalAccountId", affiliation.subsidiary_id::text as "subsidiaryId",
      affiliation.effective_from::text as "effectiveFrom", affiliation.effective_to::text as "effectiveTo",
      affiliation.source_reference as "sourceReference", affiliation.updated_at::text as "updatedAt"
    from payroll_us_filing_account_employer_lineage affiliation
    join pay_runs run on run.org_id=affiliation.org_id and run.document_id=${documentId}::uuid
    join documents owner on owner.org_id=run.org_id and owner.id=run.document_id
      and owner.subsidiary_id=affiliation.subsidiary_id
    where affiliation.org_id=${orgId}::uuid
      and exists (select 1 from pay_stubs current_stub
        where current_stub.org_id=run.org_id and current_stub.pay_run_document_id=run.document_id
          and current_stub.country='US')
      and (run.pay_date between affiliation.effective_from and coalesce(affiliation.effective_to,'infinity'::date)
        or exists (select 1 from pay_stubs prior_stub
          join pay_runs prior_run on prior_run.org_id=prior_stub.org_id and prior_run.document_id=prior_stub.pay_run_document_id
          join documents prior_owner on prior_owner.org_id=prior_run.org_id and prior_owner.id=prior_run.document_id
          where prior_stub.org_id=run.org_id and prior_stub.tax_year=run.tax_year and prior_stub.country='US'
            and prior_stub.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
            and prior_stub.filing_account_id=affiliation.filing_account_id
            and prior_owner.subsidiary_id=owner.subsidiary_id and prior_owner.status<>'voided'
            and prior_run.run_status='committed' and prior_run.document_id<>run.document_id
            and prior_stub.pay_date between affiliation.effective_from and coalesce(affiliation.effective_to,'infinity'::date)))
    order by affiliation.id for share of affiliation
  `)).rows;
  if (usFilingAccountLineages.some(source => !isUsFilingAccountLineageSource(source))) {
    throw new PayrollError('US filing-account affiliation evidence is malformed — qualify the original employer registration before calculating');
  }
  return {
    version: 1,
    timeEntries: row.time_entries ?? [],
    timeTypes: row.time_types ?? [],
    payRates: row.pay_rates ?? [],
    itemAccounts: row.item_accounts ?? [],
    // Omit unused package fields to preserve the protected evidence shape.
    ...(compensationPackages.length ? { compensationPackages } : {}),
    ...(employerAssignments.length ? { employerAssignments } : {}),
    ...(assignmentRunPolicies.length ? { assignmentRunPolicies } : {}),
    payComponentStatutoryTreatments,
    ...(historicalEmploymentRoster.length ? { historicalEmploymentRoster } : {}),
    ...(holidayObligations.length ? { holidayObligations } : {}),
    ...(holidayEmployments.length ? { holidayEmployments } : {}),
    ...(bonusIncomeReferences.length ? { bonusIncomeReferences } : {}),
    ...(openingEmployerAuthorities.length ? { openingEmployerAuthorities } : {}),
    ...(incomeTaxOverrides.length ? { incomeTaxOverrides } : {}),
    ...(bankCashInputs.length ? { bankCashInputs } : {}),
    ...(employerLevyAdjustments.length ? { employerLevyAdjustments } : {}),
    ...(declaredVacationAccruals.length ? { declaredVacationAccruals } : {}),
    ...(openingLevySourceAuthorities.length ? { openingLevySourceAuthorities } : {}),
    ...(openingBalanceSources.length ? { openingBalanceSources } : {}),
    ...(usFilingAccountLineages.length ? { usFilingAccountLineages } : {}),
    claimEntryIds: row.claim_entry_ids ?? [],
  };
}

export function payRunCalculationSourceChanges(
  stored: PayRunCalculationSourceSnapshot,
  current: PayRunCalculationSourceSnapshot,
): { time: boolean; timeTypes: boolean; wages: boolean; items: boolean; components: boolean; compensationPackages: boolean; holidayObligations: boolean; roster: boolean; openingBalances: boolean; incomeTaxOverrides: boolean; bankCashInputs: boolean; declaredVacationAccruals: boolean; employerLevyAdjustments: boolean } {
  return {
    openingBalances: canonicalJson(stored.openingEmployerAuthorities ?? []) !== canonicalJson(current.openingEmployerAuthorities ?? [])
      || canonicalJson(stored.openingLevySourceAuthorities ?? []) !== canonicalJson(current.openingLevySourceAuthorities ?? [])
      || canonicalJson(stored.openingBalanceSources ?? []) !== canonicalJson(current.openingBalanceSources ?? []),
    incomeTaxOverrides: canonicalJson(stored.incomeTaxOverrides ?? []) !== canonicalJson(current.incomeTaxOverrides ?? []),
    bankCashInputs: canonicalJson(stored.bankCashInputs ?? []) !== canonicalJson(current.bankCashInputs ?? []),
    employerLevyAdjustments: canonicalJson(stored.employerLevyAdjustments ?? []) !== canonicalJson(current.employerLevyAdjustments ?? []),
    declaredVacationAccruals: canonicalJson(stored.declaredVacationAccruals ?? []) !== canonicalJson(current.declaredVacationAccruals ?? []),
    time: canonicalJson(stored.timeEntries) !== canonicalJson(current.timeEntries)
      || canonicalJson(stored.claimEntryIds) !== canonicalJson(current.claimEntryIds),
    timeTypes: canonicalJson(stored.timeTypes) !== canonicalJson(current.timeTypes),
    wages: canonicalJson(stored.payRates) !== canonicalJson(current.payRates)
      || canonicalJson(stored.bonusIncomeReferences ?? []) !== canonicalJson(current.bonusIncomeReferences ?? []),
    compensationPackages: canonicalJson(stored.compensationPackages ?? []) !== canonicalJson(current.compensationPackages ?? []),
    components: canonicalJson(stored.assignmentRunPolicies ?? []) !== canonicalJson(current.assignmentRunPolicies ?? [])
      || canonicalJson(stored.payComponentStatutoryTreatments ?? []) !== canonicalJson(current.payComponentStatutoryTreatments ?? []),
    holidayObligations: canonicalJson(stored.holidayObligations ?? []) !== canonicalJson(current.holidayObligations ?? [])
      || canonicalJson(stored.holidayEmployments ?? []) !== canonicalJson(current.holidayEmployments ?? []),
    roster: canonicalJson(stored.usFilingAccountLineages ?? []) !== canonicalJson(current.usFilingAccountLineages ?? [])
      || canonicalJson(stored.employerAssignments ?? []) !== canonicalJson(current.employerAssignments ?? [])
      || canonicalJson(stored.historicalEmploymentRoster ?? []) !== canonicalJson(current.historicalEmploymentRoster ?? []),
    items: canonicalJson(stored.itemAccounts ?? []) !== canonicalJson(current.itemAccounts ?? []),
  };
}

/**
 * One employee's refused or warned calculation outcome.
 *
 * This is the persisted refusal record (migration 0182): calculate writes the
 * whole array wholesale on every pass, commit gates on the `refusal` entries,
 * and the run page renders them back. `employee` is the display name at
 * calculate time — narrative, not identity; the gate and the acknowledgement
 * bind to `employeePartyId`. `message` is the pack's (or engine's) own
 * refusal/warning text, carried verbatim, never rewritten.
 *
 * `kind` is what keeps the gate honest: only an in-scope employee with no
 * stub (`refusal`) can block a commit. A `warning` rides a stub that exists
 * (an entitlement bank over its limit — correct output the operator decides
 * on), and `out-of-scope` is the run's own scope rule refusing someone it was
 * never meant to pay (a final-pay stranger); neither blocks.
 *
 * The index signature is deliberate room, not looseness: the holiday
 * attestation work extends these entries additively (holiday keys, needed
 * facts) without reshaping what commit already binds to.
 */
export interface PayRunCalculationError {
  employeePartyId: string;
  employee: string;
  message: string;
  kind: "refusal" | "warning" | "out-of-scope";
  [key: string]: unknown;
}

/**
 * A recorded decision to commit a run that leaves in-scope employees unpaid.
 *
 * `errorsDigest` binds the acknowledgement to the EXACT in-scope refusal set
 * it names (see `payRunRefusalDigest`): acknowledging one refusal set and
 * then recalculating into another leaves a stale acknowledgement the commit
 * gate refuses, so an operator can never wave through a situation they did
 * not see. `refusals` is the human-readable half — who was left out and why,
 * retrievable long after posting.
 */
export interface PayRunRefusalAcknowledgement {
  version: 1;
  acknowledgedBy: string;
  acknowledgedAt: string;
  errorsDigest: string;
  refusals: PayRunCalculationError[];
}

/** The in-scope refusals inside a stored error set — what the gate binds to. */
export function payRunCalculationRefusals(
  errors: PayRunCalculationError[],
): PayRunCalculationError[] {
  return errors.filter((entry) => entry.kind === "refusal");
}

/**
 * Digest of an in-scope refusal set, sorted by party so entry order can never
 * distinguish two identical sets. The acknowledgement records this digest and
 * commit recomputes it; any recalculation that changes who is refused (or
 * why, the messages are digested too) invalidates the old acknowledgement.
 */
export function payRunRefusalDigest(refusals: PayRunCalculationError[]): string {
  const ordered = [...refusals].sort((a, b) =>
    a.employeePartyId < b.employeePartyId ? -1 : a.employeePartyId > b.employeePartyId ? 1 : 0,
  );
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Parse the persisted calculation errors. Null (legacy runs calculated before
 * refusal tracking, or never calculated) is NOT the same as empty: callers
 * must send the run through a recalculation rather than assume nobody was
 * refused. Corrupt entries fail the same closed way.
 */
export function parsePayRunCalculationErrors(
  value: unknown,
): PayRunCalculationError[] | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })() : value;
  if (!Array.isArray(raw)) return null;
  const parsed: PayRunCalculationError[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.employeePartyId !== "string" || typeof record.employee !== "string"
        || typeof record.message !== "string"
        || (record.kind !== "refusal" && record.kind !== "warning" && record.kind !== "out-of-scope")) {
      return null;
    }
    parsed.push({ ...record } as PayRunCalculationError);
  }
  return parsed;
}

/** Parse a stored refusal acknowledgement; corrupt or absent reads as none. */
export function parsePayRunRefusalAcknowledgement(
  value: unknown,
): PayRunRefusalAcknowledgement | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? (() => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  })() : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || typeof record.acknowledgedBy !== "string"
      || typeof record.acknowledgedAt !== "string" || typeof record.errorsDigest !== "string"
      || parsePayRunCalculationErrors(record.refusals) == null) {
    return null;
  }
  return {
    version: 1,
    acknowledgedBy: String(record.acknowledgedBy),
    acknowledgedAt: String(record.acknowledgedAt),
    errorsDigest: String(record.errorsDigest),
    refusals: parsePayRunCalculationErrors(record.refusals) ?? [],
  };
}
