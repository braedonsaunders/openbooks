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
  numeric,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, fxRate, id, money, orgRef } from "./helpers";

/**
 * Business documents — the mutable layer users touch. One supertype table +
 * lines; `kind` drives behavior via posting rules, not via 20 near-identical
 * tables. Posting produces exactly one journal entry (ledger.ts). Posted
 * documents are immutable; corrections are represented by linked reversal
 * entries so the original business record and GL evidence are never rewritten.
 *
 * Concurrency: `updated_at` is the optimistic-concurrency revision token.
 * Readers project it through web/lib/documents.ts documentRevisionSql at full
 * six-digit precision, and migration 0013_document_revision_monotonic forces
 * every UPDATE to advance it — a write that would repeat the stored revision
 * is bumped forward at the database boundary, so two committed revisions can
 * never share a token, whichever driver wrote them.
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
    /**
     * The legal entity this document belongs to (→ subsidiaries); null means
     * the org's root subsidiary (posting resolves it). Defaulted from the
     * party's primary subsidiary in the editor; locked once posted.
     */
    subsidiaryId: uuid("subsidiary_id"),
    documentDate: date("document_date").notNull(),
    postingDate: date("posting_date"),
    /** Explicit accounting-period override. This is first-class because an
     * accounting period is not always derivable from the transaction date
     * (late postings and adjustment periods are ordinary ERP behavior). */
    postingPeriodId: uuid("posting_period_id"),
    dueDate: date("due_date"),
    currency: currencyCode("currency").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),

    /** Lifecycle only — approval state lives in approvals.*, not here. */
    status: text("status", { enum: ["draft", "pending_approval", "approved", "posted", "voided"] })
      .notNull()
      .default("draft"),
    /** The actual actor who last submitted this revision for approval. */
    submittedBy: uuid("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    postedEntryId: uuid("posted_entry_id"), // → journal_entries
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    /** Required immutable business reason for the reversal/void. */
    voidReason: text("void_reason"),
    /** A posted document stays posted while its before_void flow gates wait. */
    voidRequestedAt: timestamp("void_requested_at", { withTimezone: true }),
    voidRequestedBy: uuid("void_requested_by"),
    voidReversalDate: date("void_reversal_date"),
    reversalEntryId: uuid("reversal_entry_id"),

    // Denormalized totals (fast lists), derived from this document's lines.
    // Migration 0017_document_total_line_invariant refreshes them whenever a
    // line's financial shape changes and rejects any committed header write
    // whose subtotal/tax_total/total contradict those lines (debit-side totals
    // for journal-shaped kinds). documents_posted_financial_guard then freezes
    // the verified values once the document posts.
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    // Amount remaining to settle (source platform "Amount Remaining") — abs(open-item
    // line) − applied for posted open-item docs, else NULL. Maintained by the
    // open-balance triggers in migrations/generated/0001_baseline.sql so lists
    // can show/sort/filter it without a live applications join.
    openBalance: money("open_balance"),

    // Header dimensions — defaults inherited by lines.
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    /** Custom segment assignments keyed by segment_definitions.key. */
    extraDims: jsonb("extra_dims").notNull().default({}),
    paymentCardId: uuid("payment_card_id"), // card_charge/refund docs

    // Operational document metadata promoted to typed columns:
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
    /**
     * "Does this party have any payable document?" — the cash cockpit asks it
     * once per party. Partial, so the probe lands on a few thousand rows
     * instead of walking a party's whole document history.
     */
    index("documents_org_party_payable")
      .on(t.orgId, t.partyId)
      .where(sql`${t.voidedAt} is null and ${t.kind} in ('vendor_bill', 'vendor_payment', 'check', 'expense_report')`),
    index("documents_project").on(t.projectId),
    check(
      "documents_posted_period_required",
      sql`${t.status} <> 'posted' or (${t.postedEntryId} is not null and ${t.postingPeriodId} is not null)`,
    ),
    // Product-owned Field Ticket state is relational. Reserve its old JSON key
    // so no importer or API can create a parallel source of truth.
    check(
      "documents_no_field_ticket_custom",
      sql`not (${t.custom} ? 'fieldTicket')`,
    ),
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
    /** Quantities and rates preserve commercial precision independently from
     * the four-decimal posted amount. */
    quantity: numeric("quantity", { precision: 28, scale: 8 }).notNull().default("1"),
    unit: text("unit"),
    unitPrice: numeric("unit_price", { precision: 28, scale: 8 }).notNull().default("0"),
    amount: money("amount").notNull(), // qty × price, txn currency
    taxCodeId: uuid("tax_code_id"),
    /** Mutually exclusive with tax_code_id; expands to ordered component evidence. */
    taxGroupId: uuid("tax_group_id"),
    /** User-entered gross when tax is inclusive; otherwise equals amount. */
    taxInputAmount: money("tax_input_amount"),
    taxAmount: money("tax_amount").notNull().default("0"),
    /**
     * True when tax_amount was manually set instead of computed from the tax
     * code's rate (rounding, partial exemptions, "strange situations", and
     * migrated transactions where the source system's tax was hand-adjusted).
     * The engine still computes the expected tax for validation, but posting
     * uses tax_amount as-is. Kept transparent so an override is auditable.
     */
    taxOverridden: boolean("tax_overridden").notNull().default(false),

    /**
     * Line-level subledger entity — the customer/vendor/employee this specific
     * line belongs to (→ parties), independent of the header party. Faithful to
     * how every source system models a transaction line: source platform's line "Name"
     * / source platform's line Entity. AR/AP legs on journals (e.g. opening-balance/month-end
     * entries) carry their party HERE, not on the header. Polymorphic "line
     * entity" = this party_id OR the projectId below (a job); the import routes
     * the source line entity to whichever it resolves to.
     */
    partyId: uuid("party_id"),

    // Line dimensions (override header defaults).
    departmentId: uuid("department_id"),
    projectId: uuid("project_id"),
    locationId: uuid("location_id"),
    classId: uuid("class_id"),
    /** Line-level subsidiary override — intercompany journals only. */
    subsidiaryId: uuid("subsidiary_id"),
    /** Line overrides for custom segment assignments. */
    extraDims: jsonb("extra_dims").notNull().default({}),

    // Job-costing and billing-lineage columns:
    employeeId: uuid("employee_id"), // labor line: who worked it
    timeEntryId: uuid("time_entry_id"), // provenance from timesheets
    timeTypeId: uuid("time_type_id"),
    /** Rate factor for the WORK ITSELF — 1.5 for overtime, 2 for double time.
     *  Never a markup: conflating the two turns a 15% markup into fifteen times
     *  the cost. */
    costMultiplier: money("cost_multiplier"),
    /**
     * Markup charged over this line's cost when it is rebilled, as a PERCENTAGE
     * (15 means 15%, never 0.15). Null means bill at cost — distinct from 0,
     * which also bills at cost but says so deliberately, and both differ from
     * "unset, so fall back to the project type's default markup".
     */
    markupPercent: numeric("markup_percent", { precision: 19, scale: 4 }),
    /** Can this cost be rebilled to the project's customer? */
    isBillable: boolean("is_billable").notNull().default(false),
    billedByLineId: uuid("billed_by_line_id"), // invoice line that billed this cost
    /**
     * The field ticket this cost belongs to. Crews attach materials, equipment
     * and expenses to the ticket they were consumed on, so ticket-based billing
     * must follow that link rather than inferring it from dates — the mirror of
     * time_entries.field_ticket_id.
     */
    fieldTicketId: uuid("field_ticket_id"),

    // Explicit rate/usage snapshots. Native columns keep financial behavior out
    // of custom JSON and allow cost=0 with a positive customer bill amount.
    equipmentUnitId: uuid("equipment_unit_id"),
    rateVersionId: uuid("rate_version_id"),
    ratePresentation: text("rate_presentation", { enum: ["summary", "rate_components"] }),
    baseQuantity: money("base_quantity"),
    baseUnit: text("base_unit"),
    costRate: money("cost_rate"),
    billRate: money("bill_rate"),
    costAmount: money("cost_amount"),
    billAmount: money("bill_amount"),
    recoveryAccountId: uuid("recovery_account_id"),

    // Order-state denormalization (orders → fulfillment → billing chain):
    quantityFulfilled: money("quantity_fulfilled").notNull().default("0"),
    quantityBilled: money("quantity_billed").notNull().default("0"),

    /** Stock location for an inventory item line — where a bill receives stock
     *  or an invoice/shipment issues it. Null lines fall back to the single
     *  active stock location, else the line is treated as non-inventory. */
    stockLocationId: uuid("stock_location_id"),

    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    index("doc_lines_document").on(t.documentId),
    index("doc_lines_project_billable").on(t.projectId, t.isBillable),
    index("doc_lines_party").on(t.partyId),
    check("doc_lines_target", sql`${t.itemId} IS NOT NULL OR ${t.accountId} IS NOT NULL`),
    check("doc_lines_one_tax_profile", sql`num_nonnulls(${t.taxCodeId}, ${t.taxGroupId}) <= 1`),
  ],
);

/**
 * Document relationship chains (SO → PO, SO → invoice, bill → payment run):
 * explicit and queryable, replacing source platform's tangle of createdfrom +
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
    /** Mandatory, immutable controller evidence for a correction edge. */
    reason: text("reason"),
    requestedBy: uuid("requested_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("doc_links_from").on(t.fromDocumentId),
    index("doc_links_to").on(t.toDocumentId),
    uniqueIndex("document_links_unique_edge").on(
      t.orgId,
      t.fromDocumentId,
      t.toDocumentId,
      t.linkType,
    ),
  ],
);

/** Item catalog for services, non-inventory, and inventory businesses. */
export const items = pgTable(
  "items",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", {
      enum: ["service", "non_inventory", "inventory", "assembly", "kit", "other_charge", "equipment_charge", "labor", "absence", "discount"],
    }).notNull(),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    category: text("category"), // Absence / Consumables / Equipment / Labor / Services
    incomeAccountId: uuid("income_account_id"),
    expenseAccountId: uuid("expense_account_id"),
    defaultRate: money("default_rate"),
    /** Standard COST per unit — job cost when the item is charged to a project
     *  (the cost side of a resource_usage/project_charge). Distinct from
     *  default_rate (the billable price). */
    defaultCost: money("default_cost"),
    /** When this item is charged to a project, the account CREDITED (the cost
     *  pool relieved / recovery account). Required for every nonzero-cost
     *  project charge and distinct from the debit account. */
    costRecoveryAccountId: uuid("cost_recovery_account_id"),
    unit: text("unit"),
    taxCodeId: uuid("tax_code_id"),
    showOnTimesheet: boolean("show_on_timesheet").notNull().default(false),

    // --- Revenue recognition (ASC 606 / ARM item defaults) ------------------
    /** When set, invoicing this item defers revenue and a recognition schedule
     *  is built from this rule instead of crediting income immediately. */
    recognitionRuleId: uuid("recognition_rule_id"),
    /** Item-level deferred-revenue account override (else the rule's). */
    deferredAccountId: uuid("deferred_account_id"),
    /** Trigger for creating the obligation/plan: on billing (invoice post),
     *  fulfillment, or revenue-arrangement creation. */
    createPlansOn: text("create_plans_on", { enum: ["billing", "fulfillment", "arrangement"] })
      .notNull()
      .default("billing"),
    /** Relative-SSP allocation participation: normal, exclude (carve-out),
     *  or software (residual/VSOE). */
    revenueAllocation: text("revenue_allocation", { enum: ["normal", "exclude", "software"] })
      .notNull()
      .default("normal"),
    /** Fallback standalone selling price when no dated fair_value_prices row. */
    standaloneSellingPrice: money("standalone_selling_price"),

    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [uniqueIndex("items_org_code").on(t.orgId, t.code)],
);

/**
 * Overhead rates — a real job-costing concept here (was a source platform custom
 * record driving hand-built payroll JEs). Drives overhead absorption on jobs:
 * DR project WIP/COGS, CR overhead applied.
 */
export const overheadRates = pgTable("overhead_rates", {
  id: id(),
  orgId: orgRef(),
  departmentId: uuid("department_id"),
  category: text("category"), // Equipment / Indirect Labour / Consumables…
  method: text("method", { enum: ["three_year_average", "live", "standard"] }).notNull().default("live"),
  /** How to read `rate`: per_hour = $/labor-hour,
   *  percent = % of labor cost. */
  rateKind: text("rate_kind", { enum: ["per_hour", "percent"] }).notNull().default("per_hour"),
  /** The rate value — $/hour when rateKind=per_hour, a percentage when percent. */
  ratePercent: money("rate_percent").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  ...auditColumns,
});

export const timeTypes = pgTable("time_types", {
  id: id(),
  orgId: orgRef(),
  name: text("name").notNull(), // Regular, Overtime, Double-time, Shop…
  /** Semantic class is independent from the commercial multipliers. A tenant
   * may pay straight time while presenting an overtime category, so neither
   * names nor numeric rates are a safe way to infer this meaning. */
  classification: text("classification", {
    enum: ["regular", "overtime", "double_time", "other"],
  })
    .notNull()
    .default("regular"),
  costMultiplier: money("cost_multiplier").notNull().default("1"),
  /** Default bill-rate multiplier (OT ×1.5, DT ×2). A rate-book line's
   * explicit per-time-type rate overrides this. */
  billMultiplier: money("bill_multiplier").notNull().default("1"),
  isBillableDefault: boolean("is_billable_default").notNull().default(true),
  /** Opt-in for the compact crew grid. Time types remain available to normal
   * timesheets and costing when this is false. */
  showOnFieldTicket: boolean("show_on_field_ticket").notNull().default(false),
  /**
   * The entry records a field EVENT, not worked time: an on-call day, a
   * claimed per-diem night. Derived earnings rules (pay_derived_rules) read
   * these entries; the wage calculation skips them, so a supervisor asserting
   * "he was on call Tuesday" never produces a zero-dollar wage line or phantom
   * hours that per-hour components and union fringes would then price.
   */
  excludeFromWages: boolean("exclude_from_wages").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  custom: jsonb("custom").notNull().default({}), // keeps source platform nsId for the time-record import bridge
  /**
   * `costMultiplier` and `excludeFromWages` are direct inputs to gross earnings
   * in calculatePayRun, so this is money configuration and carries the audit
   * quartet: without `updatedAt`, raising an overtime multiplier after a run is
   * calculated is invisible to `payRunStaleness` and the run commits wages at
   * the old rate while reporting itself fresh.
   */
  ...auditColumns,
});
