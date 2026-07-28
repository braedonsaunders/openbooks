import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auditColumns, currencyCode, id, orgRef } from "./helpers";

/**
 * Native Field Ticket header extension.
 *
 * `documents` owns the common commercial header; this one-to-one table owns
 * the product's Field Ticket state. Tenant-defined extension fields may still
 * use documents.custom, but OpenBooks' own fields must never live there.
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
    index("field_tickets_org_period").on(t.orgId, t.periodStart, t.periodEnd),
    index("field_tickets_foreman").on(t.orgId, t.foremanPartyId),
    check("field_tickets_period_order", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

/**
 * Effective-dated Field Ticket policy. Scope precedence is project → customer
 * → organization; ticket headers snapshot the resolved period so later policy
 * changes never reinterpret historical work.
 */
export const fieldTicketPolicies = pgTable(
  "field_ticket_policies",
  {
    id: id(),
    orgId: orgRef(),
    scope: text("scope", {
      enum: ["organization", "customer", "project"],
    }).notNull(),
    customerPartyId: uuid("customer_party_id"),
    projectId: uuid("project_id"),
    period: text("period", {
      enum: ["shift", "daily", "weekly"],
    }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("field_ticket_policies_resolution").on(
      t.orgId,
      t.scope,
      t.projectId,
      t.customerPartyId,
      t.effectiveFrom,
    ),
    check(
      "field_ticket_policies_scope_shape",
      sql`(${t.scope} = 'organization' and ${t.customerPartyId} is null and ${t.projectId} is null)
        or (${t.scope} = 'customer' and ${t.customerPartyId} is not null and ${t.projectId} is null)
        or (${t.scope} = 'project' and ${t.projectId} is not null and ${t.customerPartyId} is null)`,
    ),
    check(
      "field_ticket_policies_date_order",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  ],
);

/**
 * Versioned commercial labor evidence for a Field Ticket.
 *
 * `time_entries` remains the operational time/payroll ledger. An approved or
 * signed ticket needs a stable representation of exactly what the customer
 * saw, even when an upstream system later corrects an atomic time entry. Each
 * controlled amendment appends a revision and supersedes (never rewrites) the
 * prior snapshot.
 */
export const fieldTicketLaborSnapshots = pgTable(
  "field_ticket_labor_snapshots",
  {
    id: id(),
    orgId: orgRef(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    revision: integer("revision").notNull(),
    evidenceBasis: text("evidence_basis", {
      enum: ["operational_time", "source_import", "controlled_amendment"],
    }).notNull(),
    reason: text("reason").notNull(),
    sourceSystem: text("source_system"),
    sourcePayloadHash: text("source_payload_hash"),
    currency: currencyCode("currency").notNull(),
    capturedBy: uuid("captured_by"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    supersededBy: uuid("superseded_by"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("field_ticket_labor_snapshots_revision").on(
      t.orgId,
      t.fieldTicketId,
      t.revision,
    ),
    uniqueIndex("field_ticket_labor_snapshots_current")
      .on(t.orgId, t.fieldTicketId)
      .where(sql`${t.supersededAt} is null`),
    index("field_ticket_labor_snapshots_ticket").on(
      t.orgId,
      t.fieldTicketId,
      t.capturedAt,
    ),
    check("field_ticket_labor_snapshots_revision_positive", sql`${t.revision} > 0`),
    check(
      "field_ticket_labor_snapshots_supersession_shape",
      sql`(${t.supersededAt} is null and ${t.supersededBy} is null)
        or (${t.supersededAt} is not null and ${t.supersededBy} is not null)`,
    ),
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

/** Immutable signatures captured against a Field Ticket. */
export const fieldTicketSignatures = pgTable(
  "field_ticket_signatures",
  {
    id: id(),
    orgId: orgRef(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    role: text("role", { enum: ["foreman", "customer"] }).notNull(),
    signerName: text("signer_name").notNull(),
    comment: text("comment"),
    /** Immutable image evidence stored through the versioned File Cabinet
     * (S3/MinIO when configured), never embedded in document custom JSON. */
    signatureFileId: uuid("signature_file_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("field_ticket_signatures_role").on(
      t.orgId,
      t.fieldTicketId,
      t.role,
    ),
    index("field_ticket_signatures_ticket").on(t.orgId, t.fieldTicketId),
  ],
);

/** Append-only delivery history for customer-signature requests. */
export const fieldTicketSignatureRequests = pgTable(
  "field_ticket_signature_requests",
  {
    id: id(),
    orgId: orgRef(),
    fieldTicketId: uuid("field_ticket_id").notNull(),
    recipient: text("recipient").notNull(),
    message: text("message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** SHA-256 of the possession token. Raw signing credentials are never
     * persisted, while each request remains independently revocable. */
    tokenDigest: text("token_digest").notNull(),
    emailLogId: uuid("email_log_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("field_ticket_signature_requests_ticket").on(
      t.orgId,
      t.fieldTicketId,
      t.sentAt,
    ),
    uniqueIndex("field_ticket_signature_requests_token").on(t.tokenDigest),
    check(
      "field_ticket_signature_requests_expiry",
      sql`${t.sentAt} is null or ${t.expiresAt} > ${t.sentAt}`,
    ),
  ],
);
