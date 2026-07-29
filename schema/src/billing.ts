import {
  boolean,
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
 * Project billing — the native job-billing
 * flow (a source platform front-end there). A billing_request is a pre-invoice work
 * order that generates a `customer_invoice` DOCUMENT (never a parallel invoice
 * table — invoices are documents, posted through the existing kernel). The
 * generator (web/lib/billing) consumes unbilled billable time_entries + cost
 * lines, stamping their provenance columns so re-billing is idempotent.
 */
export const billingRequests = pgTable(
  "billing_requests",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    requestNumber: text("request_number").notNull(),
    invoiceType: text("invoice_type", { enum: ["progress", "final"] }).notNull().default("progress"),
    /** How the invoice lines are derived. */
    basis: text("basis", {
      enum: ["date_range", "draw_amount", "time_selection", "milestone", "field_ticket"],
    }).notNull().default("date_range"),
    drawAmount: money("draw_amount"),
    startDate: date("start_date"),
    cutoffDate: date("cutoff_date"),
    invoiceDescription: text("invoice_description"),
    customerPo: text("customer_po"),
    /** Snapshot of the project's billing method at request time (drives line-building). */
    billingMethodSnapshot: text("billing_method_snapshot", {
      enum: ["time_and_materials", "fixed_price", "cost_plus"],
    }),
    backupRequired: boolean("backup_required").notNull().default(false),
    backupType: text("backup_type", {
      enum: [
        "none",
        "costed_timesheets",
        "quote_only",
        "timesheets_purchases",
        "purchases",
        "purchases_shop_time",
      ],
    }).notNull().default("none"),
    status: text("status", { enum: ["open", "invoiced", "closed", "cancelled"] }).notNull().default("open"),
    /** The generated customer_invoice document (null until created). */
    invoiceDocumentId: uuid("invoice_document_id"),
    /** Selected time-entry ids for basis='time_selection' (else null). */
    selectedTimeEntryIds: jsonb("selected_time_entry_ids"),
    notes: text("notes"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("billing_requests_project").on(t.orgId, t.projectId, t.status),
    uniqueIndex("billing_requests_org_number").on(t.orgId, t.requestNumber),
  ],
);

/**
 * Immutable Field Ticket selections captured by a billing request.
 *
 * A request is a workflow record rather than a document, so this relationship
 * does not belong in document_links. Once the request generates an invoice,
 * document_links records the separate Field Ticket → invoice business edge.
 */
export const billingRequestFieldTickets = pgTable(
  "billing_request_field_tickets",
  {
    id: id(),
    orgId: orgRef(),
    billingRequestId: uuid("billing_request_id").notNull(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    selectionSource: text("selection_source", {
      enum: ["request_creation", "legacy_json_migration", "validation_replay"],
    }).notNull().default("request_creation"),
    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    selectedBy: uuid("selected_by"),
  },
  (t) => [
    uniqueIndex("billing_request_field_tickets_request_ticket").on(
      t.orgId,
      t.billingRequestId,
      t.fieldTicketId,
    ),
    index("billing_request_field_tickets_ticket").on(t.orgId, t.fieldTicketId),
  ],
);

/** Milestone / progress billing schedule. */
export const billingSchedules = pgTable(
  "billing_schedules",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    type: text("type"),
    scheduledDate: date("scheduled_date"),
    milestone: text("milestone"),
    percentComplete: money("percent_complete"),
    amountBilled: money("amount_billed"),
    percentBilled: money("percent_billed"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set when this milestone is drawn into a billing request. */
    billingRequestId: uuid("billing_request_id"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [index("billing_schedules_project").on(t.orgId, t.projectId, t.sortOrder)],
);

/**
 * Persisted invoice backup package — the merged PDF (invoice + costed
 * timesheets + vendor-bill/receipt attachments) stored in the file cabinet and
 * attached to the invoice document. componentManifest is the ordered audit
 * trail of what was merged.
 */
export const invoiceBackups = pgTable(
  "invoice_backups",
  {
    id: id(),
    orgId: orgRef(),
    /** The invoice document this backs. */
    documentId: uuid("document_id").notNull(),
    billingRequestId: uuid("billing_request_id"),
    backupType: text("backup_type").notNull(),
    /** The merged PDF in the file cabinet. */
    fileId: uuid("file_id").notNull(),
    pageCount: integer("page_count"),
    componentManifest: jsonb("component_manifest").notNull().default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("invoice_backups_document").on(t.orgId, t.documentId)],
);
