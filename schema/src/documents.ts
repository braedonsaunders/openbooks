import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/**
 * Business documents — the mutable layer users touch. One supertype table +
 * lines; `kind` drives behavior via posting rules, not via 20 near-identical
 * tables. Posting produces exactly one journal entry (ledger.ts) and freezes
 * the document.
 *
 * Kinds (initial set, from actual usage): vendor_bill, vendor_credit,
 * vendor_payment, expense_report, customer_invoice, customer_credit,
 * customer_payment, sales_order, purchase_order, cheque, card_charge,
 * card_refund, transfer, quote.
 */
export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind").notNull(),
    documentNumber: text("document_number").notNull(),
    partyId: uuid("party_id"), // customer/vendor/employee, per kind
    documentDate: date("document_date").notNull(),
    postingDate: date("posting_date"),
    dueDate: date("due_date"),
    currency: currencyCode("currency").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),

    /** Lifecycle only — approval state lives in approvals.*, not here. */
    status: text("status", { enum: ["draft", "pending_approval", "approved", "posted", "voided"] })
      .notNull()
      .default("draft"),
    postedEntryId: uuid("posted_entry_id"), // → journal_entries
    voidedAt: timestamp("voided_at", { withTimezone: true }),

    // Denormalized totals, recomputed from lines by trigger (fast lists).
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),

    // Header dimensions — defaults inherited by lines.
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    paymentCardId: uuid("payment_card_id"), // card_charge/refund docs

    // Promoted from Rassaun custbody fields:
    billingMethod: text("billing_method", { enum: ["time_and_materials", "fixed_price"] }),
    isFinalInvoice: boolean("is_final_invoice").notNull().default(false),
    referenceNumber: text("reference_number"), // vendor's invoice no., cheque no.
    internalNotes: text("internal_notes"),
    paymentHoldReason: text("payment_hold_reason"), // non-null = on hold
    expectedPayDate: date("expected_pay_date"),

    memo: text("memo"),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("documents_org_kind_number").on(t.orgId, t.kind, t.documentNumber),
    index("documents_org_kind_status").on(t.orgId, t.kind, t.status),
    index("documents_party").on(t.partyId),
    index("documents_project").on(t.projectId),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id"), // → items (catalog); nullable: direct account lines
    accountId: uuid("account_id"), // expense/income account when no item
    description: text("description"),
    quantity: money("quantity").notNull().default("1"),
    unit: text("unit"),
    unitPrice: money("unit_price").notNull().default("0"),
    amount: money("amount").notNull(), // qty × price, txn currency
    taxCodeId: uuid("tax_code_id"),
    taxAmount: money("tax_amount").notNull().default("0"),

    // Line dimensions (override header defaults).
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),

    // Promoted from Rassaun custcols — job-costing/billing chain:
    employeeId: uuid("employee_id"), // labor line: who worked it
    timeEntryId: uuid("time_entry_id"), // provenance from timesheets
    timeTypeId: uuid("time_type_id"),
    costMultiplier: money("cost_multiplier"), // e.g. 1.5 OT
    isBillable: boolean("is_billable").notNull().default(false),
    billedByLineId: uuid("billed_by_line_id"), // invoice line that billed this cost

    // Order-state denormalization (orders → fulfillment → billing chain):
    quantityFulfilled: money("quantity_fulfilled").notNull().default("0"),
    quantityBilled: money("quantity_billed").notNull().default("0"),

    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("doc_lines_document").on(t.documentId),
    index("doc_lines_project_billable").on(t.projectId, t.isBillable),
    check("doc_lines_target", sql`${t.itemId} IS NOT NULL OR ${t.accountId} IS NOT NULL`),
  ],
);

/**
 * Document relationship chains (SO → PO, SO → invoice, bill → payment run):
 * explicit and queryable, replacing NetSuite's tangle of createdfrom +
 * link tables + custbody "SO Created From" workarounds.
 */
export const documentLinks = pgTable(
  "document_links",
  {
    id: id(),
    orgId: orgRef(),
    fromDocumentId: uuid("from_document_id").notNull(),
    toDocumentId: uuid("to_document_id").notNull(),
    linkType: text("link_type", {
      enum: ["created_from", "fulfills", "bills", "pays", "reverses", "renews"],
    }).notNull(),
    ...auditColumns,
  },
  (t) => [
    index("doc_links_from").on(t.fromDocumentId),
    index("doc_links_to").on(t.toDocumentId),
  ],
);

/** Item catalog — services business first (Rassaun: zero inventory items). */
export const items = pgTable(
  "items",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", {
      enum: ["service", "non_inventory", "inventory", "assembly", "kit", "other_charge", "labor", "absence", "discount"],
    }).notNull(),
    code: text("code"),
    name: text("name").notNull(),
    category: text("category"), // Absence / Consumables / Equipment / Labor / Services
    incomeAccountId: uuid("income_account_id"),
    expenseAccountId: uuid("expense_account_id"),
    defaultRate: money("default_rate"),
    unit: text("unit"),
    taxCodeId: uuid("tax_code_id"),
    showOnTimesheet: boolean("show_on_timesheet").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [uniqueIndex("items_org_code").on(t.orgId, t.code)],
);

/**
 * Labor burden rates — a real accounting concept here (was a NetSuite custom
 * record driving hand-built payroll JEs). The burden engine posts
 * origin='labor_burden' journals: DR project WIP/COGS, CR burden absorbed.
 */
export const laborBurdenRates = pgTable("labor_burden_rates", {
  id: id(),
  orgId: orgRef(),
  departmentId: uuid("department_id"),
  category: text("category"), // Equipment / Indirect Labour / Consumables…
  method: text("method", { enum: ["three_year_average", "live"] }).notNull().default("live"),
  ratePercent: money("rate_percent").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  ...auditColumns,
});

export const timeTypes = pgTable("time_types", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(), // Regular, Overtime, Double-time, Shop…
  costMultiplier: money("cost_multiplier").notNull().default("1"),
  isBillableDefault: boolean("is_billable_default").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
});
