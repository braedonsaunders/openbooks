import { sql } from "drizzle-orm";
import { date, index, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/** Approval binding, tenant references, immutable evidence and occurrence
 * completeness are enforced by the versioned database migration. Aggregate
 * paid hours stay on the obligation; dates never imply a daily allocation. */
export const payrollHolidayObligations = pgTable("payroll_holiday_obligations", {
  id: id(), orgId: orgRef(), changeId: uuid("change_id").notNull(),
  employeePartyId: uuid("employee_party_id").notNull(), subsidiaryId: uuid("subsidiary_id").notNull(),
  employmentId: uuid("employment_id").notNull(), paymentDate: date("payment_date").notNull(),
  sourceFileId: uuid("source_file_id").notNull(), sourceVersionId: uuid("source_version_id").notNull(),
  evidence: jsonb("evidence").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
}, t => [
  uniqueIndex("payroll_holiday_obligations_org_id_id_key").on(t.orgId, t.id),
  uniqueIndex("payroll_holiday_obligations_org_id_change_id_key").on(t.orgId, t.changeId),
  uniqueIndex("payroll_holiday_obligations_subject_key").on(t.orgId, t.id, t.employeePartyId, t.subsidiaryId),
  index("payroll_holiday_obligations_due").on(t.orgId, t.paymentDate, t.employeePartyId),
]);

export const payrollHolidayOccurrences = pgTable("payroll_holiday_occurrences", {
  orgId: orgRef(), obligationId: uuid("obligation_id").notNull(),
  employeePartyId: uuid("employee_party_id").notNull(), subsidiaryId: uuid("subsidiary_id").notNull(),
  holidayDate: date("holiday_date").notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.obligationId, t.holidayDate] }),
  uniqueIndex("payroll_holiday_occurrences_subject_date_key").on(t.orgId, t.employeePartyId, t.subsidiaryId, t.holidayDate),
]);

export const payRunHolidayAllocations = pgTable("pay_run_holiday_allocations", {
  id: id(), orgId: orgRef(), obligationId: uuid("obligation_id").notNull(),
  payRunDocumentId: uuid("pay_run_document_id").notNull(), payStubLineId: uuid("pay_stub_line_id"),
  componentId: uuid("component_id").notNull(), amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
  hours: numeric("hours", { precision: 12, scale: 2 }).notNull(), rate: numeric("rate", { precision: 19, scale: 4 }).notNull(),
  currency: text("currency").notNull(), sourceSnapshot: jsonb("source_snapshot").notNull(),
  status: text("status", { enum: ["calculated", "committed", "voided"] }).notNull().default("calculated"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), updatedBy: uuid("updated_by").notNull(),
}, t => [
  uniqueIndex("pay_run_holiday_allocations_org_id_id_key").on(t.orgId, t.id),
  uniqueIndex("pay_run_holiday_allocations_run_obligation_key").on(t.orgId, t.payRunDocumentId, t.obligationId),
  uniqueIndex("pay_run_holiday_allocations_active_claim").on(t.orgId, t.obligationId).where(sql`${t.status}<>'voided'`),
]);
