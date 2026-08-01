import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * A controller-reviewed snapshot of project work before it becomes a normal
 * billing_request/customer_invoice. Source rows remain the accounting truth;
 * this record owns only commercial review, approval, and immutable lineage.
 */
export const wipPrebills = pgTable(
  "wip_prebills",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    worksheetNumber: text("worksheet_number").notNull(),
    periodStart: date("period_start"),
    periodEnd: date("period_end").notNull(),
    status: text("status", {
      enum: ["draft", "review", "approved", "converted", "void"],
    })
      .notNull()
      .default("draft"),
    notes: text("notes"),
    originalBillAmount: money("original_bill_amount").notNull().default("0"),
    proposedBillAmount: money("proposed_bill_amount").notNull().default("0"),
    costAmount: money("cost_amount").notNull().default("0"),
    adjustmentAmount: money("adjustment_amount").notNull().default("0"),
    billingRequestId: uuid("billing_request_id"),
    invoiceDocumentId: uuid("invoice_document_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    convertedBy: uuid("converted_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("wip_prebills_org_number").on(t.orgId, t.worksheetNumber),
    index("wip_prebills_project_status").on(t.orgId, t.projectId, t.status),
    index("wip_prebills_period").on(t.orgId, t.periodEnd),
  ],
);

/**
 * One approved time entry or billable cost line captured for review. Monetary
 * snapshots make the approval reproducible after rate-card changes. Source ids
 * are kept in dedicated columns so conversion can stamp native provenance and
 * can never bill a source twice.
 */
export const wipPrebillLines = pgTable(
  "wip_prebill_lines",
  {
    id: id(),
    orgId: orgRef(),
    prebillId: uuid("prebill_id").notNull(),
    projectId: uuid("project_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    sourceType: text("source_type", { enum: ["time_entry", "document_line"] }).notNull(),
    timeEntryId: uuid("time_entry_id"),
    documentLineId: uuid("document_line_id"),
    sourceDocumentId: uuid("source_document_id"),
    sourceDate: date("source_date").notNull(),
    description: text("description"),
    quantity: money("quantity").notNull().default("1"),
    unit: text("unit"),
    itemId: uuid("item_id"),
    incomeAccountId: uuid("income_account_id"),
    taxCodeId: uuid("tax_code_id"),
    employeePartyId: uuid("employee_party_id"),
    timeTypeId: uuid("time_type_id"),
    departmentId: uuid("department_id"),
    costAmount: money("cost_amount").notNull().default("0"),
    originalBillAmount: money("original_bill_amount").notNull().default("0"),
    proposedBillAmount: money("proposed_bill_amount").notNull().default("0"),
    adjustmentAmount: money("adjustment_amount").notNull().default("0"),
    adjustmentReason: text("adjustment_reason"),
    /** File-cabinet ids, links, or concise controller evidence references. */
    adjustmentEvidence: jsonb("adjustment_evidence").notNull().default([]),
    /** Effective project policy and direct/overhead pricing evidence frozen with the line. */
    pricingSnapshot: jsonb("pricing_snapshot").notNull().default({}),
    disposition: text("disposition", { enum: ["bill", "hold"] }).notNull().default("bill"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("wip_prebill_lines_number").on(t.orgId, t.prebillId, t.lineNumber),
    index("wip_prebill_lines_time_source").on(t.orgId, t.timeEntryId),
    index("wip_prebill_lines_cost_source").on(t.orgId, t.documentLineId),
    index("wip_prebill_lines_prebill").on(t.orgId, t.prebillId),
  ],
);

/** Explicit, releasable source-level billing hold, independent of a worksheet. */
export const wipHolds = pgTable(
  "wip_holds",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    sourceType: text("source_type", { enum: ["time_entry", "document_line"] }).notNull(),
    sourceId: uuid("source_id").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").notNull().default([]),
    heldAt: timestamp("held_at", { withTimezone: true }).notNull().defaultNow(),
    heldBy: uuid("held_by").notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
    ...auditColumns,
  },
  (t) => [
    index("wip_holds_active_source").on(t.orgId, t.sourceType, t.sourceId, t.releasedAt),
    index("wip_holds_project").on(t.orgId, t.projectId, t.releasedAt),
  ],
);

/** Append-only workflow and commercial-adjustment evidence. */
export const wipPrebillEvents = pgTable(
  "wip_prebill_events",
  {
    id: id(),
    orgId: orgRef(),
    prebillId: uuid("prebill_id").notNull(),
    eventType: text("event_type", {
      enum: [
        "created",
        "line_updated",
        "hold_created",
        "hold_released",
        "submitted",
        "returned",
        "approved",
        "converted",
        "voided",
      ],
    }).notNull(),
    actorId: uuid("actor_id").notNull(),
    details: jsonb("details").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("wip_prebill_events_timeline").on(t.orgId, t.prebillId, t.occurredAt)],
);
