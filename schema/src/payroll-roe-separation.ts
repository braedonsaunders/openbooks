import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Employer declarations bind each interruption to its native employment and source. */
export const payrollRoeSeparationEvents = pgTable(
  "payroll_roe_separation_events",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employmentId: uuid("employment_id"),
    subsidiaryId: uuid("subsidiary_id"),
    firstDayWorked: date("first_day_worked"),
    interruptionOn: date("interruption_on").notNull(),
    lastInsurableEarningsOn: date("last_insurable_earnings_on").notNull(),
    salaryContinuanceEndOn: date("salary_continuance_end_on"),
    sourceReference: text("source_reference"),
    status: text("status", { enum: ["draft", "confirmed", "issued", "cancelled"] })
      .notNull()
      .default("draft"),
    changeReason: text("change_reason").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("payroll_roe_separation_events_org_id_unique").on(t.orgId, t.id),
    index("payroll_roe_separation_events_employee_date").on(
      t.orgId,
      t.employeePartyId,
      t.interruptionOn.desc(),
    ),
    uniqueIndex("payroll_roe_separation_events_one_open_per_employee")
      .on(t.orgId, t.employeePartyId)
      .where(sql`${t.status} in ('draft','confirmed')`),
    check(
      "payroll_roe_separation_events_status",
      sql`${t.status} in ('draft','confirmed','issued','cancelled')`,
    ),
    check("payroll_roe_separation_events_reason", sql`length(btrim(${t.changeReason})) > 0`),
    check(
      "payroll_roe_separation_events_dates",
      sql`${t.lastInsurableEarningsOn} <= ${t.interruptionOn} and (${t.salaryContinuanceEndOn} is null or (${t.salaryContinuanceEndOn} >= ${t.lastInsurableEarningsOn} and ${t.salaryContinuanceEndOn} <= ${t.interruptionOn}))`,
    ),
    check(
      "payroll_roe_separation_events_employer_pair",
      sql`(${t.employmentId} is null) = (${t.subsidiaryId} is null)`,
    ),
    check(
      "payroll_roe_separation_events_first_worked",
      sql`${t.firstDayWorked} is null or ${t.firstDayWorked} <= ${t.lastInsurableEarningsOn}`,
    ),
    check(
      "payroll_roe_separation_events_source_reference",
      sql`${t.sourceReference} is null or length(btrim(${t.sourceReference})) between 1 and 2000`,
    ),
  ],
);

/** An issued event owns exactly the reporting evidence used by its retained artifact. */
export const payrollRoeIssuedEventSources = pgTable(
  "payroll_roe_issued_event_sources",
  {
    id: id(),
    orgId: orgRef(),
    eventId: uuid("event_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    issuedSlipId: uuid("issued_slip_id").notNull(),
    historicalPeriodIds: uuid("historical_period_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    lineEvidenceIds: uuid("line_evidence_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    excludedStubIds: uuid("excluded_stub_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    sourceSnapshot: jsonb("source_snapshot").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("payroll_roe_issued_event_sources_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_roe_issued_event_sources_event_unique").on(t.orgId, t.eventId),
    uniqueIndex("payroll_roe_issued_event_sources_slip_unique").on(t.orgId, t.issuedSlipId),
    index("payroll_roe_issued_event_sources_employee").on(t.orgId, t.employeePartyId),
    check("payroll_roe_issued_event_sources_digest", sql`${t.sourceSha256}~'^[a-f0-9]{64}$'`),
    check(
      "payroll_roe_issued_event_sources_snapshot",
      sql`jsonb_typeof(${t.sourceSnapshot})='object'`,
    ),
    check(
      "payroll_roe_issued_event_sources_period_ids",
      sql`array_position(${t.historicalPeriodIds},NULL) is null`,
    ),
    check(
      "payroll_roe_issued_event_sources_excluded_ids",
      sql`array_position(${t.excludedStubIds},NULL) is null and cardinality(${t.excludedStubIds})<=5000`,
    ),
    check(
      "payroll_roe_issued_event_sources_line_ids",
      sql`array_position(${t.lineEvidenceIds},NULL) is null`,
    ),
  ],
);
