import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { auditColumns, id, orgRef } from "./helpers";

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
