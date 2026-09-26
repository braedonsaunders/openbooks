import {
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

// ---------------------------------------------------------------------------
// Lien waivers
// ---------------------------------------------------------------------------

/**
 * A lien waiver — the statutory release exchanged for construction payment.
 *
 * `direction = 'received'` are waivers we collect from subcontractors before
 * releasing their money; `'issued'` are the ones we sign for an owner or
 * upstream contractor in exchange for ours. Not a posting document: no journal
 * entry, no lines. It carries the amount and the through-date it releases, and
 * the payment control reads exactly those two fields.
 */
export const lienWaivers = pgTable(
  "lien_waivers",
  {
    id: id(),
    orgId: orgRef(),
    waiverNumber: text("waiver_number").notNull(),
    direction: text("direction", { enum: ["received", "issued"] }).notNull(),
    /** Subcontractor (received) or owner/upstream contractor (issued). */
    partyId: uuid("party_id").notNull(),
    projectId: uuid("project_id").notNull(),
    waiverType: text("waiver_type", {
      enum: [
        "conditional_progress",
        "unconditional_progress",
        "conditional_final",
        "unconditional_final",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["draft", "requested", "received", "signed", "rejected", "void"],
    })
      .notNull()
      .default("draft"),
    /** Work performed through this date is released by the waiver. */
    throughDate: date("through_date").notNull(),
    /** Amount released. Payment control compares released vs. requested cash. */
    amount: money("amount").notNull().default("0"),
    currency: currencyCode("currency").notNull(),
    /** Jurisdiction whose statutory form this follows (e.g. 'US-CA', 'CA-ON'). */
    jurisdiction: text("jurisdiction"),
    /** The vendor bill this waiver covers (received) — optional but usual. */
    billDocumentId: uuid("bill_document_id"),
    /** The vendor payment that released against it (set when the run posts). */
    paymentDocumentId: uuid("payment_document_id"),
    /** The application for payment this waiver accompanies (issued). */
    payApplicationId: uuid("pay_application_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    requestedBy: uuid("requested_by"),
    /** Signature evidence — same HMAC-token scheme as field-ticket signing. */
    signedByName: text("signed_by_name"),
    signedByTitle: text("signed_by_title"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signature: jsonb("signature"),
    notarized: boolean("notarized").notNull().default(false),
    rejectedReason: text("rejected_reason"),
    voidReason: text("void_reason"),
    notes: text("notes"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("lien_waivers_org_number").on(t.orgId, t.waiverNumber),
    index("lien_waivers_party").on(t.orgId, t.partyId, t.throughDate),
    index("lien_waivers_project").on(t.orgId, t.projectId, t.status),
    index("lien_waivers_bill").on(t.orgId, t.billDocumentId),
  ],
);
