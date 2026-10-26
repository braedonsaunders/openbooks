import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

const subject = () => ({
  id: id(),
  orgId: orgRef(),
  employeePartyId: uuid("employee_party_id").notNull(),
  employmentId: uuid("employment_id").notNull(),
  subsidiaryId: uuid("subsidiary_id").notNull(),
});
const source = () => ({
  sourceFileId: uuid("source_file_id").notNull(),
  sourceVersionId: uuid("source_version_id").notNull(),
  sourceSha256: text("source_sha256").notNull(),
  sourceReference: text("source_reference").notNull(),
  insuranceReference: text("insurance_reference").notNull(),
  hoursReference: text("hours_reference").notNull(),
  changeReason: text("change_reason").notNull(),
  ...auditColumns,
  createdBy: uuid("created_by").notNull(),
  updatedBy: uuid("updated_by").notNull(),
});
/** Imported periods are reporting facts, never replacements for native paid payroll. */
export const payrollRoeHistoricalPeriods = pgTable(
  "payroll_roe_historical_periods",
  {
    ...subject(),
    filingAccountId: uuid("filing_account_id").notNull(),
    payScheduleId: uuid("pay_schedule_id").notNull(),
    frequency: text("frequency", {
      enum: ["weekly", "biweekly", "semi_monthly", "monthly"],
    }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payDate: date("pay_date"),
    earnedFrom: date("earned_from"),
    earnedTo: date("earned_to"),
    currency: text("currency").notNull().default("CAD"),
    insurableEarnings: money("insurable_earnings").notNull(),
    insurableHours: money("insurable_hours").notNull(),
    nilPeriod: boolean("nil_period").notNull(),
    ...source(),
  },
  (t) => [
    uniqueIndex("payroll_roe_historical_periods_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_roe_historical_periods_unique").on(
      t.orgId,
      t.employmentId,
      t.periodStart,
      t.periodEnd,
    ),
    index("payroll_roe_historical_periods_employee_date").on(
      t.orgId,
      t.employeePartyId,
      t.periodEnd,
    ),
    check("payroll_roe_historical_periods_currency", sql`${t.currency}='CAD'`),
    check(
      "payroll_roe_historical_periods_frequency",
      sql`${t.frequency} in ('weekly','biweekly','semi_monthly','monthly')`,
    ),
    check(
      "payroll_roe_historical_periods_dates",
      sql`${t.periodStart}<=${t.periodEnd} and
    ((${t.nilPeriod} and ${t.payDate} is null and ${t.earnedFrom} is null and ${t.earnedTo} is null and ${t.insurableEarnings}=0 and ${t.insurableHours}=0)
      or (not ${t.nilPeriod} and ${t.payDate} is not null and ${t.earnedFrom} is not null and ${t.earnedTo} is not null and ${t.earnedFrom}<=${t.earnedTo}))`,
    ),
    check(
      "payroll_roe_historical_periods_amounts",
      sql`${t.insurableEarnings}>=0 and ${t.insurableEarnings}<>'NaN'::numeric and ${t.insurableHours}>=0 and ${t.insurableHours}<>'NaN'::numeric`,
    ),
    check(
      "payroll_roe_historical_periods_source",
      sql`${t.sourceSha256}~'^[a-f0-9]{64}$' and length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.insuranceReference})) between 1 and 2000 and length(btrim(${t.hoursReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
  ],
);

/** Earned dates and statutory reporting classification retain the exact committed line identity. */
export const payrollRoeLineEvidence = pgTable(
  "payroll_roe_line_evidence",
  {
    ...subject(),
    payStubLineId: uuid("pay_stub_line_id").notNull(),
    lineSnapshot: jsonb("line_snapshot").notNull(),
    reportPeriodStart: date("report_period_start").notNull(),
    reportPeriodEnd: date("report_period_end").notNull(),
    earnedFrom: date("earned_from"),
    earnedTo: date("earned_to"),
    reportingBasis: text("reporting_basis", { enum: ["service", "separation_payment"] })
      .notNull()
      .default("service"),
    separationEventId: uuid("separation_event_id"),
    separationPaymentId: uuid("separation_payment_id"),
    separationBasisSnapshot: jsonb("separation_basis_snapshot"),
    isInsurable: boolean("is_insurable").notNull(),
    insurableHours: money("insurable_hours").notNull(),
    ...source(),
  },
  (t) => [
    uniqueIndex("payroll_roe_line_evidence_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_roe_line_evidence_unique").on(t.orgId, t.payStubLineId),
    uniqueIndex("payroll_roe_line_evidence_separation_payment_unique")
      .on(t.orgId, t.separationPaymentId)
      .where(sql`${t.separationPaymentId} is not null`),
    check(
      "payroll_roe_line_evidence_reporting_basis",
      sql`(${t.reportingBasis}='service' and ${t.separationEventId} is null and ${t.separationPaymentId} is null
    and ${t.separationBasisSnapshot} is null and ${t.earnedFrom} is not null and ${t.earnedTo} is not null)
    or (${t.reportingBasis}='separation_payment' and ${t.separationEventId} is not null and ${t.separationPaymentId} is not null
    and ${t.separationBasisSnapshot} is not null and jsonb_typeof(${t.separationBasisSnapshot})='object' and ${t.isInsurable} and ${t.insurableHours}=0)`,
    ),
    index("payroll_roe_line_evidence_employee_date").on(
      t.orgId,
      t.employeePartyId,
      t.reportPeriodEnd,
    ),
    check(
      "payroll_roe_line_evidence_dates",
      sql`${t.reportPeriodStart}<=${t.reportPeriodEnd} and ${t.earnedFrom}<=${t.earnedTo}`,
    ),
    check(
      "payroll_roe_line_evidence_hours",
      sql`${t.insurableHours}>=0 and ${t.insurableHours}<>'NaN'::numeric and (${t.isInsurable} or ${t.insurableHours}=0)`,
    ),
    check("payroll_roe_line_evidence_snapshot", sql`jsonb_typeof(${t.lineSnapshot})='object'`),
    check(
      "payroll_roe_line_evidence_source",
      sql`${t.sourceSha256}~'^[a-f0-9]{64}$' and length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.insuranceReference})) between 1 and 2000 and length(btrim(${t.hoursReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
  ],
);
