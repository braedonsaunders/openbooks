import { sql } from "drizzle-orm";
import {
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

/** Cost-facing Schedule of Values for one subcontract. */
export const subcontractSovLines = pgTable(
  "subcontract_sov_lines",
  {
    id: id(),
    orgId: orgRef(),
    subcontractId: uuid("subcontract_id").notNull(),
    itemNo: text("item_no"),
    description: text("description").notNull(),
    scheduledValue: money("scheduled_value").notNull().default("0"),
    retainagePercent: money("retainage_percent"),
    expenseAccountId: uuid("expense_account_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    changeOrderId: uuid("change_order_id"),
    ...auditColumns,
  },
  (t) => [
    index("subcontract_sov_subcontract").on(t.orgId, t.subcontractId, t.sortOrder),
    check("subcontract_sov_value_positive", sql`${t.scheduledValue} > 0`),
    check(
      "subcontract_sov_retainage_range",
      sql`${t.retainagePercent} is null or ${t.retainagePercent} between 0 and 100`,
    ),
  ],
);

/** Approved changes are the only way to revise an active commitment. */
export const subcontractChangeOrders = pgTable(
  "subcontract_change_orders",
  {
    id: id(),
    orgId: orgRef(),
    subcontractId: uuid("subcontract_id").notNull(),
    number: text("number").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "approved", "void"] }).notNull().default("draft"),
    amount: money("amount").notNull(),
    targetSovLineId: uuid("target_sov_line_id"),
    approvedOn: date("approved_on"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("subcontract_changes_number").on(t.orgId, t.subcontractId, t.number),
    index("subcontract_changes_subcontract").on(t.orgId, t.subcontractId, t.status),
    check("subcontract_changes_nonzero", sql`${t.amount} <> 0`),
    check(
      "subcontract_changes_approval_pair",
      sql`(${t.approvedAt} is null) = (${t.approvedBy} is null)`,
    ),
  ],
);

/** Vendor request for payment against a subcontract. */
export const vendorPayApplications = pgTable(
  "vendor_pay_applications",
  {
    id: id(),
    orgId: orgRef(),
    subcontractId: uuid("subcontract_id").notNull(),
    applicationNumber: integer("application_number").notNull(),
    periodEnd: date("period_end").notNull(),
    vendorInvoiceNumber: text("vendor_invoice_number"),
    status: text("status", {
      enum: ["draft", "submitted", "approved", "billed", "void"],
    }).notNull().default("draft"),
    defaultRetainagePercent: money("default_retainage_percent").notNull().default("10"),
    grossThisPeriod: money("gross_this_period").notNull().default("0"),
    retainageThisPeriod: money("retainage_this_period").notNull().default("0"),
    netDue: money("net_due").notNull().default("0"),
    vendorBillDocumentId: uuid("vendor_bill_document_id"),
    memo: text("memo"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("vendor_pay_apps_number").on(t.orgId, t.subcontractId, t.applicationNumber),
    index("vendor_pay_apps_subcontract").on(t.orgId, t.subcontractId, t.status),
    uniqueIndex("vendor_pay_apps_bill").on(t.orgId, t.vendorBillDocumentId),
    check("vendor_pay_apps_amounts_nonnegative", sql`${t.grossThisPeriod} >= 0 and ${t.retainageThisPeriod} >= 0 and ${t.netDue} >= 0`),
    check("vendor_pay_apps_net", sql`${t.netDue} = ${t.grossThisPeriod} - ${t.retainageThisPeriod}`),
    check("vendor_pay_apps_retainage_range", sql`${t.defaultRetainagePercent} between 0 and 100`),
    check("vendor_pay_apps_approval_pair", sql`(${t.approvedAt} is null) = (${t.approvedBy} is null)`),
  ],
);

/** Cumulative G703-style evidence for each vendor SOV line. */
export const vendorPayApplicationLines = pgTable(
  "vendor_pay_application_lines",
  {
    id: id(),
    orgId: orgRef(),
    payApplicationId: uuid("pay_application_id").notNull(),
    sovLineId: uuid("sov_line_id").notNull(),
    previousEarned: money("previous_earned").notNull().default("0"),
    previousMaterialsStored: money("previous_materials_stored").notNull().default("0"),
    workCompletedThisPeriod: money("work_completed_this_period").notNull().default("0"),
    materialsStoredCurrent: money("materials_stored_current").notNull().default("0"),
    retainagePercent: money("retainage_percent").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("vendor_pay_app_lines_app_sov").on(t.payApplicationId, t.sovLineId),
    index("vendor_pay_app_lines_app").on(t.orgId, t.payApplicationId),
    check("vendor_pay_app_lines_nonnegative", sql`${t.previousEarned} >= 0 and ${t.previousMaterialsStored} >= 0 and ${t.workCompletedThisPeriod} >= 0 and ${t.materialsStoredCurrent} >= 0`),
    check("vendor_pay_app_lines_retainage_range", sql`${t.retainagePercent} between 0 and 100`),
  ],
);

/** A release becomes a normal vendor bill that debits Retainage Payable. */
export const vendorRetainageReleases = pgTable(
  "vendor_retainage_releases",
  {
    id: id(),
    orgId: orgRef(),
    subcontractId: uuid("subcontract_id").notNull(),
    periodEnd: date("period_end").notNull(),
    amount: money("amount").notNull(),
    vendorBillDocumentId: uuid("vendor_bill_document_id").notNull(),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("vendor_retainage_releases_bill").on(t.orgId, t.vendorBillDocumentId),
    index("vendor_retainage_releases_subcontract").on(t.orgId, t.subcontractId),
    check("vendor_retainage_releases_positive", sql`${t.amount} > 0`),
  ],
);

/** Joint-check instructions and explicit payment holds released by AP staff. */
export const subcontractPaymentControls = pgTable(
  "subcontract_payment_controls",
  {
    id: id(),
    orgId: orgRef(),
    subcontractId: uuid("subcontract_id").notNull(),
    payApplicationId: uuid("pay_application_id"),
    vendorBillDocumentId: uuid("vendor_bill_document_id"),
    controlType: text("control_type", { enum: ["joint_check", "payment_hold"] }).notNull(),
    status: text("status", { enum: ["active", "released", "void"] }).notNull().default("active"),
    jointPayeePartyId: uuid("joint_payee_party_id"),
    amountLimit: money("amount_limit"),
    reason: text("reason").notNull(),
    effectiveOn: date("effective_on").notNull(),
    expiresOn: date("expires_on"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by"),
    releaseReason: text("release_reason"),
    ...auditColumns,
  },
  (t) => [
    index("subcontract_payment_controls_active").on(t.orgId, t.subcontractId, t.status),
    check("subcontract_payment_controls_limit", sql`${t.amountLimit} is null or ${t.amountLimit} > 0`),
    check("subcontract_payment_controls_window", sql`${t.expiresOn} is null or ${t.expiresOn} >= ${t.effectiveOn}`),
    check("subcontract_payment_controls_reason", sql`length(btrim(${t.reason})) > 0`),
    check(
      "subcontract_payment_controls_joint_payee",
      sql`(${t.controlType} = 'joint_check') = (${t.jointPayeePartyId} is not null)`,
    ),
    check(
      "subcontract_payment_controls_release",
      sql`(${t.status} = 'released') = (${t.releasedAt} is not null and ${t.releasedBy} is not null and ${t.releaseReason} is not null)`,
    ),
  ],
);
