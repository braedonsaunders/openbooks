import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Vendor-side construction commitments and progress billing.
 *
 * Customer applications for payment live in construction.ts. These records are
 * deliberately separate: a subcontract is an AP commitment to one vendor, its
 * SOV is cost-facing, and approved applications generate standard vendor bills.
 */
export const subcontracts = pgTable(
  "subcontracts",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    vendorId: uuid("vendor_id").notNull(),
    number: text("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", {
      enum: ["draft", "pending_approval", "active", "substantially_complete", "closed", "void"],
    }).notNull().default("draft"),
    currency: currencyCode("currency").notNull(),
    originalCommitment: money("original_commitment").notNull().default("0"),
    defaultRetainagePercent: money("default_retainage_percent").notNull().default("10"),
    purchaseOrderId: uuid("purchase_order_id"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    paymentHoldReason: text("payment_hold_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subcontracts_org_number").on(t.orgId, t.number),
    index("subcontracts_project_status").on(t.orgId, t.projectId, t.status),
    index("subcontracts_vendor_status").on(t.orgId, t.vendorId, t.status),
    check("subcontracts_original_nonnegative", sql`${t.originalCommitment} >= 0`),
    check(
      "subcontracts_retainage_range",
      sql`${t.defaultRetainagePercent} between 0 and 100`,
    ),
    check("subcontracts_date_window", sql`${t.endsOn} is null or ${t.startsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
    check(
      "subcontracts_approval_pair",
      sql`(${t.approvedAt} is null) = (${t.approvedBy} is null)`,
    ),
  ],
);
