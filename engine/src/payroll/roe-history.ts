import { canonicalDecimal } from "../money/exact-decimal.ts";
import { moneyRefusal } from "../money/decimal-refusal.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { fromUnits, toUnits, wholeDigits } from "../money/money.ts";
import { authorizeRoeReportingEmployee, type RoeEmployeeScope } from "./roe-separation-facts.ts";
import { takeEmployeeConfigurationFence } from "./fences.ts";
import { assertRoeLegacySourcesBound } from "./canada/roe-event-source.ts";
import { PayrollError } from "./error.ts";
import { retainedPayPeriodProblem } from "./retained-period-calendar.ts";
import {
  prepareRoeSeparationReportingBasis,
  validateRoeSeparationCategory,
} from "./canada/roe-separation-reporting.ts";

export type RoeReportingSource = {
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  insuranceReference: string;
  hoursReference: string;
  reason: string;
};
export type RoeHistorySubject = RoeEmployeeScope & { employmentId: string; subsidiaryId: string };
export type RoePriorPeriodInput = RoeReportingSource & {
  filingAccountId: string;
  payScheduleId: string;
  frequency: "weekly" | "biweekly" | "semi_monthly" | "monthly";
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  earnedFrom: string | null;
  earnedTo: string | null;
  insurableEarnings: unknown;
  insurableHours: unknown;
  nilPeriod: boolean;
  expectedId: string | null;
  expectedUpdatedAt: string | null;
};
export type RoeLineEvidenceInput = RoeReportingSource & {
  payStubLineId: string;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  earnedFrom: string | null;
  earnedTo: string | null;
  isInsurable: boolean;
  insurableHours: unknown;
  reportingBasis?: "service" | "separation_payment";
  separationEventId?: string | null;
  separationPaymentId?: string | null;
  separationBlock?: "17A" | "17C" | null;
  separationCategoryCode?: string | null;
  expectedId: string | null;
  expectedUpdatedAt: string | null;
};
export type RoePriorPeriod = {
  id: string;
  employmentId: string;
  subsidiaryId: string;
  filingAccountId: string;
  payScheduleId: string;
  frequency: string;
  periodStart: string;
  periodEnd: string;
  payDate: string | null;
  earnedFrom: string | null;
  earnedTo: string | null;
  insurableEarnings: string;
  insurableHours: string;
  nilPeriod: boolean;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  insuranceReference: string;
  hoursReference: string;
  reason: string;
  updatedAt: string;
};
export type RoeLineEvidence = {
  id: string;
  payStubLineId: string;
  lineSnapshot: Record<string, unknown>;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  earnedFrom: string | null;
  earnedTo: string | null;
  isInsurable: boolean;
  insurableHours: string;
  reportingBasis: "service" | "separation_payment";
  separationEventId: string | null;
  separationPaymentId: string | null;
  separationBasisSnapshot: Record<string, unknown> | null;
  separationBlock: "17A" | "17C" | null;
  separationCategoryCode: string | null;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
  insuranceReference: string;
  hoursReference: string;
  reason: string;
  updatedAt: string;
};
const SOURCE_COLUMNS = sql`source_file_id as "sourceFileId",source_version_id as "sourceVersionId",source_sha256 as "sourceSha256",
 source_reference as "sourceReference",insurance_reference as "insuranceReference",hours_reference as "hoursReference",
 change_reason as reason,updated_at::text as "updatedAt"`;
const PERIOD_COLUMNS = sql`id,employment_id as "employmentId",subsidiary_id as "subsidiaryId",filing_account_id as "filingAccountId",
 pay_schedule_id as "payScheduleId",frequency,period_start::text as "periodStart",period_end::text as "periodEnd",pay_date::text as "payDate",
 earned_from::text as "earnedFrom",earned_to::text as "earnedTo",insurable_earnings::text as "insurableEarnings",insurable_hours::text as "insurableHours",
 nil_period as "nilPeriod",${SOURCE_COLUMNS}`;
const LINE_COLUMNS = sql`id,pay_stub_line_id as "payStubLineId",line_snapshot as "lineSnapshot",
 report_period_start::text as "reportPeriodStart",report_period_end::text as "reportPeriodEnd",earned_from::text as "earnedFrom",earned_to::text as "earnedTo",
 reporting_basis as "reportingBasis",separation_event_id as "separationEventId",separation_payment_id as "separationPaymentId",separation_basis_snapshot as "separationBasisSnapshot",
 separation_basis_snapshot->'classification'->>'block' as "separationBlock",separation_basis_snapshot->'classification'->>'categoryCode' as "separationCategoryCode",
 is_insurable as "isInsurable",insurable_hours::text as "insurableHours",${SOURCE_COLUMNS}`;

function amount(value: unknown, label: string): string {
  const canonical = canonicalDecimal(value, 4);
  if (canonical === null || wholeDigits(canonical) > 15)
    throw new PayrollError(moneyRefusal(label, value));
  if (toUnits(canonical) < 0n) throw new PayrollError(`${label} cannot be negative`);
  return fromUnits(toUnits(canonical));
}
function dates(from: string, to: string, label: string) {
  if (!isIsoCalendarDate(from) || !isIsoCalendarDate(to) || from > to)
    throw new PayrollError(`${label} needs valid ordered calendar dates`);
}
function source(input: RoeReportingSource): RoeReportingSource {
  if (
    !isUuid(input.sourceFileId) ||
    !isUuid(input.sourceVersionId) ||
    !/^[a-f0-9]{64}$/.test(input.sourceSha256)
  )
    throw new PayrollError("Choose the exact native source file version and its SHA-256 hash");
  if (
    [input.sourceReference, input.insuranceReference, input.hoursReference, input.reason].some(
      (value) => typeof value !== "string",
    )
  )
    throw new PayrollError("Record the original reporting evidence and an import reason");
  const fields = {
    ...input,
    sourceReference: input.sourceReference.trim(),
    insuranceReference: input.insuranceReference.trim(),
    hoursReference: input.hoursReference.trim(),
    reason: input.reason.trim(),
  };
  if (
    [fields.sourceReference, fields.insuranceReference, fields.hoursReference, fields.reason].some(
      (value) => !value || value.length > 2000,
    )
  )
    throw new PayrollError(
      "Record the original period, insurance and hours sources and a reason, each within 2000 characters",
    );
  return fields;
}
function expected(input: { expectedId: string | null; expectedUpdatedAt: string | null }) {
  if (
    (input.expectedId === null) !== (input.expectedUpdatedAt === null) ||
    (input.expectedId !== null && !isUuid(input.expectedId)) ||
    (input.expectedUpdatedAt !== null &&
      (typeof input.expectedUpdatedAt !== "string" || !input.expectedUpdatedAt))
  )
    throw new PayrollError("Reload the current reporting evidence before replacing it");
}
export function validateRoePriorPeriod(input: RoePriorPeriodInput): Omit<
  RoePriorPeriodInput,
  "insurableEarnings" | "insurableHours"
> & {
  insurableEarnings: string;
  insurableHours: string;
} {
  const qualified = source(input);
  expected(input);
  dates(input.periodStart, input.periodEnd, "The prior reporting period");
  if (
    !isUuid(input.filingAccountId) ||
    !isUuid(input.payScheduleId) ||
    !["weekly", "biweekly", "semi_monthly", "monthly"].includes(input.frequency) ||
    typeof input.nilPeriod !== "boolean"
  )
    throw new PayrollError(
      "Choose the native filing account, pay schedule and reporting frequency",
    );
  const periodProblem = retainedPayPeriodProblem(
    input.frequency,
    input.periodStart,
    input.periodEnd,
  );
  if (periodProblem) throw new PayrollError(periodProblem);
  const insurableEarnings = amount(input.insurableEarnings, "Insurable earnings"),
    insurableHours = amount(input.insurableHours, "Insurable hours");
  if (input.nilPeriod) {
    if (
      input.payDate !== null ||
      input.earnedFrom !== null ||
      input.earnedTo !== null ||
      toUnits(insurableEarnings) !== 0n ||
      toUnits(insurableHours) !== 0n
    )
      throw new PayrollError(
        "A source-qualified nil period has no payment, earned span, insurable earnings or hours",
      );
  } else {
    if (
      input.payDate === null ||
      !isIsoCalendarDate(input.payDate) ||
      input.earnedFrom === null ||
      input.earnedTo === null
    )
      throw new PayrollError("Record the actual payment date and source-qualified earned span");
    dates(input.earnedFrom, input.earnedTo, "The original earned span");
  }
  return { ...input, ...qualified, insurableEarnings, insurableHours };
}
export function validateRoeLineEvidence(
  input: RoeLineEvidenceInput,
): Omit<RoeLineEvidenceInput, "insurableHours"> & { insurableHours: string } {
  const qualified = source(input);
  expected(input);
  dates(input.reportPeriodStart, input.reportPeriodEnd, "The statutory reporting allocation");
  const reportingBasis = input.reportingBasis ?? "service",
    separationEventId = input.separationEventId ?? null,
    separationPaymentId = input.separationPaymentId ?? null;
  const separationBlock = input.separationBlock ?? null,
    separationCategoryCode = input.separationCategoryCode ?? null;
  if (reportingBasis === "service") {
    if (input.earnedFrom === null || input.earnedTo === null)
      throw new PayrollError("Service reporting needs its original earned dates");
    dates(input.earnedFrom, input.earnedTo, "The original earned span");
    if (
      separationEventId !== null ||
      separationPaymentId !== null ||
      separationBlock !== null ||
      separationCategoryCode !== null
    )
      throw new PayrollError("Service reporting cannot use a separation payment declaration");
  } else if (reportingBasis === "separation_payment") {
    if (
      !isUuid(separationEventId) ||
      (separationPaymentId !== null && !isUuid(separationPaymentId))
    )
      throw new PayrollError("Choose the exact separation event and any existing paid declaration");
    if ((input.earnedFrom === null) !== (input.earnedTo === null))
      throw new PayrollError(
        "Retain both original earned dates or their original absence for separation cash",
      );
    if (input.earnedFrom !== null && input.earnedTo !== null)
      dates(input.earnedFrom, input.earnedTo, "The retained original earned span");
    validateRoeSeparationCategory(separationBlock, separationCategoryCode);
  } else
    throw new PayrollError(
      "Choose service reporting or an explicit source-qualified separation payment",
    );
  const insurableHours = amount(input.insurableHours, "Insurable hours");
  if (
    !isUuid(input.payStubLineId) ||
    typeof input.isInsurable !== "boolean" ||
    (!input.isInsurable && toUnits(insurableHours) !== 0n)
  )
    throw new PayrollError(
      "Choose the retained earning line and explicit insurance treatment; uninsured lines cannot contribute insured hours",
    );
  if (
    reportingBasis === "separation_payment" &&
    (!input.isInsurable || toUnits(insurableHours) !== 0n)
  )
    throw new PayrollError(
      "Separation cash reporting must be insurable without inventing service hours",
    );
  return {
    ...input,
    ...qualified,
    insurableHours,
    reportingBasis,
    separationEventId,
    separationPaymentId,
    separationBlock: separationBlock as "17A" | "17C" | null,
    separationCategoryCode,
  };
}
async function authorize(input: RoeHistorySubject, write: boolean) {
  if (!isUuid(input.employmentId) || !isUuid(input.subsidiaryId))
    throw new PayrollError("Choose the reporting evidence employment and legal employer");
  if (write) await takeEmployeeConfigurationFence(db, input.orgId, input.employeePartyId);
  const employee = await authorizeRoeReportingEmployee(
    input,
    write ? "payroll.run" : "payroll.read",
  );
  if (employee.employmentId !== input.employmentId || employee.subsidiaryId !== input.subsidiaryId)
    throw new PayrollError(
      "Reporting evidence must belong to the selected native employment and legal employer",
    );
}
async function retainSource(input: RoeHistorySubject, ref: RoeReportingSource) {
  // Importers upload the source through the native File Cabinet. A private
  // file belonging to another operator is never opened through payroll.
  const rows = await db.execute(
    sql`select v.id from file_versions v join files f on f.id=v.file_id
    where f.org_id=${input.orgId} and f.id=${ref.sourceFileId} and v.id=${ref.sourceVersionId}
      and v.content_hash=${ref.sourceSha256} and v.created_by=${input.actorId} and not f.is_inactive for share of f,v`,
    "objects",
  );
  if (rows.length !== 1)
    throw new PayrollError(
      "Upload the original source to File Cabinet as the importing operator, then select its exact retained version and hash",
    );
}
async function unissued(input: RoeHistorySubject) {
  await assertRoeLegacySourcesBound(input.orgId, input.employeePartyId);
}
async function audit(
  input: RoeHistorySubject,
  table: string,
  id: string,
  before: unknown,
  after: unknown,
  reason: string,
) {
  const rows = await db.execute(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${input.orgId},${table},${id},${after === null ? "delete" : before ? "update" : "insert"},${JSON.stringify({ before, after, reason })}::jsonb,${input.actorId}) returning id`,
    "objects",
  );
  if (rows.length !== 1)
    throw new PayrollError("The reporting evidence import audit was not retained");
}
function freshness(
  current: { id: string; updatedAt: string } | undefined,
  input: { expectedId: string | null; expectedUpdatedAt: string | null },
) {
  if (
    (current?.id ?? null) !== input.expectedId ||
    (current?.updatedAt ?? null) !== input.expectedUpdatedAt
  )
    throw new PayrollError(
      "Reporting evidence changed — reload and review it before replacing the source",
    );
}
function same(current: Record<string, unknown>, values: Record<string, unknown>): boolean {
  return Object.entries(values).every(([key, value]) => current[key] === value);
}

/** Atomically import one qualified period without recreating paid payroll or tax history. */
export async function importRoePriorPeriod(
  subject: RoeHistorySubject,
  raw: RoePriorPeriodInput,
): Promise<RoePriorPeriod> {
  const input = validateRoePriorPeriod(raw);
  return withOrgTransaction(subject.orgId, async () => {
    await authorize(subject, true);
    await retainSource(subject, input);
    const current = (
      await db.execute<RoePriorPeriod>(
        sql`select ${PERIOD_COLUMNS} from payroll_roe_historical_periods
      where org_id=${subject.orgId} and employment_id=${subject.employmentId}
        and ${input.expectedId === null ? sql`period_start=${input.periodStart}::date and period_end=${input.periodEnd}::date` : sql`id=${input.expectedId}::uuid`} for update`,
        "objects",
      )
    )[0];
    const values = {
      employmentId: subject.employmentId,
      subsidiaryId: subject.subsidiaryId,
      filingAccountId: input.filingAccountId,
      payScheduleId: input.payScheduleId,
      frequency: input.frequency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payDate: input.payDate,
      earnedFrom: input.earnedFrom,
      earnedTo: input.earnedTo,
      insurableEarnings: input.insurableEarnings,
      insurableHours: input.insurableHours,
      nilPeriod: input.nilPeriod,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.sourceVersionId,
      sourceSha256: input.sourceSha256,
      sourceReference: input.sourceReference,
      insuranceReference: input.insuranceReference,
      hoursReference: input.hoursReference,
      reason: input.reason,
    };
    if (current && same(current, values)) return current;
    freshness(current, input);
    await unissued(subject);
    const rows = current
      ? await db.execute<RoePriorPeriod>(
          sql`update payroll_roe_historical_periods set
      period_start=${input.periodStart},period_end=${input.periodEnd},filing_account_id=${input.filingAccountId},pay_schedule_id=${input.payScheduleId},frequency=${input.frequency},pay_date=${input.payDate},earned_from=${input.earnedFrom},earned_to=${input.earnedTo},
      insurable_earnings=${input.insurableEarnings},insurable_hours=${input.insurableHours},nil_period=${input.nilPeriod},
      source_file_id=${input.sourceFileId},source_version_id=${input.sourceVersionId},source_sha256=${input.sourceSha256},source_reference=${input.sourceReference},
      insurance_reference=${input.insuranceReference},hours_reference=${input.hoursReference},change_reason=${input.reason},updated_by=${subject.actorId},
      updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where org_id=${subject.orgId} and id=${current.id}
        and updated_at::text=${input.expectedUpdatedAt} returning ${PERIOD_COLUMNS}`,
          "objects",
        )
      : await db.execute<RoePriorPeriod>(
          sql`insert into payroll_roe_historical_periods(org_id,employee_party_id,employment_id,subsidiary_id,
      filing_account_id,pay_schedule_id,frequency,period_start,period_end,pay_date,earned_from,earned_to,insurable_earnings,insurable_hours,nil_period,
      source_file_id,source_version_id,source_sha256,source_reference,insurance_reference,hours_reference,change_reason,created_by,updated_by)
      values(${subject.orgId},${subject.employeePartyId},${subject.employmentId},${subject.subsidiaryId},${input.filingAccountId},${input.payScheduleId},${input.frequency},
      ${input.periodStart},${input.periodEnd},${input.payDate},${input.earnedFrom},${input.earnedTo},${input.insurableEarnings},${input.insurableHours},${input.nilPeriod},
      ${input.sourceFileId},${input.sourceVersionId},${input.sourceSha256},${input.sourceReference},${input.insuranceReference},${input.hoursReference},${input.reason},${subject.actorId},${subject.actorId}) returning ${PERIOD_COLUMNS}`,
          "objects",
        );
    if (rows.length !== 1) throw new PayrollError("The prior reporting period was not imported");
    await audit(
      subject,
      "payroll_roe_historical_periods",
      rows[0]!.id,
      current ?? null,
      rows[0],
      input.reason,
    );
    return rows[0]!;
  });
}

/** Reporting classification cannot replace a committed earning amount or its source identity. */
export async function qualifyRoeLine(
  subject: RoeHistorySubject,
  raw: RoeLineEvidenceInput,
): Promise<RoeLineEvidence> {
  const input = validateRoeLineEvidence(raw);
  return withOrgTransaction(subject.orgId, async () => {
    await authorize(subject, true);
    await retainSource(subject, input);
    const lines = await db.execute<{ snapshot: Record<string, unknown> }>(
      sql`select public.payroll_roe_reporting_line_snapshot(l.id,l.org_id) as snapshot
      from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id where l.org_id=${subject.orgId} and l.id=${input.payStubLineId}
        and s.employee_party_id=${subject.employeePartyId} and s.employment_id=${subject.employmentId} and d.subsidiary_id=${subject.subsidiaryId}
        and s.currency_code='CAD' and r.run_status='committed' and l.kind='earning' for share of l,s,r,d`,
      "objects",
    );
    if (lines.length !== 1 || !lines[0]!.snapshot)
      throw new PayrollError(
        "Choose one committed Canadian earning line in this employee’s native employment",
      );
    const snapshot = lines[0]!.snapshot;
    if (
      input.isInsurable &&
      snapshot.hours !== null &&
      snapshot.hours !== undefined &&
      toUnits(String(snapshot.hours)) !== toUnits(input.insurableHours)
    )
      throw new PayrollError(
        "Qualified insurable hours must preserve the retained paid-hour source",
      );
    if (input.reportingBasis === "separation_payment") {
      if (
        input.earnedFrom !== (snapshot.earnedFrom ?? null) ||
        input.earnedTo !== (snapshot.earnedTo ?? null)
      )
        throw new PayrollError(
          "Separation reporting must preserve the true retained earned dates, including their original absence",
        );
    } else if (
      (typeof snapshot.earnedFrom === "string" &&
        input.earnedFrom !== null &&
        input.earnedFrom < snapshot.earnedFrom) ||
      (typeof snapshot.earnedTo === "string" &&
        input.earnedTo !== null &&
        input.earnedTo > snapshot.earnedTo)
    )
      throw new PayrollError(
        "Qualified earned evidence cannot expand the retained payroll span — correct its native source first",
      );
    const current = (
      await db.execute<RoeLineEvidence>(
        sql`select ${LINE_COLUMNS} from payroll_roe_line_evidence
      where org_id=${subject.orgId} and pay_stub_line_id=${input.payStubLineId} for update`,
        "objects",
      )
    )[0];
    if (
      current?.reportingBasis === "separation_payment" &&
      (input.reportingBasis !== "separation_payment" ||
        input.separationEventId !== current.separationEventId ||
        (input.separationPaymentId != null &&
          input.separationPaymentId !== current.separationPaymentId))
    )
      throw new PayrollError(
        "Withdraw the unissued separation attribution before changing its payment or event identity",
      );
    const basis =
      input.reportingBasis === "separation_payment"
        ? await prepareRoeSeparationReportingBasis(
            subject,
            {
              separationEventId: input.separationEventId!,
              separationPaymentId: input.separationPaymentId ?? null,
              reportPeriodStart: input.reportPeriodStart,
              reportPeriodEnd: input.reportPeriodEnd,
              payStubLineId: input.payStubLineId,
              reason: input.reason,
              separationBlock: input.separationBlock!,
              separationCategoryCode: input.separationCategoryCode!,
            },
            snapshot,
            current?.separationPaymentId ?? null,
          )
        : null;
    const values = {
      payStubLineId: input.payStubLineId,
      reportPeriodStart: input.reportPeriodStart,
      reportPeriodEnd: input.reportPeriodEnd,
      earnedFrom: input.earnedFrom,
      earnedTo: input.earnedTo,
      reportingBasis: input.reportingBasis ?? "service",
      separationEventId: input.separationEventId ?? null,
      separationPaymentId: basis?.paymentId ?? null,
      separationBlock: input.separationBlock ?? null,
      separationCategoryCode: input.separationCategoryCode ?? null,
      isInsurable: input.isInsurable,
      insurableHours: input.insurableHours,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.sourceVersionId,
      sourceSha256: input.sourceSha256,
      sourceReference: input.sourceReference,
      insuranceReference: input.insuranceReference,
      hoursReference: input.hoursReference,
      reason: input.reason,
    };
    if (
      current &&
      same(current, values) &&
      JSON.stringify(current.lineSnapshot) === JSON.stringify(snapshot) &&
      JSON.stringify(current.separationBasisSnapshot) === JSON.stringify(basis?.snapshot ?? null)
    )
      return current;
    freshness(current, input);
    await unissued(subject);
    const rows = current
      ? await db.execute<RoeLineEvidence>(
          sql`update payroll_roe_line_evidence set line_snapshot=${JSON.stringify(snapshot)}::jsonb,
      reporting_basis=${input.reportingBasis ?? "service"},separation_event_id=${input.separationEventId ?? null},separation_payment_id=${basis?.paymentId ?? null},
      separation_basis_snapshot=${basis ? JSON.stringify(basis.snapshot) : null}::jsonb,
      report_period_start=${input.reportPeriodStart},report_period_end=${input.reportPeriodEnd},earned_from=${input.earnedFrom},earned_to=${input.earnedTo},is_insurable=${input.isInsurable},
      insurable_hours=${input.insurableHours},source_file_id=${input.sourceFileId},source_version_id=${input.sourceVersionId},source_sha256=${input.sourceSha256},
      source_reference=${input.sourceReference},insurance_reference=${input.insuranceReference},hours_reference=${input.hoursReference},change_reason=${input.reason},
      updated_by=${subject.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
      where org_id=${subject.orgId} and id=${current.id} and updated_at::text=${input.expectedUpdatedAt} returning ${LINE_COLUMNS}`,
          "objects",
        )
      : await db.execute<RoeLineEvidence>(
          sql`insert into payroll_roe_line_evidence(org_id,employee_party_id,employment_id,subsidiary_id,pay_stub_line_id,line_snapshot,
      reporting_basis,separation_event_id,separation_payment_id,separation_basis_snapshot,
      report_period_start,report_period_end,earned_from,earned_to,is_insurable,insurable_hours,source_file_id,source_version_id,source_sha256,
      source_reference,insurance_reference,hours_reference,change_reason,created_by,updated_by)
      values(${subject.orgId},${subject.employeePartyId},${subject.employmentId},${subject.subsidiaryId},${input.payStubLineId},${JSON.stringify(snapshot)}::jsonb,
      ${input.reportingBasis ?? "service"},${input.separationEventId ?? null},${basis?.paymentId ?? null},${basis ? JSON.stringify(basis.snapshot) : null}::jsonb,
      ${input.reportPeriodStart},${input.reportPeriodEnd},${input.earnedFrom},${input.earnedTo},${input.isInsurable},${input.insurableHours},${input.sourceFileId},${input.sourceVersionId},${input.sourceSha256},
      ${input.sourceReference},${input.insuranceReference},${input.hoursReference},${input.reason},${subject.actorId},${subject.actorId}) returning ${LINE_COLUMNS}`,
          "objects",
        );
    if (rows.length !== 1)
      throw new PayrollError("The payroll-line reporting evidence was not retained");
    await audit(
      subject,
      "payroll_roe_line_evidence",
      rows[0]!.id,
      current ?? null,
      rows[0],
      input.reason,
    );
    return rows[0]!;
  });
}

export async function readRoeHistoricalEvidence(
  subject: RoeHistorySubject,
  range?: { periodFrom: string; periodTo: string },
): Promise<{ periods: RoePriorPeriod[]; lines: RoeLineEvidence[] }> {
  if (range) dates(range.periodFrom, range.periodTo, "The reporting evidence review window");
  return withOrgTransaction(subject.orgId, async () => {
    await authorize(subject, false);
    const periods = await db.execute<RoePriorPeriod>(
      sql`select ${PERIOD_COLUMNS} from payroll_roe_historical_periods
      where org_id=${subject.orgId} and employee_party_id=${subject.employeePartyId} and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId}
      ${range ? sql`and period_end>=${range.periodFrom}::date and period_start<=${range.periodTo}::date` : sql``}
      order by period_end desc,id limit 107`,
      "objects",
    );
    const lines = await db.execute<RoeLineEvidence>(
      sql`select ${LINE_COLUMNS} from payroll_roe_line_evidence
      where org_id=${subject.orgId} and employee_party_id=${subject.employeePartyId} and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId}
      ${range ? sql`and report_period_end>=${range.periodFrom}::date and report_period_start<=${range.periodTo}::date` : sql``}
      order by report_period_end desc,id limit 5001`,
      "objects",
    );
    if (periods.length > 106 || lines.length > 5000)
      throw new PayrollError(
        "Reporting evidence exceeds the supported per-employee review window — select a bounded reporting period",
      );
    return { periods, lines };
  });
}

/** Withdraw only unissued reporting attribution; committed cash and its original source remain unchanged. */
export async function withdrawRoeLineEvidence(
  subject: RoeHistorySubject,
  input: { expectedId: string; expectedUpdatedAt: string; reason: string },
): Promise<void> {
  expected(input);
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.trim().length > 2000)
    throw new PayrollError("Record why the unissued attribution is being withdrawn");
  return withOrgTransaction(subject.orgId, async () => {
    await authorize(subject, true);
    await unissued(subject);
    const rows = await db.execute<RoeLineEvidence>(
      sql`select ${LINE_COLUMNS} from payroll_roe_line_evidence
      where org_id=${subject.orgId} and id=${input.expectedId} and employee_party_id=${subject.employeePartyId}
        and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId} for update`,
      "objects",
    );
    if (rows.length !== 1)
      throw new PayrollError(
        "The selected unissued line attribution no longer exists — reload its reporting evidence",
      );
    const current = rows[0]!;
    freshness(current, input);
    const removed = await db.execute(
      sql`delete from payroll_roe_line_evidence where org_id=${subject.orgId} and id=${current.id}
      and updated_at::text=${input.expectedUpdatedAt} returning id`,
      "objects",
    );
    if (removed.length !== 1)
      throw new PayrollError("The selected attribution changed before withdrawal");
    await audit(
      subject,
      "payroll_roe_line_evidence",
      current.id,
      current,
      null,
      input.reason.trim(),
    );
    if (current.separationPaymentId !== null) {
      const payments = await db.execute<{ snapshot: Record<string, unknown>; generated: boolean }>(
        sql`select to_jsonb(p) as snapshot,generated_from_line as generated
        from payroll_roe_separation_payments p where org_id=${subject.orgId} and id=${current.separationPaymentId}
          and source_line_id=${current.payStubLineId} and separation_event_id=${current.separationEventId} for update`,
        "objects",
      );
      if (payments.length !== 1)
        throw new PayrollError(
          "The selected separation declaration no longer matches the withdrawn line",
        );
      if (payments[0]!.generated) {
        const deleted = await db.execute(
          sql`delete from payroll_roe_separation_payments where org_id=${subject.orgId}
          and id=${current.separationPaymentId} and generated_from_line and source_line_id=${current.payStubLineId} returning id`,
          "objects",
        );
        if (deleted.length !== 1)
          throw new PayrollError(
            "The source-generated reporting declaration changed before withdrawal",
          );
        await audit(
          subject,
          "payroll_roe_separation_payments",
          current.separationPaymentId,
          payments[0]!.snapshot,
          null,
          input.reason.trim(),
        );
      }
    }
  });
}

export type RoeReportingImport =
  | { kind: "period"; evidence: RoePriorPeriodInput }
  | { kind: "line"; evidence: RoeLineEvidenceInput };
export type RoeReportingImportResult = { action: "insert" | "update" | "unchanged" };
class ReportingPreviewRollback extends Error {
  constructor(readonly result: RoeReportingImportResult) {
    super("Reporting evidence preview rollback");
  }
}

/** Preview uses the same native guards and retains no reporting or audit rows. */
export async function applyRoeReportingImport(
  subject: RoeHistorySubject,
  input: RoeReportingImport,
  dryRun: boolean,
): Promise<RoeReportingImportResult> {
  input =
    input.kind === "period"
      ? { kind: "period", evidence: validateRoePriorPeriod(input.evidence) }
      : { kind: "line", evidence: validateRoeLineEvidence(input.evidence) };
  return withOrgTransaction(subject.orgId, async () => {
    try {
      return await withTransactionSavepoint(db, async () => {
        await authorize(subject, true);
        const before =
          input.kind === "period"
            ? (
                await db.execute<{ id: string; updatedAt: string }>(
                  sql`select id,updated_at::text as "updatedAt" from payroll_roe_historical_periods
              where org_id=${subject.orgId} and employment_id=${subject.employmentId}
                and ${
                  input.evidence.expectedId === null
                    ? sql`period_start=${input.evidence.periodStart}::date and period_end=${input.evidence.periodEnd}::date`
                    : sql`id=${input.evidence.expectedId}::uuid`
                } for update`,
                  "objects",
                )
              )[0]
            : (
                await db.execute<{ id: string; updatedAt: string }>(
                  sql`select id,updated_at::text as "updatedAt" from payroll_roe_line_evidence
              where org_id=${subject.orgId} and pay_stub_line_id=${input.evidence.payStubLineId} for update`,
                  "objects",
                )
              )[0];
        const after =
          input.kind === "period"
            ? await importRoePriorPeriod(subject, input.evidence)
            : await qualifyRoeLine(subject, input.evidence);
        const result: RoeReportingImportResult = {
          action: !before
            ? "insert"
            : before.updatedAt === after.updatedAt
              ? "unchanged"
              : "update",
        };
        if (dryRun) throw new ReportingPreviewRollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof ReportingPreviewRollback) return error.result;
      throw error;
    }
  });
}
