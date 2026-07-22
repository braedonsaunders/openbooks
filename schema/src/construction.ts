import {
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Construction progress billing — AIA G702/G703 shaped, on top of projects.
 *
 * A project carries a Schedule of Values (sov_lines): the contract broken into
 * billable line items, each with a scheduled value. Change orders adjust the
 * contract sum by adding/valuing SOV lines. Each billing period is an
 * Application for Payment (pay_applications + lines): per SOV line you record
 * work completed this period; the engine bills the gross, withholds retainage
 * into a Retainage Receivable subledger, and the net is the current payment
 * due — all posted through the standard customer_invoice kernel rule.
 */

/** Schedule of Values line — one billable item of the contract (G703 row). */
export const sovLines = pgTable(
  "sov_lines",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    /** G703 "Item No." — free text so 1, 1.1, 02100 all work. */
    itemNo: text("item_no"),
    description: text("description").notNull(),
    scheduledValue: money("scheduled_value").notNull().default("0"),
    /** Per-line retainage override; null → the application's default percent. */
    retainagePercent: money("retainage_percent"),
    /** Income account for this line; null → the project/default income account. */
    incomeAccountId: uuid("income_account_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Set when this line was introduced by an approved change order. */
    changeOrderId: uuid("change_order_id"),
    ...auditColumns,
  },
  (t) => [index("sov_lines_project").on(t.orgId, t.projectId, t.sortOrder)],
);

/** Change order — a net adjustment to the contract sum (its value flows in via
 *  the SOV lines it introduces / revalues). */
export const changeOrders = pgTable(
  "change_orders",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    number: text("number").notNull(),
    description: text("description"),
    status: text("status", { enum: ["draft", "approved", "void"] })
      .notNull()
      .default("draft"),
    /** Net change to the contract sum (informational; the SOV lines are truth). */
    amount: money("amount").notNull().default("0"),
    approvedOn: date("approved_on"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("change_orders_project_number").on(t.orgId, t.projectId, t.number),
    index("change_orders_project").on(t.orgId, t.projectId),
  ],
);

/** Application for Payment (G702 cover sheet) for one billing period. */
export const payApplications = pgTable(
  "pay_applications",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    applicationNumber: integer("application_number").notNull(),
    periodEnd: date("period_end").notNull(),
    /** progress = normal draw; retainage_release = bill the held retainage. */
    kind: text("kind", { enum: ["progress", "retainage_release"] })
      .notNull()
      .default("progress"),
    status: text("status", { enum: ["draft", "submitted", "approved", "posted", "void"] })
      .notNull()
      .default("draft"),
    /** Default retainage % applied to lines without their own override. */
    retainagePercent: money("retainage_percent").notNull().default("10"),
    /** The customer_invoice document this application posted (null until posted). */
    invoiceDocumentId: uuid("invoice_document_id"),
    memo: text("memo"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_applications_project_number").on(t.orgId, t.projectId, t.applicationNumber),
    index("pay_applications_project").on(t.orgId, t.projectId, t.status),
  ],
);

/** One G703 row of an application: work completed this period per SOV line. */
export const payApplicationLines = pgTable(
  "pay_application_lines",
  {
    id: id(),
    orgId: orgRef(),
    payApplicationId: uuid("pay_application_id").notNull(),
    sovLineId: uuid("sov_line_id").notNull(),
    /** Snapshot of work completed by prior posted applications. */
    previousCompleted: money("previous_completed").notNull().default("0"),
    /** Work completed THIS application (the entered draw). */
    thisPeriodCompleted: money("this_period_completed").notNull().default("0"),
    /** Materials presently stored (not yet incorporated). */
    materialsStored: money("materials_stored").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_application_lines_app_sov").on(t.payApplicationId, t.sovLineId),
    index("pay_application_lines_app").on(t.orgId, t.payApplicationId),
  ],
);
