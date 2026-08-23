/**
 * The customization catalog — the stable, code-owned list of record types that
 * can be customized and the built-in fields each one exposes. Like the nav
 * registry (web/lib/nav/registry.ts) or the analytics catalog, this is the
 * CONTRACT between a stored FormLayoutConfig/ListViewConfig and the render +
 * query layers. Keys are stable ids; layouts reference them by `key`.
 *
 * Custom fields (custom_field_defs) are NOT catalogued here — they are dynamic,
 * per-org, and discovered at runtime. Layouts reference them by `cf_<def.key>`.
 *
 * Adding a record type: add a RecordTypeMeta here, implement the web renderers
 * (header fields, line columns) and the list query builder mapping, then ship.
 */

import type {
  FieldMeta,
  FilterOperator,
  ListColumnMeta,
  ListFilterKind,
  ListFilterMeta,
  RecordTypeMeta,
} from "./types";

/** Operators available for each filter kind — reused across record types. */
export const OPERATORS_BY_KIND: Record<ListFilterKind, readonly FilterOperator[]> = {
  select: ["eq", "ne", "in", "not_in"],
  multi_select: ["in", "not_in", "is_set", "is_not_set"],
  entity_ref: ["eq", "ne"],
  date: ["eq", "gte", "lte", "between"],
  boolean: ["eq"],
  text: ["eq", "contains", "is_set", "is_not_set"],
};

/** Line fields shared by every line-based transaction kind (bills, invoices,
 *  credits, card charges, checks). Same grid, same columns — the form layout
 *  decides visibility/order/labels per record type. */
const TRANSACTION_LINE_FIELDS: RecordTypeMeta["lineFields"] = [
  { key: "account_id", labelKey: "common.labels.account", level: "line", kind: "entity_ref", required: true, locked: true },
  { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref" },
  { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
  { key: "quantity", labelKey: "common.labels.quantity", level: "line", kind: "number" },
  { key: "unit", labelKey: "common.labels.unit", level: "line", kind: "text" },
  { key: "unit_price", labelKey: "common.labels.unitPrice", level: "line", kind: "currency" },
  { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
  { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
  { key: "location_id", labelKey: "common.labels.location", level: "line", kind: "dimension" },
  { key: "class_id", labelKey: "common.labels.class", level: "line", kind: "dimension" },
  { key: "tax_code_id", labelKey: "common.labels.tax", level: "line", kind: "entity_ref" },
  { key: "amount", labelKey: "common.labels.amount", level: "line", kind: "amount", required: true },
  { key: "tax_amount", labelKey: "ap.drawer.taxAmountColumn", level: "line", kind: "tax" },
];

/** Manual journals use signed debit/credit columns rather than quantity × rate. */
const JOURNAL_LINE_FIELDS: RecordTypeMeta["lineFields"] = [
  { key: "account_id", labelKey: "common.labels.account", level: "line", kind: "entity_ref", required: true, locked: true },
  { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
  { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
  { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
  { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "line", kind: "entity_ref" },
  { key: "debit", labelKey: "journal.drawer.columns.debit", level: "line", kind: "amount" },
  { key: "credit", labelKey: "journal.drawer.columns.credit", level: "line", kind: "amount" },
];

/** Expense reports expose the expense-entry columns their dedicated drawer persists. */
const EXPENSE_LINE_FIELDS: RecordTypeMeta["lineFields"] = TRANSACTION_LINE_FIELDS.filter((field) =>
  ["account_id", "description", "department_id", "project_id", "tax_code_id", "amount", "tax_amount"].includes(field.key),
);

/** Order-cycle rows use quantity × unit price; amount and tax are calculated columns. */
const ORDER_LINE_FIELDS: RecordTypeMeta["lineFields"] = TRANSACTION_LINE_FIELDS.filter((field) =>
  ["item_id", "account_id", "description", "quantity", "unit", "unit_price", "department_id", "project_id", "tax_code_id", "amount", "tax_amount"].includes(field.key),
);

/** Header built-ins available on every transaction form. */
const COMMON_HEADER_EXTRAS: FieldMeta[] = [
  { key: "posting_date", labelKey: "common.labels.postingDate", level: "header", kind: "date" },
  { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "dimension" },
  { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension" },
  { key: "location_id", labelKey: "common.labels.location", level: "header", kind: "dimension" },
  { key: "class_id", labelKey: "common.labels.class", level: "header", kind: "dimension" },
  { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
  { key: "internal_notes", labelKey: "common.labels.internalNotes", level: "header", kind: "long_text" },
];

/** Extra AP-side header built-ins (bills/credits). */
const PAYABLE_HEADER_EXTRAS: FieldMeta[] = [
  { key: "expected_pay_date", labelKey: "common.labels.expectedPayDate", level: "header", kind: "date" },
  { key: "payment_hold_reason", labelKey: "common.labels.paymentHold", level: "header", kind: "text" },
];

/** Extra AR-side header built-ins (project-billing invoices). */
const INVOICE_HEADER_EXTRAS: FieldMeta[] = [
  { key: "billing_method", labelKey: "common.labels.billingMethod", level: "header", kind: "select" },
  { key: "is_final_invoice", labelKey: "common.labels.finalInvoice", level: "header", kind: "boolean" },
];

/** Status filter shared by the approval-flow kinds (bill/invoice/credits). */
const APPROVAL_STATUS_FILTER: ListFilterMeta = {
  key: "status",
  labelKey: "common.labels.status",
  kind: "select",
  operators: OPERATORS_BY_KIND.select,
  options: [
    { value: "draft", labelKey: "common.status.draft" },
    { value: "pending_approval", labelKey: "common.status.pendingApproval" },
    { value: "approved", labelKey: "common.status.approved" },
    { value: "posted", labelKey: "common.status.posted" },
    { value: "voided", labelKey: "common.status.voided" },
  ],
};

/** Status filter for direct-post banking kinds (no approval step). */
const DIRECT_POST_STATUS_FILTER: ListFilterMeta = {
  key: "status",
  labelKey: "common.labels.status",
  kind: "select",
  operators: OPERATORS_BY_KIND.select,
  options: [
    { value: "draft", labelKey: "common.status.draft" },
    { value: "posted", labelKey: "common.status.posted" },
    { value: "voided", labelKey: "common.status.voided" },
  ],
};

const DATE_FILTER: ListFilterMeta = {
  key: "document_date",
  labelKey: "common.labels.date",
  kind: "date",
  operators: OPERATORS_BY_KIND.date,
};

/** List columns shared by the party-facing kinds; `numberLabelKey` and the
 *  party label differ per kind. */
function partyListColumns(numberLabelKey: string, partyLabelKey: string): ListColumnMeta[] {
  return [
    { key: "document_number", labelKey: numberLabelKey, kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "party_name", labelKey: partyLabelKey, kind: "text", sortable: true, sortKey: "vendor" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "open_balance", labelKey: "common.labels.openBalance", kind: "amount", sortable: true, sortKey: "balance", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ];
}

const VENDOR_BILL: RecordTypeMeta = {
  key: "vendor_bill",
  labelKey: "customization.recordTypes.vendor_bill",
  category: "transaction",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.vendor", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "ap.drawer.dateLabel", level: "header", kind: "date" },
    { key: "due_date", labelKey: "ap.drawer.dueDate", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "ap.drawer.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
    ...PAYABLE_HEADER_EXTRAS,
  ],
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: [
    { key: "document_number", labelKey: "ap.list.columns.bill", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "party_name", labelKey: "common.labels.vendor", kind: "text", sortable: true, sortKey: "vendor" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "reference_number", labelKey: "ap.list.columns.ref", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "open_balance", labelKey: "common.labels.openBalance", kind: "amount", sortable: true, sortKey: "balance", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "common.status.draft" },
        { value: "pending_approval", labelKey: "common.status.pendingApproval" },
        { value: "approved", labelKey: "common.status.approved" },
        { value: "posted", labelKey: "common.status.posted" },
        { value: "voided", labelKey: "common.status.voided" },
      ],
    },
    { key: "party_id", labelKey: "common.labels.vendor", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "vendor" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "reference_number", labelKey: "ap.list.columns.ref", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const VENDOR_CREDIT: RecordTypeMeta = {
  key: "vendor_credit",
  labelKey: "customization.recordTypes.vendor_credit",
  category: "transaction",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.vendor", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "due_date", labelKey: "ap.drawer.dueDate", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "ap.drawer.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
    ...PAYABLE_HEADER_EXTRAS,
  ],
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: partyListColumns("common.labels.number", "common.labels.vendor"),
  listFilters: [
    APPROVAL_STATUS_FILTER,
    { key: "party_id", labelKey: "common.labels.vendor", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "vendor" },
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const CUSTOMER_INVOICE: RecordTypeMeta = {
  key: "customer_invoice",
  labelKey: "customization.recordTypes.customer_invoice",
  category: "transaction",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "due_date", labelKey: "ar.drawer.dueDate", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "ar.drawer.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
    ...INVOICE_HEADER_EXTRAS,
  ],
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: partyListColumns("ar.list.columns.invoice", "common.labels.customer"),
  listFilters: [
    APPROVAL_STATUS_FILTER,
    { key: "party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const CUSTOMER_CREDIT: RecordTypeMeta = {
  key: "customer_credit",
  labelKey: "customization.recordTypes.customer_credit",
  category: "transaction",
  headerFields: CUSTOMER_INVOICE.headerFields,
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: partyListColumns("common.labels.number", "common.labels.customer"),
  listFilters: CUSTOMER_INVOICE.listFilters,
};

/** Banking card documents: no party — the card is the header anchor. */
function cardRecordType(key: string): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    headerFields: [
      { key: "payment_card_id", labelKey: "banking.drawer.card", level: "header", kind: "entity_ref", required: true, locked: true },
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
      ...COMMON_HEADER_EXTRAS,
    ],
    lineFields: TRANSACTION_LINE_FIELDS,
    listColumns: [
      { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [DIRECT_POST_STATUS_FILTER, DATE_FILTER],
  };
}

const CARD_CHARGE = cardRecordType("card_charge");
const CARD_REFUND = cardRecordType("card_refund");

/** Project resource usage is a first-class transaction. Its posted lines keep
 * both job-cost and customer-bill values, so organizations can arrange those
 * immutable snapshots in the same form designer as every other transaction. */
const PROJECT_CHARGE: RecordTypeMeta = {
  key: "project_charge",
  labelKey: "customization.recordTypes.project_charge",
  category: "transaction",
  featureKey: "projects",
  headerFields: [
    { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension", required: true, locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
  ],
  lineFields: [
    { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref", required: true },
    { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
    { key: "quantity", labelKey: "common.labels.quantity", level: "line", kind: "number" },
    { key: "unit", labelKey: "common.labels.unit", level: "line", kind: "text" },
    { key: "cost_rate", labelKey: "projects.charges.costRate", level: "line", kind: "currency" },
    { key: "amount", labelKey: "projects.charges.cost", level: "line", kind: "amount", required: true },
    { key: "bill_rate", labelKey: "projects.charges.billRate", level: "line", kind: "currency" },
    { key: "bill_amount", labelKey: "projects.charges.billValue", level: "line", kind: "amount" },
    { key: "is_billable", labelKey: "timesheets.billable", level: "line", kind: "boolean" },
    { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension", required: true },
  ],
  listColumns: [],
  listFilters: [],
};

const CHECK: RecordTypeMeta = {
  key: "check",
  labelKey: "customization.recordTypes.check",
  category: "transaction",
  headerFields: [
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
  ],
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: [
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    DIRECT_POST_STATUS_FILTER,
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const EXPENSE_REPORT: RecordTypeMeta = {
  key: "expense_report",
  labelKey: "customization.recordTypes.expense_report",
  category: "transaction",
  featureKey: "expenses",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.employee", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "expenses.drawer.reportDate", level: "header", kind: "date" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
  ],
  lineFields: EXPENSE_LINE_FIELDS,
  listColumns: partyListColumns("common.labels.number", "common.labels.employee"),
  listFilters: [
    APPROVAL_STATUS_FILTER,
    { key: "party_id", labelKey: "common.labels.employee", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "employee" },
    DATE_FILTER,
  ],
};

const JOURNAL: RecordTypeMeta = {
  key: "journal",
  labelKey: "customization.recordTypes.journal",
  category: "transaction",
  headerFields: [
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "party_id", labelKey: "common.labels.party", level: "header", kind: "entity_ref" },
    { key: "reference_number", labelKey: "journal.drawer.referenceNumber", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
  ],
  lineFields: JOURNAL_LINE_FIELDS,
  listColumns: [
    { key: "posting_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "entry_number", labelKey: "journal.list.columns.entry", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "memo", labelKey: "common.labels.memo", kind: "text" },
    { key: "origin", labelKey: "journal.list.columns.origin", kind: "text", sortable: true, sortKey: "origin" },
    { key: "line_count", labelKey: "common.labels.lines", kind: "text", sortable: true, sortKey: "lines", defaultWidth: 90 },
    { key: "total_debits", labelKey: "journal.list.columns.debits", kind: "amount", sortable: true, sortKey: "debits", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "origin",
      labelKey: "journal.list.columns.origin",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        ["manual", "manual"], ["closing", "closing"], ["allocation", "allocation"],
        ["revaluation", "revaluation"], ["labor_burden", "laborBurden"],
        ["depreciation", "depreciation"], ["revenue_recognition", "revenueRecognition"],
        ["fx_settlement", "fxSettlement"], ["translation", "translation"],
      ].map(([value, key]) => ({ value: value!, labelKey: `journal.origins.${key}` })),
    },
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "posted", labelKey: "common.status.posted" },
        { value: "reversed", labelKey: "common.status.reversed" },
      ],
    },
    { key: "posting_date", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

function bankDocumentRecordType(key: "deposit" | "transfer"): RecordTypeMeta {
  const isTransfer = key === "transfer";
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    headerFields: [
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      ...(!isTransfer ? [{ key: "reference_number", labelKey: "common.labels.reference", level: "header" as const, kind: "text" as const }] : []),
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
      ...(isTransfer
        ? [{ key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header" as const, kind: "entity_ref" as const }]
        : COMMON_HEADER_EXTRAS),
    ],
    lineFields: isTransfer ? [] : TRANSACTION_LINE_FIELDS,
    listColumns: [
      { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [DIRECT_POST_STATUS_FILTER, DATE_FILTER],
  };
}

const DEPOSIT = bankDocumentRecordType("deposit");
const TRANSFER = bankDocumentRecordType("transfer");

/**
 * Vendor/customer payment documents. Each side owns an independent form;
 * application allocation stays a purpose-built section below the configurable
 * transaction header. The `total` and `bank_account` list columns are
 * journal-derived at query time.
 */
function paymentRecordType(key: string, partyLabelKey: string, entitySource: string): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    headerFields: [
      { key: "party_id", labelKey: partyLabelKey, level: "header", kind: "entity_ref", required: true, locked: true },
      { key: "bank_account_id", labelKey: "payments.list.columns.bankAccount", level: "header", kind: "entity_ref", required: true },
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      { key: "reference_number", labelKey: "common.labels.reference", level: "header", kind: "text" },
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ],
    lineFields: [],
    listColumns: [
      { key: "document_number", labelKey: "payments.list.columns.payment", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "party_name", labelKey: partyLabelKey, kind: "text", sortable: true, sortKey: "party" },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "bank_account", labelKey: "payments.list.columns.bankAccount", kind: "text" },
      { key: "reference_number", labelKey: "payments.list.columns.ref", kind: "text" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 130 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [
      DIRECT_POST_STATUS_FILTER,
      { key: "party_id", labelKey: partyLabelKey, kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource },
      DATE_FILTER,
      { key: "reference_number", labelKey: "payments.list.columns.ref", kind: "text", operators: OPERATORS_BY_KIND.text },
    ],
  };
}

const VENDOR_PAYMENT = paymentRecordType("vendor_payment", "common.labels.vendor", "vendor");
const CUSTOMER_PAYMENT = paymentRecordType("customer_payment", "common.labels.customer", "customer");

/**
 * Order documents (quotes, sales orders, purchase orders). Each lifecycle kind
 * owns an independent form even though the shared OrderDrawer renders them.
 * Conversion progress ("Converted %") lives in a report, not the list.
 */
function orderRecordType(key: string, partyLabelKey: string, entitySource: string): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    featureKey: "orders",
    headerFields: [
      { key: "party_id", labelKey: partyLabelKey, level: "header", kind: "entity_ref", required: true, locked: true },
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      { key: "due_date", labelKey: "common.labels.dueDate", level: "header", kind: "date" },
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
      { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "dimension" },
      { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension" },
    ],
    lineFields: ORDER_LINE_FIELDS,
    listColumns: [
      { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "party_name", labelKey: partyLabelKey, kind: "text", sortable: true, sortKey: "party" },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [
      {
        key: "status",
        labelKey: "common.labels.status",
        kind: "select",
        operators: OPERATORS_BY_KIND.select,
        options: [
          { value: "draft", labelKey: "common.status.draft" },
          { value: "approved", labelKey: "common.status.approved" },
          { value: "voided", labelKey: "common.status.voided" },
        ],
      },
      { key: "party_id", labelKey: partyLabelKey, kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource },
      DATE_FILTER,
      { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
    ],
  };
}

const QUOTE = orderRecordType("quote", "common.labels.customer", "customer");
const SALES_ORDER = orderRecordType("sales_order", "common.labels.customer", "customer");
const PURCHASE_ORDER = orderRecordType("purchase_order", "common.labels.vendor", "vendor");

/** Party-role records share one native parties row, but each role owns a
 * distinct customizable form so customer, vendor, and employee teams can
 * arrange the fields they actually use without exposing the internal
 * multi-role model. Related lists remain standard drawer tabs. */
const PARTY_IDENTITY_FIELDS: RecordTypeMeta["headerFields"] = [
  { key: "kind", labelKey: "parties.drawer.kind", level: "header", kind: "select" },
  { key: "display_name", labelKey: "parties.drawer.displayName", level: "header", kind: "text", required: true, locked: true },
  { key: "short_code", labelKey: "parties.drawer.shortCode", level: "header", kind: "text" },
  { key: "legal_name", labelKey: "parties.drawer.legalName", level: "header", kind: "text" },
  { key: "email", labelKey: "common.labels.email", level: "header", kind: "text" },
  { key: "phone", labelKey: "parties.drawer.phone", level: "header", kind: "text" },
  { key: "website", labelKey: "parties.drawer.website", level: "header", kind: "text" },
  { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
  { key: "additional_subsidiaries", labelKey: "parties.drawer.additionalSubsidiaries", level: "header", kind: "multi_select" },
];

const PARTY_LIST_COLUMNS: RecordTypeMeta["listColumns"] = [
  { key: "display_name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
  { key: "short_code", labelKey: "parties.list.shortCode", kind: "text", sortable: true, sortKey: "code" },
  { key: "email", labelKey: "common.labels.email", kind: "text" },
  { key: "phone", labelKey: "parties.drawer.phone", kind: "text" },
  { key: "status", labelKey: "common.labels.status", kind: "status" },
];

const CUSTOMER_LIST_COLUMNS: RecordTypeMeta["listColumns"] = PARTY_LIST_COLUMNS.map((column) =>
  column.key === "status" ? { ...column, sortable: true, sortKey: "status" } : column,
);

const CUSTOMER_STATUS_FILTER: RecordTypeMeta["listFilters"][number] = {
  key: "status",
  labelKey: "common.labels.status",
  kind: "select",
  operators: OPERATORS_BY_KIND.select,
  options: [
    { value: "customer", labelKey: "entities.list.customerStatuses.existing" },
    { value: "prospect", labelKey: "entities.list.customerStatuses.potential" },
  ],
};

const CUSTOMER: RecordTypeMeta = {
  key: "customer",
  labelKey: "customization.recordTypes.customer",
  category: "entity",
  supportsForms: true,
  customFieldTable: "parties",
  customFieldLineTable: null,
  headerFields: [
    ...PARTY_IDENTITY_FIELDS,
    { key: "payment_terms_id", labelKey: "parties.drawer.paymentTerms", level: "header", kind: "entity_ref" },
    { key: "credit_limit", labelKey: "parties.drawer.creditLimit", level: "header", kind: "currency" },
    { key: "currency", labelKey: "common.labels.currency", level: "header", kind: "select" },
    { key: "ar_account_id", labelKey: "parties.drawer.receivableAccount", level: "header", kind: "entity_ref" },
    { key: "sales_rep_id", labelKey: "parties.drawer.salesRepresentative", level: "header", kind: "entity_ref" },
    { key: "tax_code_id", labelKey: "parties.drawer.taxCode", level: "header", kind: "entity_ref" },
    { key: "invoicing_preference", labelKey: "projects.invoicingPref.heading", level: "header", kind: "entity_ref" },
    { key: "labor_pricing", labelKey: "parties.rateBookAssignments.title", level: "header", kind: "entity_ref" },
  ],
  lineFields: [],
  listColumns: CUSTOMER_LIST_COLUMNS,
  listFilters: [CUSTOMER_STATUS_FILTER],
};

/** CRM opportunities use the universal saved-list-view renderer while their
 * rich pipeline editor remains a purpose-built drawer. */
const OPPORTUNITY: RecordTypeMeta = {
  key: "opportunity",
  labelKey: "customization.recordTypes.opportunity",
  category: "entity",
  featureKey: "crm",
  supportsForms: false,
  customFieldTable: "crm_opportunities",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "opportunity_number", labelKey: "crm.fields.number", kind: "text", sortable: true, sortKey: "number" },
    { key: "title", labelKey: "crm.fields.title", kind: "reference", sortable: true, sortKey: "title", locked: true },
    { key: "account_name", labelKey: "crm.fields.account", kind: "text", sortable: true, sortKey: "account" },
    { key: "status", labelKey: "crm.fields.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "owner_name", labelKey: "crm.fields.owner", kind: "text", sortable: true, sortKey: "owner" },
    { key: "expected_close_date", labelKey: "crm.fields.expectedClose", kind: "date", sortable: true, sortKey: "close", defaultWidth: 130 },
    { key: "projected_amount", labelKey: "crm.fields.projectedAmount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 140 },
    { key: "forecast_category", labelKey: "crm.fields.forecastCategory", kind: "text", sortable: true, sortKey: "category", defaultHidden: true },
    { key: "probability", labelKey: "crm.fields.probability", kind: "text", sortable: true, sortKey: "probability", defaultHidden: true },
    { key: "weighted_amount", labelKey: "crm.fields.weightedAmount", kind: "amount", sortable: true, sortKey: "weighted", defaultHidden: true, defaultWidth: 140 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    { key: "status_id", labelKey: "crm.fields.status", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "crm_opportunity_status" },
    { key: "owner_user_id", labelKey: "crm.fields.owner", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "user" },
    {
      key: "forecast_category",
      labelKey: "crm.fields.forecastCategory",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["omitted", "worst_case", "most_likely", "upside"].map((value) => ({
        value,
        labelKey: `crm.forecastCategories.${value}`,
      })),
    },
    { key: "party_id", labelKey: "crm.fields.account", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "expected_close_date", labelKey: "crm.fields.expectedClose", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "title", labelKey: "crm.fields.title", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

function crmAccountRecordType(key: "lead" | "prospect"): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "entity",
    featureKey: "crm",
    supportsForms: false,
    customFieldTable: "parties",
    customFieldLineTable: null,
    headerFields: [],
    lineFields: [],
    listColumns: [
      { key: "account_name", labelKey: "crm.fields.accountName", kind: "reference", sortable: true, sortKey: "name", locked: true },
      { key: "status", labelKey: "crm.fields.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
      { key: "owner_name", labelKey: "crm.fields.owner", kind: "text", sortable: true, sortKey: "owner" },
      { key: "territory_name", labelKey: "crm.fields.territory", kind: "text", sortable: true, sortKey: "territory", defaultHidden: true },
      { key: "qualification_score", labelKey: "crm.fields.qualificationScore", kind: "text", sortable: true, sortKey: "score" },
      { key: "last_activity", labelKey: "crm.fields.lastActivity", kind: "date", sortable: true, sortKey: "activity" },
      { key: "email", labelKey: "common.labels.email", kind: "text", defaultHidden: true },
      { key: "phone", labelKey: "crm.fields.phone", kind: "text", defaultHidden: true },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [
      { key: "status_id", labelKey: "crm.fields.status", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: `crm_account_status_${key}` },
      { key: "owner_user_id", labelKey: "crm.fields.owner", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "user" },
      { key: "territory_id", labelKey: "crm.fields.territory", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "crm_sales_territory" },
    ],
  };
}

const LEAD = crmAccountRecordType("lead");
const PROSPECT = crmAccountRecordType("prospect");

const ACTIVITY: RecordTypeMeta = {
  key: "activity",
  labelKey: "customization.recordTypes.activity",
  category: "entity",
  featureKey: "crm",
  supportsForms: false,
  customFieldTable: "crm_activities",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "subject", labelKey: "crm.fields.subject", kind: "reference", sortable: true, sortKey: "subject", locked: true },
    { key: "customer_name", labelKey: "crm.fields.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "kind", labelKey: "crm.fields.activityType", kind: "text", sortable: true, sortKey: "type" },
    { key: "status", labelKey: "crm.fields.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "assigned_name", labelKey: "crm.fields.assignedTo", kind: "text", sortable: true, sortKey: "owner" },
    { key: "activity_date", labelKey: "crm.fields.date", kind: "date", sortable: true, sortKey: "date", defaultWidth: 150 },
    { key: "priority", labelKey: "crm.fields.priority", kind: "text", defaultHidden: true },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "kind", labelKey: "crm.fields.activityType", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["task", "call", "event", "email", "note"].map((value) => ({ value, labelKey: `crm.activityKinds.${value}` })),
    },
    {
      key: "status", labelKey: "crm.fields.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["planned", "in_progress", "completed", "cancelled"].map((value) => ({ value, labelKey: `crm.activityStatuses.${value}` })),
    },
    { key: "assigned_user_id", labelKey: "crm.fields.assignedTo", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "user" },
    {
      key: "priority", labelKey: "crm.fields.priority", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["low", "normal", "high", "urgent"].map((value) => ({ value, labelKey: `crm.priorities.${value}` })),
    },
  ],
};

/** Catalog items keep their purpose-built pricing/costing drawer, while their
 * register participates in the universal saved-view and custom-column system. */
const ITEM: RecordTypeMeta = {
  key: "item",
  labelKey: "customization.recordTypes.item",
  category: "entity",
  supportsForms: false,
  customFieldTable: "items",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "code", labelKey: "items.labels.code", kind: "text", sortable: true, sortKey: "code" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "kind", labelKey: "items.labels.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "category", labelKey: "items.labels.category", kind: "text", sortable: true, sortKey: "category" },
    { key: "default_rate", labelKey: "items.labels.defaultRate", kind: "amount", sortable: true, sortKey: "rate", defaultWidth: 120 },
    { key: "default_cost", labelKey: "items.labels.defaultCost", kind: "amount", sortable: true, sortKey: "cost", defaultHidden: true, defaultWidth: 120 },
    { key: "unit", labelKey: "items.labels.unit", kind: "text" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 100 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "kind",
      labelKey: "items.labels.kind",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["service", "non_inventory", "inventory", "assembly", "kit", "other_charge", "equipment_charge", "labor", "absence", "discount"].map((value) => ({
        value,
        labelKey: `items.kinds.${value}`,
      })),
    },
    { key: "category", labelKey: "items.labels.category", kind: "text", operators: OPERATORS_BY_KIND.text },
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "active", labelKey: "common.status.active" },
        { value: "inactive", labelKey: "common.status.inactive" },
      ],
    },
  ],
};

const ACCOUNT_TYPE_OPTIONS = [
  ["asset_bank", "assetBank"],
  ["asset_receivable", "assetReceivable"],
  ["asset_current_other", "assetCurrentOther"],
  ["asset_fixed", "assetFixed"],
  ["asset_other", "assetOther"],
  ["liability_payable", "liabilityPayable"],
  ["liability_card", "liabilityCard"],
  ["liability_current_other", "liabilityCurrentOther"],
  ["liability_long_term", "liabilityLongTerm"],
  ["equity", "equity"],
  ["income", "income"],
  ["income_other", "incomeOther"],
  ["cogs", "cogs"],
  ["expense", "expense"],
  ["expense_other", "expenseOther"],
  ["expense_deferred", "expenseDeferred"],
] as const;

/** The chart keeps its hierarchy presentation as an alternate view, but its
 * searchable flat register uses the same saved-view contract as other data. */
const ACCOUNT: RecordTypeMeta = {
  key: "account",
  labelKey: "customization.recordTypes.account",
  category: "entity",
  supportsForms: false,
  customFieldTable: "accounts",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "number", labelKey: "common.labels.number", kind: "text", sortable: true, sortKey: "number", defaultWidth: 100 },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "type", labelKey: "common.labels.type", kind: "text", sortable: true, sortKey: "type" },
    { key: "class", labelKey: "common.labels.class", kind: "text", sortable: true, sortKey: "class", defaultHidden: true },
    { key: "parent_name", labelKey: "accounts.drawer.parent", kind: "text", sortable: true, sortKey: "parent", defaultHidden: true },
    { key: "balance", labelKey: "common.labels.balance", kind: "amount", sortable: true, sortKey: "balance", defaultWidth: 140 },
    { key: "is_summary", labelKey: "accounts.list.badges.summary", kind: "text", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 100 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "class",
      labelKey: "common.labels.class",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["asset", "liability", "equity", "income", "expense"].map((value) => ({ value, labelKey: `accounts.classes.${value}` })),
    },
    {
      key: "type",
      labelKey: "common.labels.type",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ACCOUNT_TYPE_OPTIONS.map(([value, key]) => ({ value, labelKey: `accounts.types.${key}` })),
    },
    { key: "parent_id", labelKey: "accounts.drawer.parent", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "account" },
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "active", labelKey: "common.status.active" },
        { value: "inactive", labelKey: "common.status.inactive" },
      ],
    },
  ],
};

/** Consolidated cash/card activity is a list-only record type over several
 * document kinds. Individual documents retain their kind-specific forms. */
const BANK_TRANSACTION: RecordTypeMeta = {
  key: "bank_transaction",
  labelKey: "customization.recordTypes.bank_transaction",
  category: "transaction",
  supportsForms: false,
  customFieldTable: "documents",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "transaction_kind", labelKey: "common.labels.type", kind: "text", sortable: true, sortKey: "kind" },
    { key: "account_names", labelKey: "common.labels.account", kind: "text", sortable: true, sortKey: "account" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "memo", labelKey: "common.labels.memo", kind: "text" },
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", defaultHidden: true },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "transaction_kind",
      labelKey: "common.labels.type",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["check", "deposit", "card_charge", "card_refund", "transfer"].map((value) => ({ value, labelKey: `banking.txKinds.${value}` })),
    },
    APPROVAL_STATUS_FILTER,
    { key: "bank_account_id", labelKey: "common.labels.account", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "bank_account" },
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const INVENTORY_ONHAND: RecordTypeMeta = {
  key: "inventory_onhand",
  labelKey: "customization.recordTypes.inventory_onhand",
  category: "entity",
  featureKey: "inventory",
  supportsForms: false,
  customFieldTable: "items",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "item_name", labelKey: "inventory.labels.item", kind: "reference", sortable: true, sortKey: "item", locked: true },
    { key: "location_code", labelKey: "inventory.labels.location", kind: "text", sortable: true, sortKey: "location" },
    { key: "quantity", labelKey: "inventory.labels.quantity", kind: "text", sortable: true, sortKey: "quantity" },
    { key: "average_cost", labelKey: "inventory.labels.avgCost", kind: "amount", sortable: true, sortKey: "average_cost", defaultWidth: 120 },
    { key: "value", labelKey: "inventory.labels.value", kind: "amount", sortable: true, sortKey: "value", defaultWidth: 120 },
  ],
  listFilters: [
    { key: "item_id", labelKey: "inventory.labels.item", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "item" },
    { key: "stock_location_id", labelKey: "inventory.labels.location", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "stock_location" },
  ],
};

const INVENTORY_MOVEMENT_KINDS = ["receipt", "issue", "transfer_out", "transfer_in", "adjustment", "count", "assembly_build", "assembly_consume", "return"];

const INVENTORY_MOVEMENT: RecordTypeMeta = {
  key: "inventory_movement",
  labelKey: "customization.recordTypes.inventory_movement",
  category: "entity",
  featureKey: "inventory",
  supportsForms: false,
  customFieldTable: "items",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "movement_date", labelKey: "inventory.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "kind", labelKey: "inventory.labels.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "item_name", labelKey: "inventory.labels.item", kind: "reference", sortable: true, sortKey: "item", locked: true },
    { key: "location_code", labelKey: "inventory.labels.location", kind: "text", sortable: true, sortKey: "location" },
    { key: "quantity", labelKey: "inventory.labels.quantity", kind: "text", sortable: true, sortKey: "quantity" },
    { key: "unit_cost", labelKey: "inventory.labels.unitCost", kind: "amount", sortable: true, sortKey: "unit_cost", defaultHidden: true, defaultWidth: 120 },
    { key: "total_value", labelKey: "inventory.labels.value", kind: "amount", sortable: true, sortKey: "value", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultHidden: true },
    { key: "memo", labelKey: "common.labels.memo", kind: "text", defaultHidden: true },
  ],
  listFilters: [
    {
      key: "kind", labelKey: "inventory.labels.kind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: INVENTORY_MOVEMENT_KINDS.map((value) => ({ value, labelKey: `inventory.kind.${value}` })),
    },
    { key: "item_id", labelKey: "inventory.labels.item", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "item" },
    { key: "stock_location_id", labelKey: "inventory.labels.location", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "stock_location" },
    { key: "moved_at", labelKey: "inventory.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const BUDGET_SCENARIO: RecordTypeMeta = {
  key: "budget_scenario",
  labelKey: "customization.recordTypes.budget_scenario",
  category: "entity",
  featureKey: "budgets",
  supportsForms: false,
  customFieldTable: "budget_scenarios",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "name", labelKey: "budgets.columns.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "book_name", labelKey: "budgets.columns.book", kind: "text", sortable: true, sortKey: "book" },
    { key: "fiscal_year", labelKey: "budgets.columns.fiscalYear", kind: "text", sortable: true, sortKey: "year" },
    { key: "kind", labelKey: "budgets.columns.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "status", labelKey: "budgets.columns.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "total_amount", labelKey: "budgets.columns.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 130 },
    { key: "updated", labelKey: "budgets.columns.updated", kind: "date", sortable: true, sortKey: "updated", defaultWidth: 150 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status", labelKey: "budgets.list.statusFilter", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["draft", "pending_approval", "approved", "archived"].map((value) => ({ value, labelKey: `budgets.status.${value}` })),
    },
    {
      key: "kind", labelKey: "budgets.list.kindFilter", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["budget", "forecast"].map((value) => ({ value, labelKey: `budgets.kind.${value}` })),
    },
    { key: "fiscal_year", labelKey: "budgets.list.yearFilter", kind: "select", operators: OPERATORS_BY_KIND.select },
    { key: "book_id", labelKey: "budgets.list.bookFilter", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "accounting_book" },
  ],
};

const REVENUE_CONTRACT: RecordTypeMeta = {
  key: "revenue_contract",
  labelKey: "customization.recordTypes.revenue_contract",
  category: "entity",
  featureKey: "revenueRecognition",
  supportsForms: false,
  customFieldTable: "revenue_contracts",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "contract_number", labelKey: "revenue.labels.contract", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "customer_name", labelKey: "revenue.labels.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "total_price", labelKey: "revenue.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 130 },
    { key: "recognized", labelKey: "revenue.labels.recognized", kind: "amount", sortable: true, sortKey: "recognized", defaultWidth: 130 },
    { key: "deferred", labelKey: "revenue.labels.deferred", kind: "amount", sortable: true, sortKey: "deferred", defaultWidth: 130 },
    { key: "starts_on", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "start", defaultHidden: true },
    { key: "ends_on", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "end", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["draft", "active", "complete", "cancelled"].map((value) => ({ value, labelKey: `revenue.status.${value}` })),
    },
    { key: "customer_id", labelKey: "revenue.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "starts_on", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "ends_on", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const EQUIPMENT_UNIT: RecordTypeMeta = {
  key: "equipment_unit",
  labelKey: "customization.recordTypes.equipment_unit",
  category: "entity",
  featureKey: "equipment",
  supportsForms: false,
  customFieldTable: "equipment_units",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "unit_number", labelKey: "assets.equipment.number", kind: "text", sortable: true, sortKey: "number" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "charge_item", labelKey: "assets.equipment.chargeItem", kind: "text", sortable: true, sortKey: "item" },
    { key: "serial_number", labelKey: "assets.equipment.serial", kind: "text", defaultHidden: true },
    { key: "purchase_price", labelKey: "assets.equipment.purchasePrice", kind: "amount", sortable: true, sortKey: "purchase", defaultWidth: 130 },
    { key: "recovery", labelKey: "assets.equipment.metrics.recovery", kind: "amount", sortable: true, sortKey: "recovery", defaultWidth: 130 },
    { key: "billable", labelKey: "assets.equipment.metrics.billable", kind: "amount", sortable: true, sortKey: "billable", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["draft", "active", "inactive", "retired"].map((value) => ({ value, labelKey: `assets.equipment.statuses.${value}` })),
    },
    { key: "charge_item_id", labelKey: "assets.equipment.chargeItem", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "equipment_item" },
    { key: "fixed_asset_id", labelKey: "assets.equipment.fixedAsset", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "fixed_asset" },
  ],
};

const TIMESHEET_WEEK: RecordTypeMeta = {
  key: "timesheet_week",
  labelKey: "customization.recordTypes.timesheet_week",
  category: "entity",
  featureKey: "timeTracking",
  supportsForms: false,
  // A week is an aggregate over time_entries, not a record, so it has no header
  // of its own to extend; tenant fields belong on the LINE and render as grid
  // columns in the flyout. (customFieldTable used to name 'timesheet_weeks' —
  // a table that has never existed, so those defs could never be stored.)
  customFieldTable: undefined,
  customFieldLineTable: "time_entries",
  headerFields: [],
  lineFields: [],
  // Timesheets are read newest-first; the employee directory ordering that the
  // first-sortable-column default produces buries the current week.
  defaultSort: { sortKey: "week", dir: "desc" },
  listColumns: [
    { key: "employee_name", labelKey: "common.labels.employee", kind: "reference", sortable: true, sortKey: "employee", locked: true },
    { key: "week_start", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "week" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "total_hours", labelKey: "timesheets.labels.totalHours", kind: "text", sortable: true, sortKey: "total" },
    { key: "billable_hours", labelKey: "timesheets.labels.billableHours", kind: "text", sortable: true, sortKey: "billable" },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "common.status.draft" },
        { value: "submitted", labelKey: "timesheets.status.submitted" },
        { value: "approved", labelKey: "common.status.approved" },
        { value: "rejected", labelKey: "common.status.rejected" },
      ],
    },
    { key: "employee_party_id", labelKey: "common.labels.employee", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "employee" },
  ],
};

const BANK_RECONCILIATION: RecordTypeMeta = {
  key: "bank_reconciliation",
  labelKey: "customization.recordTypes.bank_reconciliation",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [], lineFields: [],
  listColumns: [
    { key: "account_name", labelKey: "common.labels.account", kind: "reference", sortable: true, sortKey: "account", locked: true },
    { key: "through_date", labelKey: "banking.account.columns.throughDate", kind: "date", sortable: true, sortKey: "through" },
    { key: "statement_balance", labelKey: "banking.labels.statementBalance", kind: "amount", sortable: true, sortKey: "balance" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "started", labelKey: "banking.account.columns.started", kind: "date", sortable: true, sortKey: "created" },
    { key: "signed_off", labelKey: "banking.account.columns.signedOff", kind: "date", sortable: true, sortKey: "signed_off" },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["signed_off", "balanced", "in_progress"].map((value) => ({ value, labelKey: `banking.reconStatus.${value}` })),
    },
    { key: "account_id", labelKey: "common.labels.account", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "bank_account" },
    { key: "through_date", labelKey: "banking.account.columns.throughDate", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const BANK_STATEMENT: RecordTypeMeta = {
  key: "bank_statement",
  labelKey: "customization.recordTypes.bank_statement",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [], lineFields: [],
  listColumns: [
    { key: "statement_date", labelKey: "banking.labels.statementDate", kind: "reference", sortable: true, sortKey: "date", locked: true },
    { key: "account_name", labelKey: "common.labels.account", kind: "text", sortable: true, sortKey: "account" },
    { key: "source", labelKey: "banking.labels.source", kind: "status", sortable: true, sortKey: "source" },
    { key: "line_count", labelKey: "common.labels.lines", kind: "text", sortable: true, sortKey: "lines" },
    { key: "unmatched_count", labelKey: "banking.account.columns.unmatched", kind: "text", sortable: true, sortKey: "unmatched" },
    { key: "opening_balance", labelKey: "banking.account.columns.opening", kind: "amount", sortable: true, sortKey: "opening" },
    { key: "closing_balance", labelKey: "banking.account.columns.closing", kind: "amount", sortable: true, sortKey: "closing" },
    { key: "imported", labelKey: "banking.account.columns.imported", kind: "date", sortable: true, sortKey: "imported" },
  ],
  listFilters: [
    { key: "source", labelKey: "banking.labels.source", kind: "select", operators: OPERATORS_BY_KIND.select },
    { key: "account_id", labelKey: "common.labels.account", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "bank_account" },
    { key: "statement_date", labelKey: "banking.labels.statementDate", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const BANK_RULE: RecordTypeMeta = {
  key: "bank_rule",
  labelKey: "customization.recordTypes.bank_rule",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [], lineFields: [],
  listColumns: [
    { key: "priority", labelKey: "banking.rules.priority", kind: "text", sortable: true, sortKey: "priority", defaultWidth: 90 },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "criteria_summary", labelKey: "banking.rules.whenLabel", kind: "text" },
    { key: "outcome_summary", labelKey: "banking.rules.thenLabel", kind: "text" },
    { key: "status", labelKey: "common.labels.status", kind: "status" },
    { key: "created", labelKey: "common.labels.created", kind: "date", sortable: true, sortKey: "created", defaultHidden: true },
  ],
  listFilters: [
    {
      key: "is_active", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "true", labelKey: "common.labels.active" },
        { value: "false", labelKey: "banking.rules.inactive" },
      ],
    },
  ],
};

const VENDOR: RecordTypeMeta = {
  key: "vendor",
  labelKey: "customization.recordTypes.vendor",
  category: "entity",
  supportsForms: true,
  customFieldTable: "parties",
  customFieldLineTable: null,
  headerFields: [
    ...PARTY_IDENTITY_FIELDS,
    { key: "payment_method", labelKey: "parties.drawer.paymentMethod", level: "header", kind: "select" },
    { key: "eft_notification_email", labelKey: "parties.drawer.eftNotificationEmail", level: "header", kind: "text" },
    { key: "payment_terms_id", labelKey: "parties.drawer.paymentTerms", level: "header", kind: "entity_ref" },
    { key: "currency", labelKey: "common.labels.currency", level: "header", kind: "select" },
    { key: "is_1099_or_t4a", labelKey: "parties.drawer.t4aReportable", level: "header", kind: "boolean" },
    { key: "ap_account_id", labelKey: "parties.drawer.payableAccount", level: "header", kind: "entity_ref" },
    { key: "default_expense_account_id", labelKey: "parties.drawer.defaultExpenseAccount", level: "header", kind: "entity_ref" },
    { key: "tax_code_id", labelKey: "parties.drawer.taxCode", level: "header", kind: "entity_ref" },
  ],
  lineFields: [],
  listColumns: PARTY_LIST_COLUMNS,
  listFilters: [],
};

const EMPLOYEE: RecordTypeMeta = {
  key: "employee",
  labelKey: "customization.recordTypes.employee",
  category: "entity",
  supportsForms: true,
  customFieldTable: "parties",
  customFieldLineTable: null,
  headerFields: [
    ...PARTY_IDENTITY_FIELDS,
    { key: "employee_number", labelKey: "parties.drawer.employeeNumber", level: "header", kind: "text" },
    { key: "job_title", labelKey: "parties.drawer.jobTitle", level: "header", kind: "text" },
    { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "entity_ref" },
    { key: "trade_id", labelKey: "parties.drawer.trade", level: "header", kind: "entity_ref" },
    { key: "worker_comp_group_id", labelKey: "parties.drawer.workerCompGroup", level: "header", kind: "entity_ref" },
    { key: "hired_on", labelKey: "parties.drawer.hiredOn", level: "header", kind: "date" },
  ],
  lineFields: [],
  listColumns: PARTY_LIST_COLUMNS,
  listFilters: [],
};

/**
 * Projects — the first `entity` record type: a header-only configurable form
 * (no line grid) whose custom fields live in projects.custom, and whose list
 * view is customizable. `contract_value` is a header field even though it is
 * stored in custom.contractValue (the renderer/query treat it specially).
 */
const PROJECT_STATUS_OPTIONS = [
  { value: "quoted", labelKey: "projects.status.quoted" },
  { value: "awarded", labelKey: "projects.status.awarded" },
  { value: "active", labelKey: "common.status.active" },
  { value: "substantially_complete", labelKey: "projects.status.substantially_complete" },
  { value: "closed", labelKey: "common.status.closed" },
  { value: "cancelled", labelKey: "common.status.cancelled" },
];

const PROJECT: RecordTypeMeta = {
  key: "project",
  labelKey: "customization.recordTypes.project",
  category: "entity",
  featureKey: "projects",
  supportsForms: true,
  customFieldTable: "projects",
  customFieldLineTable: null,
  // The project cockpit's tabs, in default order. `overview` is locked: a
  // record has to be able to show its own fields. Project planning panels live
  // beneath one top-level Project management workspace. `schedule` remains
  // discoverable in the form designer, but the renderer only draws it when
  // Projects → Project Scheduling is on.
  tabs: [
    { key: "overview", labelKey: "projects.cockpit.tabs.overview", locked: true },
    { key: "financials", labelKey: "projects.cockpit.tabs.financials" },
    {
      key: "project_management",
      labelKey: "projects.cockpit.tabs.project_management",
      subtabs: [
        { key: "work_breakdown", labelKey: "projects.cockpit.tabs.work_breakdown" },
        { key: "schedule", labelKey: "projects.cockpit.tabs.schedule", featureKey: "projectScheduling" },
      ],
    },
    { key: "cost_time", labelKey: "projects.cockpit.tabs.cost_time" },
    { key: "billing", labelKey: "projects.cockpit.tabs.billing" },
    { key: "transactions", labelKey: "projects.cockpit.tabs.transactions" },
  ],
  headerFields: [
    { key: "name", labelKey: "common.labels.name", level: "header", kind: "text", required: true, locked: true },
    { key: "code", labelKey: "projects.labels.code", level: "header", kind: "text" },
    { key: "project_type_id", labelKey: "projects.drawer.projectType", level: "header", kind: "entity_ref" },
    { key: "customer_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref" },
    { key: "status", labelKey: "common.labels.status", level: "header", kind: "select" },
    { key: "contract_value", labelKey: "projects.labels.contractValue", level: "header", kind: "currency" },
    { key: "customer_po_number", labelKey: "projects.labels.customerPo", level: "header", kind: "text" },
    { key: "foreman_id", labelKey: "projects.labels.foreman", level: "header", kind: "entity_ref" },
    { key: "manager_id", labelKey: "projects.labels.manager", level: "header", kind: "entity_ref" },
    { key: "starts_on", labelKey: "projects.labels.startDate", level: "header", kind: "date" },
    { key: "ends_on", labelKey: "projects.labels.endDate", level: "header", kind: "date" },
    { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
    { key: "notes", labelKey: "common.labels.notes", level: "header", kind: "long_text" },
  ],
  lineFields: [],
  listColumns: [
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "code", labelKey: "projects.labels.code", kind: "text", sortable: true, sortKey: "code", defaultHidden: true },
    { key: "customer", labelKey: "common.labels.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "project_type", labelKey: "projects.drawer.projectType", kind: "text" },
    { key: "contract", labelKey: "projects.labels.contractValue", kind: "amount", sortable: true, sortKey: "contract", defaultWidth: 130 },
    { key: "actual", labelKey: "projects.labels.actualCost", kind: "amount", sortable: true, sortKey: "actual", defaultWidth: 130 },
    { key: "created", labelKey: "common.labels.created", kind: "date", sortable: true, sortKey: "created", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    { key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: PROJECT_STATUS_OPTIONS },
    {
      key: "project_type",
      labelKey: "projects.drawer.projectType",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "time_and_materials", labelKey: "projects.billing.time_and_materials" },
        { value: "fixed_price", labelKey: "projects.billing.fixed_price" },
        { value: "cost_plus", labelKey: "projects.billing.cost_plus" },
      ],
    },
    { key: "customer_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
  ],
};

/** Fixed assets use the same tenant-owned universal form renderer as other
 * entity records. Depreciation history remains a purpose-built record subtab. */
const FIXED_ASSET: RecordTypeMeta = {
  key: "fixed_asset",
  labelKey: "customization.recordTypes.fixed_asset",
  category: "entity",
  featureKey: "fixedAssets",
  supportsForms: true,
  customFieldTable: "fixed_assets",
  customFieldLineTable: null,
  headerFields: [
    { key: "name", labelKey: "common.labels.name", level: "header", kind: "text", required: true, locked: true },
    { key: "asset_number", labelKey: "assets.labels.number", level: "header", kind: "text", required: true, locked: true },
    { key: "status", labelKey: "common.labels.status", level: "header", kind: "status", locked: true },
    { key: "category_id", labelKey: "assets.labels.category", level: "header", kind: "entity_ref", required: true },
    { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref", required: true },
    { key: "serial_number", labelKey: "assets.labels.serialNumber", level: "header", kind: "text" },
    { key: "description", labelKey: "assets.labels.description", level: "header", kind: "long_text" },
    { key: "acquisition_cost", labelKey: "assets.labels.cost", level: "header", kind: "currency", required: true },
    { key: "salvage_value", labelKey: "assets.labels.salvage", level: "header", kind: "currency" },
    { key: "acquired_on", labelKey: "assets.labels.acquiredOn", level: "header", kind: "date" },
    { key: "in_service_on", labelKey: "assets.labels.inServiceOn", level: "header", kind: "date" },
    { key: "depreciation_method", labelKey: "assets.labels.method", level: "header", kind: "select" },
    { key: "useful_life_months", labelKey: "assets.labels.lifeMonths", level: "header", kind: "number" },
    { key: "depreciation_rate_percent", labelKey: "assets.labels.ratePercent", level: "header", kind: "number" },
    { key: "depreciation_units_total", labelKey: "assets.labels.unitsTotal", level: "header", kind: "number" },
    { key: "depreciation_convention", labelKey: "assets.labels.convention", level: "header", kind: "select" },
    { key: "asset_account_id", labelKey: "assets.labels.assetAccount", level: "header", kind: "entity_ref" },
    { key: "accumulated_depreciation_account_id", labelKey: "assets.labels.accumulatedAccount", level: "header", kind: "entity_ref" },
    { key: "depreciation_expense_account_id", labelKey: "assets.labels.expenseAccount", level: "header", kind: "entity_ref" },
  ],
  lineFields: [],
  listColumns: [
    { key: "asset_number", labelKey: "assets.labels.number", kind: "text", sortable: true, sortKey: "number" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "category_name", labelKey: "assets.labels.category", kind: "text", sortable: true, sortKey: "category" },
    { key: "acquisition_cost", labelKey: "assets.labels.cost", kind: "amount", sortable: true, sortKey: "cost", defaultWidth: 130 },
    { key: "accumulated", labelKey: "assets.labels.accumulated", kind: "amount", sortable: true, sortKey: "accumulated", defaultWidth: 130 },
    { key: "net_book_value", labelKey: "assets.labels.nbv", kind: "amount", sortable: true, sortKey: "nbv", defaultWidth: 130 },
    { key: "serial_number", labelKey: "assets.labels.serialNumber", kind: "text", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 130 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["draft", "in_service", "fully_depreciated", "disposed", "written_off"].map((value) => ({
        value,
        labelKey: `assets.status.${value}`,
      })),
    },
    { key: "category_id", labelKey: "assets.labels.category", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "asset_category" },
    { key: "acquired_on", labelKey: "assets.labels.acquiredOn", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "serial_number", labelKey: "assets.labels.serialNumber", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

/** Managed properties are operating assets, not parties. Their owners,
 * tenants, managers, and vendors remain party records; this form governs the
 * property master and its accounting controls. Units and leases are built-in
 * record tabs while organization-specific fields use managed_properties.custom. */
const PROPERTY: RecordTypeMeta = {
  key: "property",
  labelKey: "customization.recordTypes.property",
  category: "entity",
  featureKey: "propertyManagement",
  supportsForms: true,
  customFieldTable: "managed_properties",
  customFieldLineTable: null,
  tabs: [
    {
      key: "overview",
      labelKey: "customization.property.tabs.overview",
      locked: true,
    },
    { key: "units", labelKey: "customization.property.tabs.units" },
    { key: "leases", labelKey: "customization.property.tabs.leases" },
    { key: "rent", labelKey: "customization.property.tabs.rent" },
    { key: "deposits", labelKey: "customization.property.tabs.deposits" },
    { key: "cam", labelKey: "customization.property.tabs.cam" },
  ],
  headerFields: [
    {
      key: "name",
      labelKey: "common.labels.name",
      level: "header",
      kind: "text",
      required: true,
      locked: true,
    },
    {
      key: "code",
      labelKey: "customization.property.fields.code",
      level: "header",
      kind: "text",
      required: true,
    },
    {
      key: "property_type",
      labelKey: "customization.property.fields.propertyType",
      level: "header",
      kind: "select",
      required: true,
    },
    {
      key: "status",
      labelKey: "common.labels.status",
      level: "header",
      kind: "status",
    },
    {
      key: "subsidiary_id",
      labelKey: "common.labels.subsidiary",
      level: "header",
      kind: "entity_ref",
      required: true,
    },
    {
      key: "location_id",
      labelKey: "common.labels.location",
      level: "header",
      kind: "entity_ref",
    },
    {
      key: "fixed_asset_id",
      labelKey: "customization.property.fields.fixedAsset",
      level: "header",
      kind: "entity_ref",
    },
    {
      key: "currency",
      labelKey: "common.labels.currency",
      level: "header",
      kind: "select",
      required: true,
    },
    {
      key: "street",
      labelKey: "customization.property.fields.street",
      level: "header",
      kind: "text",
    },
    {
      key: "city",
      labelKey: "customization.property.fields.city",
      level: "header",
      kind: "text",
    },
    {
      key: "region",
      labelKey: "customization.property.fields.region",
      level: "header",
      kind: "text",
    },
    {
      key: "postal_code",
      labelKey: "customization.property.fields.postalCode",
      level: "header",
      kind: "text",
    },
    {
      key: "rent_income_account_id",
      labelKey: "customization.property.fields.rentIncomeAccount",
      level: "header",
      kind: "entity_ref",
    },
    {
      key: "cam_income_account_id",
      labelKey: "customization.property.fields.camIncomeAccount",
      level: "header",
      kind: "entity_ref",
    },
    {
      key: "deposit_liability_account_id",
      labelKey: "customization.property.fields.depositLiabilityAccount",
      level: "header",
      kind: "entity_ref",
    },
    {
      key: "default_bank_account_id",
      labelKey: "customization.property.fields.defaultBankAccount",
      level: "header",
      kind: "entity_ref",
    },
  ],
  lineFields: [],
  listColumns: [
    {
      key: "name",
      labelKey: "common.labels.name",
      kind: "reference",
      sortable: true,
      sortKey: "name",
      locked: true,
    },
    {
      key: "code",
      labelKey: "customization.property.fields.code",
      kind: "text",
      sortable: true,
      sortKey: "code",
    },
    { key: "subsidiary", labelKey: "common.labels.subsidiary", kind: "text" },
    { key: "location", labelKey: "common.labels.location", kind: "text" },
    {
      key: "property_type",
      labelKey: "customization.property.fields.propertyType",
      kind: "text",
    },
    {
      key: "occupancy",
      labelKey: "customization.property.fields.occupancy",
      kind: "text",
      defaultWidth: 110,
    },
    {
      key: "currency",
      labelKey: "common.labels.currency",
      kind: "text",
      defaultHidden: true,
      defaultWidth: 90,
    },
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "status",
      sortable: true,
      sortKey: "status",
      defaultWidth: 110,
    },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "active", labelKey: "common.status.active" },
        { value: "inactive", labelKey: "common.status.inactive" },
        { value: "sold", labelKey: "customization.property.status.sold" },
      ],
    },
    {
      key: "property_type",
      labelKey: "customization.property.fields.propertyType",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        "residential",
        "commercial",
        "mixed_use",
        "industrial",
        "other",
      ].map((value) => ({
        value,
        labelKey: `customization.property.types.${value}`,
      })),
    },
  ],
};

/** Labor Pricing rate cards use the same configurable form-layout system as
 * transaction drawers. Custom header fields persist on the effective-dated
 * version; the native item-rate table remains the editable line surface. */
const LABOR_RATE_CARD: RecordTypeMeta = {
  key: "labor_rate_card",
  labelKey: "laborPricing.recordType",
  category: "entity",
  featureKey: "projects",
  supportsForms: true,
  customFieldTable: "item_rate_versions",
  customFieldLineTable: null,
  headerFields: [
    { key: "name", labelKey: "common.labels.name", level: "header", kind: "text", required: true, locked: true },
    { key: "code", labelKey: "laborPricing.adjustmentCode", level: "header", kind: "text", required: true },
    { key: "currency", labelKey: "common.labels.currency", level: "header", kind: "select", required: true },
    { key: "effective_from", labelKey: "laborPricing.effectiveFrom", level: "header", kind: "date", required: true },
    { key: "effective_to", labelKey: "laborPricing.effectiveTo", level: "header", kind: "date" },
    { key: "status", labelKey: "common.labels.status", level: "header", kind: "select", required: true },
    { key: "derivation_policy", labelKey: "laborPricing.derivation", level: "header", kind: "select", required: true },
  ],
  lineFields: [
    { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref", required: true },
    { key: "bill_rate", labelKey: "laborPricing.regular", level: "line", kind: "currency" },
  ],
  listColumns: [],
  listFilters: [],
};


/**
 * Field ticket — the signed crew timesheet (feature-gated). Header rides the
 * standard configurable form (project drives customer/PO derivation); the crew
 * grid and item lines render in the bespoke flyout sections. Line custom
 * fields target the ticket's document_lines like any transaction.
 */
const FIELD_TICKET: RecordTypeMeta = {
  key: "field_ticket",
  labelKey: "customization.recordTypes.field_ticket",
  category: "transaction",
  featureKey: "fieldTickets",
  headerFields: [
    { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension", required: true },
    { key: "party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref" },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "period", labelKey: "fieldTickets.list.period", level: "header", kind: "select" },
    { key: "foreman_party_id", labelKey: "fieldTickets.editor.foreman", level: "header", kind: "entity_ref" },
    { key: "reference_number", labelKey: "fieldTickets.editor.po", level: "header", kind: "text" },
    { key: "memo", labelKey: "fieldTickets.editor.workDescription", level: "header", kind: "long_text" },
  ],
  lineFields: TRANSACTION_LINE_FIELDS.filter((field) =>
    ["item_id", "description", "quantity", "unit_price", "amount"].includes(field.key),
  ),
  listColumns: [
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "project_name", labelKey: "common.labels.project", kind: "text" },
    { key: "party_name", labelKey: "common.labels.customer", kind: "text", sortable: true, sortKey: "party" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "period", labelKey: "fieldTickets.list.period", kind: "text", defaultWidth: 100 },
    { key: "total", labelKey: "fieldTickets.list.itemsTotal", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 110 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 130 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "common.status.draft" },
        { value: "pending_approval", labelKey: "common.status.pending_approval" },
        { value: "approved", labelKey: "common.status.approved" },
        { value: "voided", labelKey: "common.status.voided" },
      ],
    },
    { key: "party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "project_id", labelKey: "common.labels.project", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "project" },
    DATE_FILTER,
  ],
};

/**
 * Pay runs — machine-built posting documents (kind 'pay_run'). The payroll
 * wizard is the only editing surface, so the record type is list-only:
 * saved views + custom columns ride the universal machinery, forms stay off.
 * `run_stage` merges the run lifecycle (draft/calculated/committed) with the
 * document's posted state; the list source maps it to SQL.
 */
const PAY_RUN: RecordTypeMeta = {
  key: "pay_run",
  labelKey: "customization.recordTypes.pay_run",
  category: "transaction",
  featureKey: "payroll",
  supportsForms: false,
  customFieldTable: "documents",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "document_number", labelKey: "payroll.columns.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "schedule_name", labelKey: "payroll.columns.schedule", kind: "text", sortable: true, sortKey: "schedule" },
    { key: "period", labelKey: "payroll.columns.period", kind: "text", sortable: true, sortKey: "period" },
    { key: "pay_date", labelKey: "payroll.columns.payDate", kind: "date", sortable: true, sortKey: "date", defaultWidth: 110 },
    { key: "gross_total", labelKey: "payroll.columns.gross", kind: "amount", sortable: true, sortKey: "gross", defaultWidth: 120 },
    { key: "net_total", labelKey: "payroll.columns.net", kind: "amount", sortable: true, sortKey: "net", defaultWidth: 120 },
    { key: "employee_count", labelKey: "payroll.columns.employees", kind: "text", sortable: true, sortKey: "employees", defaultWidth: 100 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "run_stage",
      labelKey: "payroll.list.stageFilter",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "payroll.status.draft" },
        { value: "calculated", labelKey: "payroll.status.calculated" },
        { value: "committed", labelKey: "payroll.status.committed" },
        { value: "posted", labelKey: "payroll.status.posted" },
      ],
    },
    { key: "pay_schedule_id", labelKey: "payroll.columns.schedule", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "pay_schedule" },
    DATE_FILTER,
  ],
};

export const RECORD_TYPES: RecordTypeMeta[] = [
  VENDOR_BILL,
  VENDOR_CREDIT,
  CUSTOMER_INVOICE,
  CUSTOMER_CREDIT,
  CARD_CHARGE,
  CARD_REFUND,
  PROJECT_CHARGE,
  CHECK,
  DEPOSIT,
  TRANSFER,
  EXPENSE_REPORT,
  JOURNAL,
  VENDOR_PAYMENT,
  CUSTOMER_PAYMENT,
  QUOTE,
  SALES_ORDER,
  PURCHASE_ORDER,
  CUSTOMER,
  OPPORTUNITY,
  LEAD,
  PROSPECT,
  ACTIVITY,
  ITEM,
  ACCOUNT,
  BANK_TRANSACTION,
  INVENTORY_ONHAND,
  INVENTORY_MOVEMENT,
  BUDGET_SCENARIO,
  REVENUE_CONTRACT,
  EQUIPMENT_UNIT,
  TIMESHEET_WEEK,
  BANK_RECONCILIATION,
  BANK_STATEMENT,
  BANK_RULE,
  VENDOR,
  EMPLOYEE,
  FIELD_TICKET,
  PAY_RUN,
  PROJECT,
  FIXED_ASSET,
  PROPERTY,
  LABOR_RATE_CARD,
];

export const RECORD_TYPE_BY_KEY: Record<string, RecordTypeMeta> = Object.fromEntries(
  RECORD_TYPES.map((r) => [r.key, r]),
);

export function getRecordType(key: string): RecordTypeMeta | undefined {
  return RECORD_TYPE_BY_KEY[key];
}

/** Item kinds that belong to the Inventory Features switch. The item catalog
 *  itself stays available; these values must not appear as list-filter options
 *  while that switch is off. */
export const ITEM_INVENTORY_KIND_VALUES = ["inventory", "assembly", "kit"] as const;

/** Apply Features-gated list-filter options. The registry stays static. */
export function recordTypeForFeatureState(
  meta: RecordTypeMeta,
  features: { inventory: boolean; crm?: boolean },
): RecordTypeMeta {
  let out = meta
  if (!features.inventory && meta.key === 'item') {
    out = {
      ...out,
      listFilters: out.listFilters.map((filter) => {
        if (filter.key !== 'kind' || !filter.options?.length) return filter
        return {
          ...filter,
          options: filter.options.filter((option) =>
            !(ITEM_INVENTORY_KIND_VALUES as readonly string[]).includes(option.value),
          ),
        }
      }),
    }
  }
  if (features.crm === false && out.key === 'customer') {
    out = {
      ...out,
      listFilters: out.listFilters.map((filter) => {
        if (filter.key !== 'status' || !filter.options?.length) return filter
        return {
          ...filter,
          options: filter.options.filter((option) => option.value === 'customer'),
        }
      }),
    }
  }
  return out
}

/** Features switch this record type follows, if any. Core types return null. */
export function recordTypeFeatureKey(recordType: string): string | null {
  return RECORD_TYPE_BY_KEY[recordType]?.featureKey ?? null;
}

/** A field key is built-in for this record type (header or line). */
export function isBuiltInField(recordType: string, key: string): boolean {
  const meta = RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return false;
  return (
    meta.headerFields.some((f) => f.key === key) ||
    meta.lineFields.some((f) => f.key === key)
  );
}

/** A list column key is built-in for this record type. */
export function isBuiltInColumn(recordType: string, key: string): boolean {
  const meta = RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return false;
  return meta.listColumns.some((c) => c.key === key);
}

/** A list filter key is built-in for this record type. */
export function isBuiltInFilter(recordType: string, key: string): boolean {
  const meta = RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return false;
  return meta.listFilters.some((f) => f.key === key);
}

export function headerFieldMeta(recordType: string, key: string) {
  return RECORD_TYPE_BY_KEY[recordType]?.headerFields.find((f) => f.key === key);
}

export function lineFieldMeta(recordType: string, key: string) {
  return RECORD_TYPE_BY_KEY[recordType]?.lineFields.find((f) => f.key === key);
}

/** Built-in field meta for a key, searching header then line fields. */
export function fieldMetaFor(recordType: string, key: string) {
  const meta = RECORD_TYPE_BY_KEY[recordType];
  if (!meta) return undefined;
  return (
    meta.headerFields.find((f) => f.key === key) ??
    meta.lineFields.find((f) => f.key === key)
  );
}

export function listColumnMeta(recordType: string, key: string): ListColumnMeta | undefined {
  return RECORD_TYPE_BY_KEY[recordType]?.listColumns.find((c) => c.key === key);
}

export function listFilterMeta(recordType: string, key: string): ListFilterMeta | undefined {
  return RECORD_TYPE_BY_KEY[recordType]?.listFilters.find((f) => f.key === key);
}

/**
 * Where a record type's custom-field definitions live. Documents-backed types
 * (transactions) key their defs by `target_kind = recordType`; entity types
 * (e.g. projects) use a null kind and their own table. Line defs only exist for
 * types with a line grid (customFieldLineTable non-null).
 */
export function customFieldTargetFor(recordType: string): {
  table: string
  kind: string | undefined
  lineTable: string | null
  lineKind: string | undefined
} {
  const meta = RECORD_TYPE_BY_KEY[recordType]
  const table = meta?.customFieldTable ?? "documents"
  const lineTable = meta && meta.customFieldLineTable !== undefined ? meta.customFieldLineTable : "document_lines"
  return {
    table,
    kind: table === "documents" ? recordType : undefined,
    lineTable,
    lineKind: lineTable === "document_lines" ? recordType : undefined,
  }
}

/** Is `key` a custom-field reference (`cf_<defKey>`)? */
export function isCustomFieldKey(key: string): boolean {
  return key.startsWith("cf_") && key.length > 3;
}

/** The custom field def key portion of a `cf_<key>` reference. */
export function customFieldDefKey(key: string): string {
  return isCustomFieldKey(key) ? key.slice(3) : key;
}
