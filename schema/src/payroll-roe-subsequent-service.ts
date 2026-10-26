import { sql } from "drizzle-orm";
import { check, date, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Return certificates retain a service interval within the original native employment. */
export const payrollRoeSubsequentServiceSources = pgTable(
  "payroll_roe_subsequent_service_sources",
  {
    id: id(),
    orgId: orgRef(),
    precedingEventId: uuid("preceding_event_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employmentId: uuid("employment_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    firstDayWorked: date("first_day_worked").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceReference: text("source_reference").notNull(),
    changeReason: text("change_reason").notNull(),
    ...auditColumns,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("payroll_roe_subsequent_service_sources_org_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_roe_subsequent_service_sources_event_unique").on(
      t.orgId,
      t.precedingEventId,
    ),
    check(
      "payroll_roe_subsequent_service_sources_date",
      sql`${t.firstDayWorked} between date '0001-01-01' and date '9999-12-31'`,
    ),
    check(
      "payroll_roe_subsequent_service_sources_source",
      sql`${t.sourceSha256}~'^[a-f0-9]{64}$' and length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
  ],
);
