import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/**
 * Native Field Ticket header extension.
 *
 * `documents` owns the common commercial header; this one-to-one table owns
 * the product's Field Ticket state. Tenant-defined extension fields may still
 * use documents.custom, but the own fields must never live there.
 */
export const fieldTickets = pgTable(
  "field_tickets",
  {
    documentId: uuid("document_id").primaryKey(),
    orgId: orgRef(),
    period: text("period", {
      enum: ["shift", "daily", "weekly"],
    }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    foremanPartyId: uuid("foreman_party_id"),
    chargeDocumentId: uuid("charge_document_id"),
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("field_tickets_org_id_document_id_unique").on(t.orgId, t.documentId),
    index("field_tickets_org_period").on(t.orgId, t.periodStart, t.periodEnd),
    index("field_tickets_foreman").on(t.orgId, t.foremanPartyId),
    check("field_tickets_period_order", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/**
 * Immutable lines belonging to one commercial labor snapshot. A line may
 * point to an exact atomic time entry, but source-imported aggregate evidence
 * is valid without that link. It never posts labor, payroll, or job cost.
 */
export const fieldTicketLaborLines = pgTable(
  "field_ticket_labor_lines",
  {
    id: id(),
    orgId: orgRef(),
    snapshotId: uuid("snapshot_id").notNull(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    sequence: integer("sequence").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    employeeName: text("employee_name").notNull(),
    itemId: uuid("item_id"),
    itemName: text("item_name"),
    timeTypeId: uuid("time_type_id"),
    timeTypeName: text("time_type_name").notNull(),
    timeClassification: text("time_classification", {
      enum: ["regular", "overtime", "double_time", "other"],
    }).notNull(),
    projectTaskId: uuid("project_task_id"),
    projectTaskName: text("project_task_name"),
    workedOn: date("worked_on").notNull(),
    hours: numeric("hours", { precision: 19, scale: 4 }).notNull(),
    timeEntryId: uuid("time_entry_id"),
    timeEntryStatus: text("time_entry_status"),
    costRate: numeric("cost_rate", { precision: 28, scale: 8 }),
    costRateCurrency: currencyCode("cost_rate_currency"),
    billRate: numeric("bill_rate", { precision: 28, scale: 8 }),
    billRateCurrency: currencyCode("bill_rate_currency"),
    costAmount: numeric("cost_amount", { precision: 19, scale: 4 }),
    billAmount: numeric("bill_amount", { precision: 19, scale: 4 }),
    sourceSystem: text("source_system"),
    sourceLineRef: text("source_line_ref"),
    sourcePayloadHash: text("source_payload_hash"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("field_ticket_labor_lines_sequence").on(
      t.orgId,
      t.snapshotId,
      t.sequence,
    ),
    uniqueIndex("field_ticket_labor_lines_time_entry").on(
      t.orgId,
      t.snapshotId,
      t.timeEntryId,
    ),
    uniqueIndex("field_ticket_labor_lines_source_ref").on(
      t.orgId,
      t.snapshotId,
      t.sourceSystem,
      t.sourceLineRef,
    ),
    index("field_ticket_labor_lines_ticket").on(
      t.orgId,
      t.fieldTicketId,
      t.workedOn,
    ),
    index("field_ticket_labor_lines_time_entry_lookup").on(t.orgId, t.timeEntryId),
    check("field_ticket_labor_lines_sequence_positive", sql`${t.sequence} > 0`),
    check("field_ticket_labor_lines_hours_nonzero", sql`${t.hours} <> 0`),
  ],
);
