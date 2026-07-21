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
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [DIRECT_POST_STATUS_FILTER, DATE_FILTER],
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
  supportsForms: true,
  customFieldTable: "projects",
  customFieldLineTable: null,
  headerFields: [
    { key: "name", labelKey: "common.labels.name", level: "header", kind: "text", required: true, locked: true },
    { key: "code", labelKey: "projects.labels.code", level: "header", kind: "text" },
    { key: "project_type_id", labelKey: "projects.drawer.projectType", level: "header", kind: "entity_ref" },
    { key: "customer_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref" },
    { key: "status", labelKey: "common.labels.status", level: "header", kind: "select" },
    { key: "billing_method", labelKey: "projects.labels.billingMethod", level: "header", kind: "select" },
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
    { key: "billing_method", labelKey: "projects.labels.billing", kind: "text" },
    { key: "contract", labelKey: "projects.labels.contractValue", kind: "amount", sortable: true, sortKey: "contract", defaultWidth: 130 },
    { key: "actual", labelKey: "projects.labels.actualCost", kind: "amount", sortable: true, sortKey: "actual", defaultWidth: 130 },
    { key: "created", labelKey: "common.labels.created", kind: "date", sortable: true, sortKey: "created", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    { key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: PROJECT_STATUS_OPTIONS },
    {
      key: "billing_method",
      labelKey: "projects.labels.billingMethod",
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

export const RECORD_TYPES: RecordTypeMeta[] = [
  VENDOR_BILL,
  VENDOR_CREDIT,
  CUSTOMER_INVOICE,
  CUSTOMER_CREDIT,
  CARD_CHARGE,
  CARD_REFUND,
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
  PROJECT,
];

export const RECORD_TYPE_BY_KEY: Record<string, RecordTypeMeta> = Object.fromEntries(
  RECORD_TYPES.map((r) => [r.key, r]),
);

export function getRecordType(key: string): RecordTypeMeta | undefined {
  return RECORD_TYPE_BY_KEY[key];
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
