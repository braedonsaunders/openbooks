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

/** Work dates on documents that bill work: the header records when the
 *  invoiced work was completed; the line work period is available in the
 *  form designer but off the default grid. */
const WORK_COMPLETED_HEADER: FieldMeta = { key: "work_completed_on", labelKey: "common.labels.workCompletedOn", level: "header", kind: "date" };
const WORK_PERIOD_LINE_FIELDS: FieldMeta[] = [
  { key: "work_from", labelKey: "common.labels.workFrom", level: "line", kind: "date", defaultHidden: true },
  { key: "work_to", labelKey: "common.labels.workTo", level: "line", kind: "date", defaultHidden: true },
];
const CUSTOMER_LINE_FIELDS: RecordTypeMeta["lineFields"] = [...TRANSACTION_LINE_FIELDS, ...WORK_PERIOD_LINE_FIELDS];

/** Party list columns plus the optional work-completed date for customer billing. */
function workBillingListColumns(numberLabelKey: string, partyLabelKey: string): ListColumnMeta[] {
  const columns = partyListColumns(numberLabelKey, partyLabelKey);
  columns.splice(columns.length - 1, 0, {
    key: "work_completed_on", labelKey: "common.labels.workCompletedOn", kind: "date", sortable: true, sortKey: "work_completed", defaultHidden: true,
  });
  return columns;
}

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
  lineFields: [
    ...TRANSACTION_LINE_FIELDS,
    { key: "withholding_treatment", labelKey: "documents.withholdingLine.treatment", level: "line", kind: "text" },
    { key: "withholding_materials_cost", labelKey: "documents.withholdingLine.directCost", level: "line", kind: "amount" },
  ],
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
    WORK_COMPLETED_HEADER,
    { key: "reference_number", labelKey: "ar.drawer.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
    ...INVOICE_HEADER_EXTRAS,
  ],
  lineFields: CUSTOMER_LINE_FIELDS,
  listColumns: workBillingListColumns("ar.list.columns.invoice", "common.labels.customer"),
  listFilters: [
    APPROVAL_STATUS_FILTER,
    { key: "party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "service_party_id", labelKey: "ar.list.filters.serviceParty", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const CUSTOMER_CREDIT: RecordTypeMeta = {
  key: "customer_credit",
  labelKey: "customization.recordTypes.customer_credit",
  category: "transaction",
  headerFields: CUSTOMER_INVOICE.headerFields,
  lineFields: CUSTOMER_LINE_FIELDS,
  listColumns: workBillingListColumns("common.labels.number", "common.labels.customer"),
  listFilters: CUSTOMER_INVOICE.listFilters,
};

// Paid-at-sale documents share one list (refunds filter by kind). The party
// stays optional for walk-in sales; there is no due date and no open balance.
const CASH_SALE: RecordTypeMeta = {
  key: "cash_sale",
  labelKey: "customization.recordTypes.cash_sale",
  category: "transaction",
  featureKey: "cashSales",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref", locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
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

const CASH_REFUND: RecordTypeMeta = {
  key: "cash_refund",
  labelKey: "customization.recordTypes.cash_refund",
  category: "transaction",
  featureKey: "cashSales",
  headerFields: CASH_SALE.headerFields,
  lineFields: TRANSACTION_LINE_FIELDS,
  listColumns: partyListColumns("common.labels.number", "common.labels.customer"),
  listFilters: CASH_SALE.listFilters,
};

const RETURN_AUTHORIZATION: RecordTypeMeta = {
  key: "rma",
  labelKey: "customization.recordTypes.rma",
  category: "transaction",
  featureKey: "returnAuthorizations",
  headerFields: [
    { key: "party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "common.labels.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ...COMMON_HEADER_EXTRAS,
  ],
  lineFields: ORDER_LINE_FIELDS,
  listColumns: [
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "party_name", labelKey: "common.labels.customer", kind: "text", sortable: true, sortKey: "party" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "source_document_number", labelKey: "returns.list.columns.source", kind: "text", sortable: true, sortKey: "source" },
    { key: "return_stage", labelKey: "returns.list.columns.stage", kind: "text", sortable: true, sortKey: "stage" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    APPROVAL_STATUS_FILTER,
    { key: "party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    DATE_FILTER,
  ],
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

/** Internal billing: one part of the business bills another. The header is
 * the provider ("From"); each line names its receiver ("To"). The rule fixes
 * the accounts, so lines carry no account field. */
const INTERNAL_BILLING: RecordTypeMeta = {
  key: "internal_billing",
  labelKey: "customization.recordTypes.internal_billing",
  category: "transaction",
  featureKey: "internalBilling",
  defaultSort: { sortKey: "date", dir: "desc" },
  headerFields: [
    { key: "internal_billing_rule_id", labelKey: "internalBilling.fields.rule", level: "header", kind: "entity_ref", required: true, locked: true },
    { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
    { key: "subsidiary_id", labelKey: "common.labels.subsidiary", level: "header", kind: "entity_ref" },
    { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "dimension" },
    { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension" },
    { key: "reference_number", labelKey: "common.labels.reference", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
  ],
  lineFields: [
    { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref" },
    { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
    { key: "quantity", labelKey: "common.labels.quantity", level: "line", kind: "number" },
    { key: "unit_price", labelKey: "internalBilling.fields.rate", level: "line", kind: "currency" },
    { key: "amount", labelKey: "common.labels.amount", level: "line", kind: "amount", required: true },
    { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
    { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
    { key: "is_billable", labelKey: "internalBilling.fields.billable", level: "line", kind: "boolean" },
  ],
  listColumns: [
    { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "rule_name", labelKey: "internalBilling.fields.rule", kind: "text" },
    { key: "provider_name", labelKey: "internalBilling.fields.from", kind: "text" },
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    APPROVAL_STATUS_FILTER,
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

const CHECK: RecordTypeMeta = {
  key: "check",
  labelKey: "customization.recordTypes.check",
  category: "transaction",
  headerFields: [
    // Optional payee: a check can settle a vendor's AP open items (the engine
    // reads doc.partyId) or disburse anonymously, so — unlike a bill — the
    // party is neither required nor locked. JOURNAL sets the optional-party
    // precedent.
    { key: "party_id", labelKey: "common.labels.vendor", level: "header", kind: "entity_ref" },
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
  defaultSort: { sortKey: "date", dir: "desc" },
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
        // Standalone migration true-ups remain visible in the journal list.
        ["migration", "migration"],
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

const JOURNAL_DRAFT: RecordTypeMeta = {
  ...JOURNAL,
  key: "journal_draft",
  supportsForms: false,
  listColumns: JOURNAL.listColumns.filter((column) => column.key !== "origin" && column.key !== "line_count"),
  listFilters: JOURNAL.listFilters.filter((filter) => filter.key === "posting_date"),
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
function orderRecordType(
  key: string,
  partyLabelKey: string,
  entitySource: string,
  extras: { header?: FieldMeta[]; lines?: FieldMeta[] } = {},
): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    featureKey: "orders",
    headerFields: [
      { key: "party_id", labelKey: partyLabelKey, level: "header", kind: "entity_ref", required: true, locked: true },
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      { key: "due_date", labelKey: "common.labels.dueDate", level: "header", kind: "date" },
      ...(extras.header ?? []),
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
      { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "dimension" },
      { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension" },
    ],
    lineFields: [...ORDER_LINE_FIELDS, ...(extras.lines ?? [])],
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
const SALES_ORDER = orderRecordType("sales_order", "common.labels.customer", "customer", {
  header: [{ ...WORK_COMPLETED_HEADER, defaultHidden: true }],
  lines: WORK_PERIOD_LINE_FIELDS,
});
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

/**
 * The customer list is the ONE account surface: with CRM on it spans the whole
 * relationship lifecycle (lead → prospect → customer), so the built-in `status`
 * column carries the lifecycle STAGE and the CRM columns below carry the
 * configured sub-status and the routing/qualification fields the retired
 * /crm/leads and /crm/prospects lists used to own. CRM off strips all of them
 * back off in recordTypeForFeatureState — every row is simply a customer.
 */
const CUSTOMER_CRM_COLUMN_KEYS = [
  "crm_status",
  "owner_name",
  "territory_name",
  "qualification_score",
  "last_activity",
] as const;

const CUSTOMER_CRM_FILTER_KEYS = ["status_id", "owner_user_id", "territory_id"] as const;

/**
 * HR-2b employee directory columns and filters. The keys mirror
 * web/lib/customization/entity-list-query/employment-directory.ts
 * (EMPLOYEE_HRM_COLUMN_KEYS / EMPLOYEE_HRM_FILTER_KEYS) — a new directory
 * key must be added in both places, with its SQL in employeeBuiltInExpr.
 */
const EMPLOYEE_HRM_COLUMN_KEYS = [
  "department",
  "job_title",
  "employment_status",
  "employer",
  "service_start",
] as const;

const EMPLOYEE_HRM_FILTER_KEYS = ["department", "employment_status", "employer"] as const;

const EMPLOYEE_HRM_COLUMNS: RecordTypeMeta["listColumns"] = [
  { key: "department", labelKey: "common.labels.department", kind: "text", sortable: true, sortKey: "department", defaultWidth: 150 },
  { key: "job_title", labelKey: "parties.drawer.jobTitle", kind: "text", sortable: true, sortKey: "job_title", defaultWidth: 170 },
  { key: "employment_status", labelKey: "hrm.directory.employmentStatus", kind: "status", sortable: true, sortKey: "employment_status", defaultWidth: 120 },
  { key: "employer", labelKey: "hrm.home.groups.employer", kind: "text", sortable: true, sortKey: "employer", defaultWidth: 150, legalEntity: true },
  { key: "service_start", labelKey: "hrm.directory.serviceStart", kind: "date", sortable: true, sortKey: "service_start", defaultWidth: 110 },
];

const CUSTOMER_LIST_COLUMNS: RecordTypeMeta["listColumns"] = [
  ...PARTY_LIST_COLUMNS.map((column) =>
    column.key === "status"
      ? { ...column, labelKey: "crm.fields.stage", sortable: true, sortKey: "status" }
      : column,
  ),
  { key: "crm_status", labelKey: "crm.fields.status", kind: "text", sortable: true, sortKey: "crm_status", defaultWidth: 130 },
  { key: "owner_name", labelKey: "crm.fields.owner", kind: "text", sortable: true, sortKey: "owner" },
  { key: "territory_name", labelKey: "crm.fields.territory", kind: "text", sortable: true, sortKey: "territory", defaultHidden: true },
  { key: "qualification_score", labelKey: "crm.fields.qualificationScore", kind: "text", sortable: true, sortKey: "score", defaultHidden: true },
  { key: "last_activity", labelKey: "crm.fields.lastActivity", kind: "date", sortable: true, sortKey: "activity", defaultHidden: true },
];

/**
 * Lifecycle STAGE, the one field that decides what an account is. The old
 * "existing / potential customer" pair read the same
 * `crm_account_profiles.lifecycle_stage` but could only ever show a DEMOTED
 * customer as potential, because real prospects had no customer role and so
 * never reached this list at all.
 */
const CUSTOMER_STATUS_FILTER: RecordTypeMeta["listFilters"][number] = {
  key: "status",
  labelKey: "crm.fields.lifecycleStage",
  kind: "select",
  operators: OPERATORS_BY_KIND.select,
  options: [
    { value: "customer", labelKey: "crm.stages.customer" },
    { value: "prospect", labelKey: "crm.stages.prospect" },
    { value: "lead", labelKey: "crm.stages.lead" },
  ],
};

/** CRM-off restores the plain party wording for the one remaining bucket. */
const CUSTOMER_STATUS_LABEL_KEY = "common.labels.status";

const CUSTOMER_CRM_FILTERS: RecordTypeMeta["listFilters"] = [
  { key: "status_id", labelKey: "crm.fields.status", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "crm_account_status" },
  { key: "owner_user_id", labelKey: "crm.fields.owner", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "user" },
  { key: "territory_id", labelKey: "crm.fields.territory", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "crm_sales_territory" },
];

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
  listFilters: [CUSTOMER_STATUS_FILTER, ...CUSTOMER_CRM_FILTERS],
  defaultSort: { sortKey: "name", dir: "asc" },
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

/**
 * Catalog items keep purpose-built pricing/costing panels inside the drawer,
 * but the record shell is still a tenant-owned form: built-in fields, custom
 * fields, tab order/visibility, labels and widths all resolve through the same
 * form-layout contract as projects and transactions.
 */
const ITEM: RecordTypeMeta = {
  key: "item",
  labelKey: "customization.recordTypes.item",
  category: "entity",
  supportsForms: true,
  customFieldTable: "items",
  customFieldLineTable: null,
  tabs: [
    { key: "overview", labelKey: "items.drawer.tabs.overview", locked: true },
    { key: "pricing", labelKey: "items.drawer.tabs.pricing" },
    { key: "accounting", labelKey: "items.drawer.tabs.accounting" },
    { key: "costing", labelKey: "items.drawer.tabs.costing", featureKey: "inventory" },
    { key: "revenue", labelKey: "items.drawer.tabs.revenue", featureKey: "revenueRecognition" },
    { key: "shipping", labelKey: "items.drawer.tabs.shipping", featureKey: "shippingHub" },
  ],
  headerFields: [
    { key: "kind", labelKey: "items.labels.kind", level: "header", kind: "select", required: true, locked: true },
    { key: "name", labelKey: "common.labels.name", level: "header", kind: "text", required: true, locked: true },
    { key: "code", labelKey: "items.labels.code", level: "header", kind: "text" },
    { key: "category", labelKey: "items.labels.category", level: "header", kind: "text" },
    { key: "unit", labelKey: "items.labels.unit", level: "header", kind: "text" },
    { key: "description", labelKey: "common.labels.description", level: "header", kind: "long_text" },
    { key: "default_rate", labelKey: "items.labels.defaultRate", level: "header", kind: "currency" },
    { key: "default_cost", labelKey: "items.labels.defaultCost", level: "header", kind: "currency" },
    { key: "income_account_id", labelKey: "items.labels.incomeAccount", level: "header", kind: "entity_ref" },
    { key: "expense_account_id", labelKey: "items.labels.expenseAccount", level: "header", kind: "entity_ref" },
    { key: "payroll_expense_account_id", labelKey: "items.labels.payrollCostingAccount", level: "header", kind: "entity_ref" },
    { key: "cost_recovery_account_id", labelKey: "items.labels.recoveryAccount", level: "header", kind: "entity_ref" },
    { key: "tax_code_id", labelKey: "items.labels.taxCode", level: "header", kind: "entity_ref" },
    { key: "show_on_timesheet", labelKey: "items.drawer.showOnTimesheet", level: "header", kind: "boolean" },
    { key: "recognition_rule_id", labelKey: "items.revrec.rule", level: "header", kind: "entity_ref" },
    { key: "deferred_account_id", labelKey: "items.revrec.deferredAccount", level: "header", kind: "entity_ref" },
    { key: "standalone_selling_price", labelKey: "items.revrec.standaloneSellingPrice", level: "header", kind: "currency" },
    { key: "create_plans_on", labelKey: "items.revrec.createPlansOn", level: "header", kind: "select" },
    { key: "revenue_allocation", labelKey: "items.revrec.allocation", level: "header", kind: "select" },
    { key: "weight", labelKey: "items.labels.weight", level: "header", kind: "text" },
    { key: "weight_unit", labelKey: "items.labels.weightUnit", level: "header", kind: "text" },
    { key: "dimensions", labelKey: "items.labels.dimensions", level: "header", kind: "text" },
    { key: "hs_code", labelKey: "items.labels.hsCode", level: "header", kind: "text" },
    { key: "country_of_origin", labelKey: "items.labels.countryOfOrigin", level: "header", kind: "text" },
  ],
  lineFields: [],
  listColumns: [
    { key: "code", labelKey: "items.labels.code", kind: "text", sortable: true, sortKey: "code" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "kind", labelKey: "items.labels.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "category", labelKey: "items.labels.category", kind: "text", sortable: true, sortKey: "category" },
    { key: "default_rate", labelKey: "items.labels.defaultRate", kind: "amount", sortable: true, sortKey: "rate", defaultWidth: 120 },
    { key: "default_cost", labelKey: "items.labels.defaultCost", kind: "amount", sortable: true, sortKey: "cost", defaultHidden: true, defaultWidth: 120 },
    { key: "unit", labelKey: "items.labels.unit", kind: "text" },
    { key: "family", labelKey: "items.labels.family", kind: "text", sortable: true, sortKey: "family", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 100 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "kind",
      labelKey: "items.labels.kind",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["service", "non_inventory", "inventory", "assembly", "kit", "other_charge", "equipment_charge", "labor", "absence", "discount", "gift_card"].map((value) => ({
        value,
        labelKey: `items.kinds.${value}`,
      })),
    },
    { key: "family", labelKey: "items.labels.family", kind: "text", operators: OPERATORS_BY_KIND.text },
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

/**
 * Product families group variant items sold in options. The list is a plain
 * entity list; the drawer owns the options editor and variant grid.
 */
const ITEM_FAMILY: RecordTypeMeta = {
  key: "item_family",
  labelKey: "customization.recordTypes.item_family",
  category: "entity",
  featureKey: "itemVariants",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  defaultSort: { sortKey: "name", dir: "asc" },
  listColumns: [
    { key: "code", labelKey: "items.families.code", kind: "text", sortable: true, sortKey: "code" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "category", labelKey: "items.labels.category", kind: "text", sortable: true, sortKey: "category" },
    { key: "kind", labelKey: "items.labels.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "default_rate", labelKey: "items.labels.defaultRate", kind: "amount", sortable: true, sortKey: "rate", defaultWidth: 120 },
    { key: "default_unit", labelKey: "items.labels.unit", kind: "text", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 100 },
  ],
  listFilters: [
    {
      key: "kind",
      labelKey: "items.labels.kind",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: ["inventory", "non_inventory", "service", "kit", "assembly"].map((value) => ({
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

const WEBHOOK_ENDPOINT: RecordTypeMeta = {
  key: "webhook_endpoint",
  labelKey: "customization.recordTypes.webhook_endpoint",
  category: "entity",
  featureKey: "outboundWebhooks",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "key", labelKey: "admin.webhooks.columns.key", kind: "reference", sortable: true, sortKey: "key", locked: true },
    { key: "url", labelKey: "admin.webhooks.columns.url", kind: "text", sortable: true, sortKey: "key" },
    { key: "events_count", labelKey: "admin.webhooks.columns.events", kind: "text", sortable: false },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "consecutive_failures", labelKey: "admin.webhooks.columns.failures", kind: "text", sortable: true, sortKey: "failures" },
    { key: "last_delivery_at", labelKey: "admin.webhooks.columns.lastDelivery", kind: "text", sortable: true, sortKey: "last_delivery" },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "active", labelKey: "common.status.active" },
        { value: "disabled", labelKey: "common.status.disabled" },
      ],
    },
  ],
};

const CHANNEL_ORDER_STATUSES = ["pending", "posted", "summarized", "exception", "excluded"];
const CHANNEL_EXCEPTION_CODES = [
  "unmapped_item",
  "unmapped_location",
  "unmapped_account",
  "closed_period",
  "tax_mismatch",
  "currency_unsupported",
  "over_refund",
  "refund_unposted_order",
  "unmapped_fulfilment_location",
  "insufficient_stock",
  "cancellation_blocked",
];

const CHANNEL_ORDER: RecordTypeMeta = {
  key: "channel_order",
  labelKey: "customization.recordTypes.channel_order",
  category: "entity",
  featureKey: "salesChannels",
  supportsForms: false,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "number", labelKey: "channels.columns.number", kind: "text", sortable: true, sortKey: "number", locked: true },
    { key: "channel", labelKey: "channels.columns.channel", kind: "text", sortable: true, sortKey: "channel" },
    { key: "ordered", labelKey: "channels.columns.ordered", kind: "date", sortable: true, sortKey: "ordered" },
    { key: "customer", labelKey: "channels.columns.customer", kind: "text", sortable: false },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "document_number", labelKey: "channels.columns.document", kind: "text", sortable: false },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
  ],
  listFilters: [
    {
      key: "status",
      labelKey: "common.labels.status",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: CHANNEL_ORDER_STATUSES.map((value) => ({ value, labelKey: `channels.orderStatus.${value}` })),
    },
  ],
};

const CHANNEL_EXCEPTION: RecordTypeMeta = {
  key: "channel_exception",
  labelKey: "customization.recordTypes.channel_exception",
  category: "entity",
  featureKey: "salesChannels",
  supportsForms: false,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "number", labelKey: "channels.columns.number", kind: "text", sortable: true, sortKey: "number", locked: true },
    { key: "channel", labelKey: "channels.columns.channel", kind: "text", sortable: true, sortKey: "channel" },
    { key: "code", labelKey: "channels.columns.code", kind: "status", sortable: true, sortKey: "status" },
    { key: "reason", labelKey: "channels.columns.reason", kind: "text", sortable: false },
    { key: "remedy", labelKey: "channels.columns.remedy", kind: "text", sortable: false },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
    { key: "ordered", labelKey: "channels.columns.ordered", kind: "date", sortable: true, sortKey: "ordered" },
  ],
  listFilters: [
    {
      key: "code",
      labelKey: "channels.columns.code",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: CHANNEL_EXCEPTION_CODES.map((value) => ({ value, labelKey: `channels.exceptionCodes.${value}` })),
    },
  ],
};

const CHANNEL_EVENT_EXCEPTION: RecordTypeMeta = {
  key: "channel_event_exception",
  labelKey: "customization.recordTypes.channel_event_exception",
  category: "entity",
  featureKey: "salesChannels",
  supportsForms: false,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "number", labelKey: "channels.columns.number", kind: "text", sortable: true, sortKey: "number", locked: true },
    { key: "channel", labelKey: "channels.columns.channel", kind: "text", sortable: true, sortKey: "channel" },
    { key: "event", labelKey: "channels.columns.event", kind: "status", sortable: true, sortKey: "event" },
    { key: "code", labelKey: "channels.columns.code", kind: "status", sortable: true, sortKey: "status" },
    { key: "reason", labelKey: "channels.columns.reason", kind: "text", sortable: false },
    { key: "remedy", labelKey: "channels.columns.remedy", kind: "text", sortable: false },
    { key: "occurred", labelKey: "channels.columns.occurred", kind: "date", sortable: true, sortKey: "occurred" },
  ],
  listFilters: [
    {
      key: "code",
      labelKey: "channels.columns.code",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: CHANNEL_EXCEPTION_CODES.map((value) => ({ value, labelKey: `channels.exceptionCodes.${value}` })),
    },
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

const INVENTORY_MOVEMENT_KINDS = ["receipt", "issue", "transfer_out", "transfer_in", "adjustment", "count", "assembly_build", "assembly_consume", "assembly_disassembly", "assembly_recovery", "return"];

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

const DEMAND_SUGGESTION: RecordTypeMeta = {
  key: "demand_suggestion",
  labelKey: "customization.recordTypes.demand_suggestion",
  category: "entity",
  featureKey: "demandPlanning",
  supportsForms: false,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "item_name", labelKey: "planning.columns.item", kind: "reference", sortable: true, sortKey: "item", locked: true },
    { key: "location_code", labelKey: "planning.columns.location", kind: "text", sortable: true, sortKey: "location" },
    { key: "subsidiary_name", labelKey: "common.labels.subsidiary", kind: "text", sortable: true, sortKey: "subsidiary" },
    { key: "action", labelKey: "planning.columns.action", kind: "status", sortable: true, sortKey: "action" },
    { key: "quantity", labelKey: "planning.columns.quantity", kind: "text", sortable: true, sortKey: "quantity" },
    { key: "supplier_name", labelKey: "planning.columns.supplier", kind: "text", sortable: true, sortKey: "supplier" },
    { key: "due_date", labelKey: "planning.columns.due", kind: "date", sortable: true, sortKey: "due" },
    { key: "days_of_cover", labelKey: "planning.columns.cover", kind: "text", sortable: true, sortKey: "cover" },
    { key: "trend", labelKey: "planning.columns.trend", kind: "text", sortable: false },
    { key: "status", labelKey: "planning.columns.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "forecast_qty", labelKey: "planning.columns.forecast", kind: "text", sortable: false, defaultHidden: true },
    { key: "projected_supply", labelKey: "planning.columns.supply", kind: "text", sortable: false, defaultHidden: true },
  ],
  listFilters: [
    {
      key: "status", labelKey: "planning.columns.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["suggested", "confirmed", "converted", "dismissed"].map((value) => ({ value, labelKey: `planning.status.${value}` })),
    },
    {
      key: "action", labelKey: "planning.columns.action", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["buy", "transfer"].map((value) => ({ value, labelKey: `planning.actions.${value}` })),
    },
    { key: "item_id", labelKey: "planning.columns.item", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "item" },
    { key: "stock_location_id", labelKey: "planning.columns.location", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "stock_location" },
  ],
};

const BUDGET_SCENARIO: RecordTypeMeta = {
  key: "budget_scenario",
  labelKey: "customization.recordTypes.budget_scenario",
  category: "entity",
  featureKey: "budgets",
  supportsForms: false,
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

const PROVISION_OBLIGATION: RecordTypeMeta = {
  key: "provision_obligation", labelKey: "accounting.provisions.title", category: "entity",
  supportsForms: false, customFieldLineTable: null, headerFields: [], lineFields: [],
  defaultSort: { sortKey: "name", dir: "asc" },
  listColumns: [
    { key: "name", labelKey: "accounting.provisions.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "subsidiary", labelKey: "accounting.provisions.subsidiary", kind: "text", sortable: true, sortKey: "subsidiary", legalEntity: true },
    { key: "book", labelKey: "accounting.provisions.book", kind: "text", sortable: true, sortKey: "book" },
    { key: "currency", labelKey: "common.labels.currency", kind: "text" },
    { key: "balance", labelKey: "accounting.provisions.liability", kind: "amount", sortable: true, sortKey: "balance" },
    { key: "reviewed_on", labelKey: "accounting.provisions.reviewedOn", kind: "date", sortable: true, sortKey: "reviewed_on" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
  ],
  listFilters: [{ key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
    options: ["unassessed", "recognized", "contingent"].map(value => ({ value, labelKey: `accounting.provisions.${value}` })) }],
};

const HRM_PROCESS_TEMPLATE: RecordTypeMeta = {
  key: "hrm_process_template", labelKey: "hrm.processes.templates.title", category: "entity",
  featureKey: "hrm", supportsForms: false, customFieldLineTable: null,
  headerFields: [], lineFields: [], defaultSort: { sortKey: "name", dir: "asc" },
  listColumns: [
    { key: "name", labelKey: "hrm.processes.templates.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "kind", labelKey: "hrm.processes.templates.kind", kind: "text", sortable: true, sortKey: "kind" },
    { key: "scope", labelKey: "hrm.processes.templates.scope", kind: "text" },
    { key: "step_count", labelKey: "hrm.processes.templates.steps", kind: "text", sortable: true, sortKey: "steps" },
    { key: "status", labelKey: "hrm.processes.templates.status", kind: "status", sortable: true, sortKey: "status" },
  ],
  listFilters: [
    { key: "kind", labelKey: "hrm.processes.templates.kind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["onboarding", "offboarding", "transfer"].map((value) => ({ value, labelKey: `hrm.processes.templates.kinds.${value}` })) },
    { key: "status", labelKey: "hrm.processes.templates.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["draft", "changes_pending", "active", "retired"].map((value) => ({ value, labelKey: `hrm.processes.templates.statuses.${value}` })) },
  ],
};

const LEASE_AGREEMENT: RecordTypeMeta = {
  key: "lease_agreement", labelKey: "accounting.lifecycle.lease_agreement", category: "entity",
  featureKey: "fixedAssets", supportsForms: false, customFieldLineTable: null,
  headerFields: [], lineFields: [],
  listColumns: [
    {key:"lease_number",labelKey:"accounting.lifecycle.number",kind:"reference",sortable:true,sortKey:"number",locked:true},
    {key:"description",labelKey:"accounting.lifecycle.description",kind:"text",sortable:true,sortKey:"description"},
    {key:"commencement_on",labelKey:"accounting.lifecycle.date",kind:"date",sortable:true,sortKey:"date"},
    {key:"payment_amount",labelKey:"accounting.lifecycle.payment",kind:"amount",sortable:true,sortKey:"payment"},
    {key:"status",labelKey:"accounting.lifecycle.status",kind:"status",sortable:true,sortKey:"status"},
    {key:"_actions",labelKey:"common.labels.actions",kind:"actions",defaultWidth:44},
  ],
  listFilters: [{key:"status",labelKey:"common.labels.status",kind:"select",operators:OPERATORS_BY_KIND.select,
    options: ["draft","active","terminated","complete"].map(value=>({value,labelKey:`accounting.lifecycle.${value}`}))}],
};

const FINANCIAL_CHANGE_OPERATIONS = ["net_investment_oci","net_investment_oci_reversal","drop_ship_control_assessment",
  "modification",
  "remeasurement",
  "termination",
  "separate_lease",
  "contract_modification",
  "partial_disposal",
  "intercompany_transfer",
  "group_valuation",
  "loss_of_control",
  "reversal",
] as const;

const FINANCIAL_CHANGE: RecordTypeMeta = {
  key: "financial_change", labelKey: "accounting.lifecycle.financial_change", category: "entity",
  supportsForms: false, customFieldLineTable: null,
  headerFields: [], lineFields: [],
  defaultSort: { sortKey: "date", dir: "desc" },
  listColumns: [
    {key:"operation",labelKey:"accounting.lifecycle.operation",kind:"reference",sortable:true,sortKey:"operation",locked:true},
    {key:"subject",labelKey:"accounting.lifecycle.subject",kind:"text",sortable:true,sortKey:"subject"},
    {key:"domain",labelKey:"accounting.lifecycle.domain",kind:"text",sortable:true,sortKey:"domain"},
    {key:"subsidiary",labelKey:"accounting.lifecycle.legalEntity",kind:"text",sortable:true,sortKey:"subsidiary",legalEntity:true},
    {key:"reason",labelKey:"accounting.lifecycle.reason",kind:"text",sortable:true,sortKey:"reason",defaultHidden:true},
    {key:"effective_on",labelKey:"accounting.lifecycle.date",kind:"date",sortable:true,sortKey:"date"},
    {key:"status",labelKey:"accounting.lifecycle.status",kind:"status",sortable:true,sortKey:"status"},
    {key:"_actions",labelKey:"common.labels.actions",kind:"actions",defaultWidth:44},
  ],
  listFilters: [
    {key:"queue",labelKey:"accounting.lifecycle.queue",kind:"select",operators:OPERATORS_BY_KIND.select,
      options: [
        {value:"awaiting",labelKey:"accounting.lifecycle.queueAwaiting"},
        {value:"applied",labelKey:"accounting.lifecycle.queueApplied"},
      ]},
    {key:"domain",labelKey:"accounting.lifecycle.domain",kind:"select",operators:OPERATORS_BY_KIND.select,
      options: ["lease","asset","revenue","consolidation","provision","sales"].map(value=>({value,labelKey:`accounting.lifecycle.domains.${value}`}))},
    {key:"operation",labelKey:"accounting.lifecycle.operation",kind:"select",operators:OPERATORS_BY_KIND.select,
      options: FINANCIAL_CHANGE_OPERATIONS.map(value=>({value,labelKey:`accounting.lifecycle.operations.${value}`}))},
    {key:"status",labelKey:"common.labels.status",kind:"select",operators:OPERATORS_BY_KIND.select,
      options: ["draft","pending","approved","rejected","applied"].map(value=>({value,labelKey:`accounting.lifecycle.${value}`}))},
  ],
};

const REVENUE_CONTRACT: RecordTypeMeta = {
  key: "revenue_contract",
  labelKey: "customization.recordTypes.revenue_contract",
  category: "entity",
  featureKey: "revenueRecognition",
  supportsForms: false,
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
    {
      key: "scope", labelKey: "revenue.labels.scope", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["invoice", "order", "subscription"].map((value) => ({ value, labelKey: `revenue.scope.${value}` })),
    },
    { key: "customer_id", labelKey: "revenue.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "starts_on", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "ends_on", labelKey: "common.labels.date", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const CONTRACT_COST_ASSET: RecordTypeMeta = {
  key: "contract_cost_asset",
  labelKey: "customization.recordTypes.contract_cost_asset",
  category: "entity",
  featureKey: "contractCosts",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "contract_number", labelKey: "contractCosts.labels.contract", kind: "reference", sortable: true, sortKey: "contract", locked: true },
    { key: "customer_name", labelKey: "contractCosts.labels.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "sales_rep", labelKey: "contractCosts.labels.salesRep", kind: "text", sortable: true, sortKey: "rep" },
    { key: "cost_type", labelKey: "contractCosts.labels.costType", kind: "text", sortable: true, sortKey: "type" },
    { key: "amount", labelKey: "contractCosts.labels.capitalized", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "carrying", labelKey: "contractCosts.labels.carrying", kind: "amount", sortable: true, sortKey: "carrying", defaultWidth: 130 },
    { key: "capitalized_on", labelKey: "contractCosts.labels.capitalizedOn", kind: "date", sortable: true, sortKey: "capitalized", defaultHidden: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["active", "fully_amortized", "impaired", "expensed"].map((value) => ({ value, labelKey: `contractCosts.status.${value}` })),
    },
    {
      key: "cost_type", labelKey: "contractCosts.labels.costType", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["commission", "fulfilment"].map((value) => ({ value, labelKey: `contractCosts.costType.${value}` })),
    },
  ],
};

const STORED_VALUE_ACCOUNT: RecordTypeMeta = {
  key: "stored_value_account",
  labelKey: "customization.recordTypes.stored_value_account",
  category: "entity",
  featureKey: "storedValue",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "code", labelKey: "storedValue.labels.code", kind: "text", sortable: true, sortKey: "code", locked: true },
    { key: "kind", labelKey: "storedValue.labels.kind", kind: "text", sortable: true, sortKey: "kind" },
    { key: "customer_name", labelKey: "storedValue.labels.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "program_name", labelKey: "storedValue.labels.program", kind: "text", sortable: true, sortKey: "program" },
    { key: "balance", labelKey: "storedValue.labels.balance", kind: "amount", sortable: true, sortKey: "balance", defaultWidth: 130 },
    { key: "issued", labelKey: "storedValue.labels.issued", kind: "amount", sortable: true, sortKey: "issued", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "expires_on", labelKey: "storedValue.labels.expires", kind: "date", sortable: true, sortKey: "expires", defaultHidden: true },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["active", "frozen", "closed", "expired"].map((value) => ({ value, labelKey: `storedValue.status.${value}` })),
    },
    {
      key: "kind", labelKey: "storedValue.labels.kind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["gift_card", "store_credit"].map((value) => ({ value, labelKey: `storedValue.kind.${value}` })),
    },
    { key: "expires_on", labelKey: "storedValue.labels.expires", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const EQUIPMENT_UNIT: RecordTypeMeta = {
  key: "equipment_unit",
  labelKey: "customization.recordTypes.equipment_unit",
  category: "entity",
  featureKey: "equipment",
  supportsForms: false,
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

const RESOURCING_ASSIGNMENT: RecordTypeMeta = {
  key: "resourcing_assignment",
  labelKey: "customization.recordTypes.resourcing_assignment",
  category: "entity",
  featureKey: "resourcing",
  supportsForms: false,
  customFieldTable: "res_assignments",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "project_id", labelKey: "common.labels.project", kind: "reference", sortable: true, sortKey: "project", locked: true },
    { key: "employee_party_id", labelKey: "common.labels.employee", kind: "reference", sortable: true, sortKey: "employee" },
    { key: "job_title", labelKey: "common.labels.role", kind: "text", sortable: true, sortKey: "role" },
    { key: "week_start", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "week" },
    { key: "planned_hours", labelKey: "timesheets.labels.totalHours", kind: "amount", sortable: true, sortKey: "hours" },
    { key: "booking", labelKey: "customization.resourcing.fields.booking", kind: "status", sortable: true, sortKey: "booking" },
    { key: "state", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "state" },
    { key: "is_billable", labelKey: "timesheets.labels.billable", kind: "text" },
  ],
  listFilters: [
    { key: "state", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "active", labelKey: "common.status.active" },
        { value: "released", labelKey: "customization.resourcing.status.released" },
      ] },
    { key: "booking", labelKey: "customization.resourcing.fields.booking", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["hard", "soft"].map((value) => ({ value, labelKey: `customization.resourcing.booking.${value}` })) },
    { key: "project_id", labelKey: "common.labels.project", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "project" },
    { key: "employee_party_id", labelKey: "common.labels.employee", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "employee" },
    { key: "week_start", labelKey: "timesheets.list.week", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const RESOURCING_REQUEST: RecordTypeMeta = {
  key: "resourcing_request",
  labelKey: "customization.recordTypes.resourcing_request",
  category: "entity",
  featureKey: "resourceRequests",
  supportsForms: true,
  customFieldTable: "res_requests",
  customFieldLineTable: null,
  headerFields: [
    { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "entity_ref", required: true },
    { key: "employee_party_id", labelKey: "common.labels.employee", level: "header", kind: "entity_ref" },
    { key: "job_title", labelKey: "common.labels.role", level: "header", kind: "text" },
    { key: "first_week", labelKey: "timesheets.list.week", level: "header", kind: "date", required: true },
    { key: "last_week", labelKey: "timesheets.list.week", level: "header", kind: "date", required: true },
    { key: "hours_per_week", labelKey: "timesheets.labels.totalHours", level: "header", kind: "number", required: true },
    { key: "is_billable", labelKey: "timesheets.labels.billable", level: "header", kind: "boolean" },
    { key: "bill_item_id", labelKey: "timesheets.labels.serviceItem", level: "header", kind: "entity_ref" },
    { key: "reason", labelKey: "common.labels.notes", level: "header", kind: "long_text" },
  ],
  lineFields: [],
  listColumns: [
    { key: "project_id", labelKey: "common.labels.project", kind: "reference", sortable: true, sortKey: "project", locked: true },
    { key: "employee_party_id", labelKey: "common.labels.employee", kind: "reference", sortable: true, sortKey: "employee" },
    { key: "job_title", labelKey: "common.labels.role", kind: "text", sortable: true, sortKey: "role" },
    { key: "first_week", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "first_week" },
    { key: "last_week", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "last_week" },
    { key: "hours_per_week", labelKey: "timesheets.labels.totalHours", kind: "amount", sortable: true, sortKey: "hours" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
  ],
  listFilters: [
    { key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "common.status.draft" },
        { value: "submitted", labelKey: "common.status.pending_approval" },
        { value: "approved", labelKey: "common.status.approved" },
        { value: "rejected", labelKey: "common.status.rejected" },
        { value: "cancelled", labelKey: "common.status.cancelled" },
      ] },
    { key: "project_id", labelKey: "common.labels.project", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "project" },
    { key: "employee_party_id", labelKey: "common.labels.employee", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "employee" },
    { key: "first_week", labelKey: "timesheets.list.week", kind: "date", operators: OPERATORS_BY_KIND.date },
  ],
};

const RESOURCING_DEMAND: RecordTypeMeta = {
  key: "resourcing_demand",
  labelKey: "customization.recordTypes.resourcing_demand",
  category: "entity",
  featureKey: "resourcing",
  supportsForms: false,
  customFieldTable: "res_demand_lines",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "department_id", labelKey: "common.labels.department", kind: "reference", sortable: true, sortKey: "department", locked: true },
    { key: "job_title", labelKey: "common.labels.role", kind: "text", sortable: true, sortKey: "role" },
    { key: "first_week", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "first_week" },
    { key: "last_week", labelKey: "timesheets.list.week", kind: "date", sortable: true, sortKey: "last_week" },
    { key: "hours_per_week", labelKey: "timesheets.labels.totalHours", kind: "amount", sortable: true, sortKey: "hours" },
    { key: "note", labelKey: "common.labels.notes", kind: "text" },
    { key: "opportunity_id", labelKey: "crm.fields.opportunity", kind: "reference", sortable: true, sortKey: "opportunity" },
  ],
  listFilters: [
    { key: "department_id", labelKey: "common.labels.department", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "department" },
    { key: "job_title", labelKey: "common.labels.role", kind: "text", operators: OPERATORS_BY_KIND.text },
    { key: "first_week", labelKey: "timesheets.list.week", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "last_week", labelKey: "timesheets.list.week", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "opportunity_id", labelKey: "crm.fields.opportunity", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "opportunity" },
  ],
};

const RETAINER: RecordTypeMeta = {
  key: "retainer",
  labelKey: "customization.recordTypes.retainer",
  category: "entity",
  featureKey: "retainerBilling",
  supportsForms: true,
  customFieldTable: "res_retainers",
  customFieldLineTable: null,
  headerFields: [
    { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "entity_ref", required: true },
    { key: "customer_party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref", required: true },
    { key: "kind", labelKey: "customization.resourcing.fields.kind", level: "header", kind: "select", required: true },
    { key: "total_amount", labelKey: "revenue.labels.total", level: "header", kind: "currency", required: true },
    { key: "total_hours", labelKey: "timesheets.labels.totalHours", level: "header", kind: "number" },
    { key: "unit_rate", labelKey: "common.labels.unitPrice", level: "header", kind: "currency" },
    { key: "starts_on", labelKey: "projects.labels.startDate", level: "header", kind: "date", required: true },
    { key: "ends_on", labelKey: "projects.labels.endDate", level: "header", kind: "date", required: true },
    { key: "retainer_item_id", labelKey: "timesheets.labels.serviceItem", level: "header", kind: "entity_ref", required: true },
  ],
  lineFields: [],
  listColumns: [
    { key: "project_id", labelKey: "common.labels.project", kind: "reference", sortable: true, sortKey: "project", locked: true },
    { key: "customer_party_id", labelKey: "common.labels.customer", kind: "reference", sortable: true, sortKey: "customer" },
    { key: "kind", labelKey: "customization.resourcing.fields.kind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "total_amount", labelKey: "revenue.labels.total", kind: "amount", sortable: true, sortKey: "amount" },
    { key: "starts_on", labelKey: "projects.labels.startDate", kind: "date", sortable: true, sortKey: "start" },
    { key: "ends_on", labelKey: "projects.labels.endDate", kind: "date", sortable: true, sortKey: "end" },
    { key: "state", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "state" },
  ],
  listFilters: [
    { key: "state", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "draft", labelKey: "common.status.draft" },
        { value: "active", labelKey: "common.status.active" },
        { value: "exhausted", labelKey: "customization.resourcing.status.exhausted" },
        { value: "expired", labelKey: "customization.resourcing.status.expired" },
        { value: "closed", labelKey: "common.status.closed" },
      ] },
    { key: "kind", labelKey: "customization.resourcing.fields.kind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["hours", "fees"].map((value) => ({ value, labelKey: `customization.resourcing.kind.${value}` })) },
    { key: "project_id", labelKey: "common.labels.project", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "project" },
    { key: "customer_party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
    { key: "starts_on", labelKey: "projects.labels.startDate", kind: "date", operators: OPERATORS_BY_KIND.date },
    { key: "ends_on", labelKey: "projects.labels.endDate", kind: "date", operators: OPERATORS_BY_KIND.date },
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

const CHANGE_SET: RecordTypeMeta = {
  key: "change_set",
  labelKey: "customization.recordTypes.change_set",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [], lineFields: [],
  listColumns: [
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "created", labelKey: "common.labels.created", kind: "date", sortable: true, sortKey: "created" },
  ],
  listFilters: [{ key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
    options: ["draft", "reviewed", "approved", "applied", "discarded"].map(value => ({ value })) }],
};

const BANK_RULE: RecordTypeMeta = {
  key: "bank_rule",
  labelKey: "customization.recordTypes.bank_rule",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [], lineFields: [],
  // Rules evaluate in priority order, so the list opens in that order — not
  // newest-first via the date fallback, which would hide the first-evaluated
  // rule at the bottom.
  defaultSort: { sortKey: "priority", dir: "asc" },
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

const PSP_SETTLEMENT_LINE_UNMATCHED: RecordTypeMeta = {
  key: "psp_settlement_line_unmatched",
  labelKey: "customization.recordTypes.psp_settlement_line_unmatched",
  category: "entity",
  featureKey: "banking",
  supportsForms: false,
  headerFields: [],
  lineFields: [],
  // The queue opens newest-settled first: the operator works the latest
  // payout down, and linked rows leave the queue on the next load.
  defaultSort: { sortKey: "settled", dir: "desc" },
  listColumns: [
    { key: "reference", labelKey: "banking.pspUnmatched.colReference", kind: "reference", sortable: true, sortKey: "reference", locked: true },
    { key: "provider", labelKey: "banking.pspUnmatched.colProvider", kind: "text", sortable: true, sortKey: "provider" },
    { key: "kind", labelKey: "banking.pspUnmatched.colKind", kind: "status", sortable: true, sortKey: "kind" },
    { key: "amount", labelKey: "common.labels.amount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "batch", labelKey: "banking.pspUnmatched.colBatch", kind: "text", sortable: true, sortKey: "batch" },
    { key: "settled", labelKey: "banking.pspUnmatched.colSettled", kind: "date", sortable: true, sortKey: "settled" },
  ],
  listFilters: [
    {
      key: "kind", labelKey: "banking.pspUnmatched.colKind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["charge", "refund", "dispute", "dispute_reversal"].map((value) => ({
        value,
        labelKey: `banking.payouts.kindLabels.${value}`,
      })),
    },
    {
      key: "provider", labelKey: "banking.pspUnmatched.colProvider", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["stripe", "recurly", "chargebee", "shopify_payments", "paypal"].map((value) => ({
        value,
        labelKey: `banking.pspSettlements.providers.${value}`,
      })),
    },
  ],
};

const PAYMENT_DISPUTE_REVIEW: RecordTypeMeta = {
  key: "payment_dispute_review",
  labelKey: "customization.recordTypes.payment_dispute_review",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  // The queue opens newest-first: the operator works the latest provider
  // event down, and resolved rows leave the queue on transition.
  defaultSort: { sortKey: "created", dir: "desc" },
  listColumns: [
    { key: "provider_event", labelKey: "banking.pspReviews.colReference", kind: "reference", sortable: true, sortKey: "provider_event", locked: true },
    { key: "provider", labelKey: "banking.pspReviews.colProvider", kind: "text", sortable: true, sortKey: "provider" },
    { key: "kind", labelKey: "banking.pspReviews.colKind", kind: "text", sortable: true, sortKey: "kind" },
    { key: "amount", labelKey: "common.labels.amount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status" },
    { key: "created", labelKey: "common.labels.created", kind: "date", sortable: true, sortKey: "created" },
  ],
  listFilters: [
    {
      key: "status", labelKey: "common.labels.status", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["pending_review", "posted", "rejected", "opened", "won", "lost"].map((value) => ({
        value,
        labelKey: `banking.pspReviews.status.${value}`,
      })),
    },
    {
      key: "kind", labelKey: "banking.pspReviews.colKind", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["refund", "dispute"].map((value) => ({
        value,
        labelKey: `banking.pspReviews.kind.${value}`,
      })),
    },
    {
      key: "provider", labelKey: "banking.pspReviews.colProvider", kind: "select", operators: OPERATORS_BY_KIND.select,
      options: ["stripe", "adyen", "gocardless", "paypal", "shopify_payments"].map((value) => ({
        value,
        labelKey: `banking.pspSettlements.providers.${value}`,
      })),
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
  defaultSort: { sortKey: "name", dir: "asc" },
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
  // The directory columns sit between the contact columns and the party
  // status: existing columns keep their relative order, and the party
  // status stays last where the status facet counts it.
  listColumns: [
    ...PARTY_LIST_COLUMNS.filter((column) => column.key !== "status"),
    ...EMPLOYEE_HRM_COLUMNS,
    ...PARTY_LIST_COLUMNS.filter((column) => column.key === "status"),
  ],
  // HR-2b directory filters. The department and employer value sets are
  // tenant data, so they arrive through the list's quick-filter loaders and
  // the unassigned employment states ride as static options. Saved views
  // filter the same keys through the employee where builder.
  listFilters: [
    {
      key: "department",
      labelKey: "common.labels.department",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [{ value: "unassigned", labelKey: "hrm.home.groups.unassigned" }],
    },
    {
      key: "employment_status",
      labelKey: "hrm.directory.employmentStatus",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
      options: [
        { value: "offered", labelKey: "hrm.employment.status.offered" },
        { value: "active", labelKey: "hrm.employment.status.active" },
        { value: "on_leave", labelKey: "hrm.employment.status.on_leave" },
        { value: "suspended", labelKey: "hrm.employment.status.suspended" },
        { value: "terminated", labelKey: "hrm.employment.status.terminated" },
        { value: "no_employment", labelKey: "hrm.directory.noEmployment" },
      ],
    },
    {
      key: "employer",
      labelKey: "hrm.home.groups.employer",
      kind: "select",
      operators: OPERATORS_BY_KIND.select,
    },
  ],
  defaultSort: { sortKey: "name", dir: "asc" },
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
  // A project directory opens A→Z like every other name-ordered directory —
  // not newest-first via the created fallback, which buries the project you
  // are looking for.
  defaultSort: { sortKey: "name", dir: "asc" },
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
        { key: "staffing", labelKey: "projects.cockpit.tabs.staffing", featureKey: "resourcing" },
        { key: "progress", labelKey: "projects.cockpit.tabs.progress", featureKey: "projectProgress" },
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
    { key: "site_jurisdiction", labelKey: "projects.labels.siteJurisdiction", level: "header", kind: "select" },
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
    { key: "opening_accumulated_depreciation", labelKey: "assets.labels.openingAccumulated", level: "header", kind: "currency" },
    { key: "opening_accumulated_as_of", labelKey: "assets.labels.openingAsOf", level: "header", kind: "date" },
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
    { key: "opening_accumulated_depreciation", labelKey: "assets.labels.openingAccumulated", kind: "amount", defaultHidden: true, defaultWidth: 130 },
    { key: "opening_accumulated_as_of", labelKey: "assets.labels.openingAsOf", kind: "date", defaultHidden: true },
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
    { key: "subsidiary", labelKey: "common.labels.subsidiary", kind: "text", legalEntity: true },
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
        { value: "pending_approval", labelKey: "common.status.pendingApproval" },
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
 * Pick lists and shipments — the warehouse half of the order cycle
 * (Fulfillment feature). Neither is edited through the generic document
 * API: a pick list is built from an issued sales order's open stock lines and
 * a shipment from a released pick list, so the customer, sales order,
 * warehouse and lines are locked on the form. The date and memo are captured
 * when the document is created; a draft shipment also takes its carrier,
 * service, tracking number and cartons. Custom fields are header-only.
 */
const FULFILLMENT_STAGE_FILTER: ListFilterMeta = {
  key: "fulfillment_stage",
  labelKey: "fulfillment.fields.stage",
  kind: "select",
  operators: ["eq", "ne"],
  options: [
    { value: "open", labelKey: "fulfillment.stage.open" },
    { value: "done", labelKey: "fulfillment.stage.done" },
  ],
};

const FULFILLMENT_WAREHOUSE_FILTER: ListFilterMeta = {
  key: "warehouse_id",
  labelKey: "common.labels.warehouse",
  kind: "entity_ref",
  operators: OPERATORS_BY_KIND.entity_ref,
  entitySource: "warehouse",
};

const FULFILLMENT_LINE_FIELDS: RecordTypeMeta["lineFields"] = [
  { key: "sales_order_line", labelKey: "fulfillment.fields.salesOrderLine", level: "line", kind: "text", locked: true },
  { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref", required: true, locked: true },
  { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
  { key: "bin_id", labelKey: "fulfillment.fields.bin", level: "line", kind: "entity_ref", required: true, locked: true },
  { key: "lot_serial", labelKey: "fulfillment.fields.lotSerial", level: "line", kind: "text" },
  { key: "quantity", labelKey: "common.labels.quantity", level: "line", kind: "number", required: true, locked: true },
  { key: "unit", labelKey: "common.labels.unit", level: "line", kind: "text" },
];

function fulfillmentRecordType(key: "pick_list" | "shipment"): RecordTypeMeta {
  const shipment = key === "shipment";
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "transaction",
    featureKey: "fulfillment",
    customFieldLineTable: null,
    headerFields: [
      { key: "party_id", labelKey: "common.labels.customer", level: "header", kind: "entity_ref", locked: true },
      { key: "sales_order_id", labelKey: "fulfillment.fields.salesOrder", level: "header", kind: "entity_ref", locked: true },
      ...(shipment
        ? [{ key: "pick_list_id", labelKey: "fulfillment.fields.pickList", level: "header" as const, kind: "entity_ref" as const, locked: true }]
        : []),
      { key: "warehouse_id", labelKey: "common.labels.warehouse", level: "header", kind: "entity_ref", locked: true },
      { key: "document_date", labelKey: "common.labels.date", level: "header", kind: "date" },
      ...(shipment
        ? [
            { key: "carrier_id", labelKey: "fulfillment.fields.carrier", level: "header" as const, kind: "entity_ref" as const },
            { key: "carrier_service", labelKey: "fulfillment.fields.service", level: "header" as const, kind: "select" as const },
            { key: "tracking_number", labelKey: "fulfillment.fields.trackingNumber", level: "header" as const, kind: "text" as const },
            { key: "ship_to_address", labelKey: "fulfillment.fields.shipTo", level: "header" as const, kind: "long_text" as const },
          ]
        : []),
      { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
    ],
    lineFields: shipment
      ? [...FULFILLMENT_LINE_FIELDS, { key: "carton", labelKey: "fulfillment.fields.carton", level: "line", kind: "text" }]
      : FULFILLMENT_LINE_FIELDS,
    defaultSort: { sortKey: "date", dir: "desc" },
    listColumns: [
      { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "party_name", labelKey: "common.labels.customer", kind: "text", sortable: true, sortKey: "party" },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "sales_order_number", labelKey: "fulfillment.fields.salesOrder", kind: "text", sortable: true, sortKey: "salesOrder" },
      { key: "warehouse_code", labelKey: "common.labels.warehouse", kind: "text", sortable: true, sortKey: "warehouse", defaultWidth: 120 },
      ...(shipment
        ? [
            { key: "carrier_name", labelKey: "fulfillment.fields.carrier", kind: "text" as const, sortable: true, sortKey: "carrier" },
            { key: "tracking_number", labelKey: "fulfillment.fields.trackingNumber", kind: "text" as const },
          ]
        : []),
      { key: "fulfillment_stage", labelKey: "fulfillment.fields.stage", kind: "text", sortable: true, sortKey: "stage", defaultWidth: 110 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 130 },
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
    ],
    listFilters: [
      {
        key: "status",
        labelKey: "common.labels.status",
        kind: "select",
        operators: OPERATORS_BY_KIND.select,
        options: shipment
          ? [
              { value: "draft", labelKey: "common.status.draft" },
              { value: "approved", labelKey: "common.status.approved" },
              { value: "voided", labelKey: "common.status.voided" },
            ]
          : [
              { value: "draft", labelKey: "common.status.draft" },
              { value: "pending_approval", labelKey: "common.status.pendingApproval" },
              { value: "approved", labelKey: "common.status.approved" },
              { value: "voided", labelKey: "common.status.voided" },
            ],
      },
      FULFILLMENT_STAGE_FILTER,
      FULFILLMENT_WAREHOUSE_FILTER,
      { key: "party_id", labelKey: "common.labels.customer", kind: "entity_ref", operators: OPERATORS_BY_KIND.entity_ref, entitySource: "customer" },
      DATE_FILTER,
    ],
  };
}

const PICK_LIST = fulfillmentRecordType("pick_list");
const SHIPMENT = fulfillmentRecordType("shipment");

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

/**
 * Funds — the fund segment's classified values. Editing rides the setup
 * commands (framework, fund pairs), never a generic form, so the editor is a
 * bespoke drawer and only the list view is customizable. Restriction classes
 * are framework-owned vocabulary, so the class column carries no static
 * filter options — the list filters free text, never a closed list one
 * framework would render wrong.
 */
const FUND: RecordTypeMeta = {
  key: "fund",
  labelKey: "customization.recordTypes.fund",
  category: "entity",
  featureKey: "fundAccounting",
  supportsForms: false,
  customFieldTable: "funds",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "code", labelKey: "projects.labels.code", kind: "text", sortable: true, sortKey: "code" },
    { key: "name", labelKey: "common.labels.name", kind: "reference", sortable: true, sortKey: "name", locked: true },
    { key: "restriction_class", labelKey: "common.labels.class", kind: "text", sortable: true, sortKey: "class" },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    { key: "name", labelKey: "common.labels.name", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
  defaultSort: { sortKey: "name", dir: "asc" },
};

/**
 * Fund releases — interfund movements awaiting or under approval. Status
 * changes ride the release approval lifecycle, so the editor is the bespoke
 * release drawer and only the list view is customizable. A dated ledger
 * opens newest-first.
 */
const FUND_RELEASE: RecordTypeMeta = {
  key: "fund_release",
  labelKey: "customization.recordTypes.fund_release",
  category: "entity",
  featureKey: "fundAccounting",
  supportsForms: false,
  customFieldTable: "fund_releases",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "release_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "release_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date", defaultWidth: 120 },
    { key: "from_fund", labelKey: "common.labels.from", kind: "text", sortable: true, sortKey: "from_fund" },
    { key: "to_fund", labelKey: "common.labels.to", kind: "text", sortable: true, sortKey: "to_fund" },
    { key: "amount", labelKey: "common.labels.amount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [
    { key: "release_number", labelKey: "common.labels.number", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
  defaultSort: { sortKey: "date", dir: "desc" },
};

/**
 * Grants are versioned awards. The universal list shows only the current
 * version per code; lifecycle editing remains in the bespoke grant drawer.
 */
const GRANT: RecordTypeMeta = {
  key: "grant",
  labelKey: "nonprofit.grants.title",
  category: "entity",
  featureKey: "grantManagement",
  supportsForms: false,
  customFieldTable: "grants",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "code", labelKey: "nonprofit.grants.code", kind: "reference", sortable: true, sortKey: "code", locked: true },
    { key: "name", labelKey: "nonprofit.grants.name", kind: "text", sortable: true, sortKey: "name" },
    { key: "sponsor", labelKey: "nonprofit.grants.sponsor", kind: "text", sortable: true, sortKey: "sponsor" },
    { key: "determination", labelKey: "nonprofit.grants.determination", kind: "text", sortable: true, sortKey: "determination" },
    { key: "award_amount", labelKey: "nonprofit.grants.awardAmount", kind: "amount", sortable: true, sortKey: "award_amount", defaultWidth: 130 },
    { key: "period_from", labelKey: "nonprofit.grants.periodFrom", kind: "date", sortable: true, sortKey: "period_from", defaultWidth: 120 },
    { key: "period_to", labelKey: "nonprofit.grants.periodTo", kind: "date", sortable: true, sortKey: "period_to", defaultWidth: 120 },
    { key: "fund", labelKey: "nonprofit.grants.fund", kind: "text", sortable: true, sortKey: "fund" },
    { key: "status", labelKey: "nonprofit.grants.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [{ key: "status", labelKey: "nonprofit.grants.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: ["draft", "awarded", "active", "closed_out", "closed", "void"].map((value) => ({ value })) }],
  defaultSort: { sortKey: "code", dir: "asc" },
};

/**
 * Encumbrances are stored-subsidiary commitments. The universal list keeps
 * that authority in its source; lifecycle editing stays in the bespoke drawer.
 */
const ENCUMBRANCE: RecordTypeMeta = {
  key: "encumbrance",
  labelKey: "nonprofit.encumbrances.title",
  category: "entity",
  featureKey: "encumbrances",
  supportsForms: false,
  customFieldTable: "encumbrances",
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "source_kind", labelKey: "nonprofit.encumbrances.sourceKind", kind: "text", sortable: true, sortKey: "source_kind" },
    { key: "account", labelKey: "nonprofit.encumbrances.account", kind: "text", sortable: true, sortKey: "account" },
    { key: "subsidiary", labelKey: "nonprofit.encumbrances.subsidiary", kind: "text", sortable: true, sortKey: "subsidiary", legalEntity: true },
    { key: "amount", labelKey: "nonprofit.encumbrances.amount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "status", labelKey: "nonprofit.encumbrances.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [{ key: "status", labelKey: "nonprofit.encumbrances.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: ["open", "closed", "void"].map((value) => ({ value })) }],
  defaultSort: { sortKey: "number", dir: "asc" },
};
/**
 * Collection attempts are the autopay charge ledger: one row per (invoice,
 * retry position) with the provider outcome. The universal list is the
 * operator's collection queue; retrying happens in the attempt drawer.
 */
const COLLECTION_ATTEMPT: RecordTypeMeta = {
  key: "collection_attempt",
  labelKey: "customization.recordTypes.collection_attempt",
  category: "entity",
  featureKey: "autopay",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "invoice", labelKey: "ar.collections.attempts.invoice", kind: "reference", sortable: true, sortKey: "invoice", locked: true },
    { key: "customer", labelKey: "ar.collections.attempts.customer", kind: "text", sortable: true, sortKey: "customer" },
    { key: "amount", labelKey: "ar.collections.attempts.amount", kind: "amount", sortable: true, sortKey: "amount", defaultWidth: 130 },
    { key: "provider", labelKey: "ar.collections.attempts.provider", kind: "text", sortable: true, sortKey: "provider" },
    { key: "decline_code", labelKey: "ar.collections.attempts.decline", kind: "text", sortable: true, sortKey: "decline_code" },
    { key: "decline_kind", labelKey: "ar.collections.attempts.declineKind", kind: "text", sortable: true, sortKey: "decline_kind", defaultWidth: 150 },
    { key: "next_retry_on", labelKey: "ar.collections.attempts.nextRetryHeader", kind: "date", sortable: true, sortKey: "next_retry_on", defaultWidth: 120 },
    { key: "created_at", labelKey: "ar.collections.attempts.attemptedAt", kind: "date", sortable: true, sortKey: "created_at", defaultWidth: 120 },
    { key: "status", labelKey: "ar.collections.attempts.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [{ key: "status", labelKey: "ar.collections.attempts.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: ["initiated", "processing", "succeeded", "failed", "canceled"].map((value) => ({ value })) }],
  defaultSort: { sortKey: "created_at", dir: "desc" },
};
/**
 * Tax provider commits are the AvaTax/TaxJar filing feed: one row per
 * (document, provider, direction) with the commit outcome. The activity tab
 * on Tax is the operator's commit queue; retrying happens in the row drawer.
 * No feature key: provider commits ride the core tax surface, not a gate.
 */
const TAX_PROVIDER_TRANSACTION: RecordTypeMeta = {
  key: "tax_provider_transaction",
  labelKey: "customization.recordTypes.tax_provider_transaction",
  category: "entity",
  supportsForms: false,
  customFieldLineTable: null,
  headerFields: [],
  lineFields: [],
  listColumns: [
    { key: "document", labelKey: "tax.activity.columns.document", kind: "reference", sortable: true, sortKey: "document", locked: true },
    { key: "provider", labelKey: "tax.activity.columns.provider", kind: "text", sortable: true, sortKey: "provider" },
    { key: "status", labelKey: "tax.activity.columns.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
    { key: "attempts", labelKey: "tax.activity.columns.attempts", kind: "text", sortable: true, sortKey: "attempts", defaultWidth: 90 },
    { key: "next_attempt_at", labelKey: "tax.activity.columns.nextAttempt", kind: "date", sortable: true, sortKey: "next_attempt_at", defaultWidth: 120 },
    { key: "committed_at", labelKey: "tax.activity.columns.committedAt", kind: "date", sortable: true, sortKey: "committed_at", defaultWidth: 120 },
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", defaultWidth: 44 },
  ],
  listFilters: [{ key: "status", labelKey: "tax.activity.columns.status", kind: "select", operators: OPERATORS_BY_KIND.select, options: ["pending", "committed", "voided", "failed", "skipped"].map((value) => ({ value })) }],
  defaultSort: { sortKey: "created_at", dir: "desc" },
};
export const RECORD_TYPES: RecordTypeMeta[] = [
  VENDOR_BILL,
  VENDOR_CREDIT,
  CUSTOMER_INVOICE,
  CUSTOMER_CREDIT,
  CASH_SALE,
  CASH_REFUND,
  RETURN_AUTHORIZATION,
  CARD_CHARGE,
  CARD_REFUND,
  PROJECT_CHARGE,
  INTERNAL_BILLING,
  CHECK,
  DEPOSIT,
  TRANSFER,
  EXPENSE_REPORT,
  JOURNAL,
  JOURNAL_DRAFT,
  VENDOR_PAYMENT,
  CUSTOMER_PAYMENT,
  QUOTE,
  SALES_ORDER,
  PURCHASE_ORDER,
  PICK_LIST,
  SHIPMENT,
  CUSTOMER,
  OPPORTUNITY,
  ACTIVITY,
  ITEM,
  ITEM_FAMILY,
  ACCOUNT,
  BANK_TRANSACTION,
  INVENTORY_ONHAND,
  INVENTORY_MOVEMENT,
  DEMAND_SUGGESTION,
  CHANNEL_ORDER,
  CHANNEL_EXCEPTION,
  CHANNEL_EVENT_EXCEPTION,
  WEBHOOK_ENDPOINT,
  BUDGET_SCENARIO,
  HRM_PROCESS_TEMPLATE,
  PROVISION_OBLIGATION,
  LEASE_AGREEMENT,
  FINANCIAL_CHANGE,
  REVENUE_CONTRACT,
  CONTRACT_COST_ASSET,
  STORED_VALUE_ACCOUNT,
  EQUIPMENT_UNIT,
  RESOURCING_ASSIGNMENT,
  RESOURCING_REQUEST,
  RESOURCING_DEMAND,
  RETAINER,
  TIMESHEET_WEEK,
  BANK_RECONCILIATION,
  BANK_STATEMENT,
  BANK_RULE,
  PAYMENT_DISPUTE_REVIEW,
  PSP_SETTLEMENT_LINE_UNMATCHED,
  CHANGE_SET,
  VENDOR,
  EMPLOYEE,
  FIELD_TICKET,
  PAY_RUN,
  PROJECT,
  FIXED_ASSET,
  PROPERTY,
  LABOR_RATE_CARD,
  FUND,
  FUND_RELEASE,
  GRANT,
  ENCUMBRANCE,
  COLLECTION_ATTEMPT,
  TAX_PROVIDER_TRANSACTION,
];

export const RECORD_TYPE_BY_KEY: Record<string, RecordTypeMeta> = RECORD_TYPES.reduce(
  (byKey, recordType) => {
    byKey[recordType.key] = recordType;
    return byKey;
  },
  Object.create(null) as Record<string, RecordTypeMeta>,
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
  features: { inventory: boolean; crm?: boolean; hrm?: boolean },
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
    // CRM off: the list is customers and nothing else. Every lifecycle option
    // but `customer` goes, and so does each column/filter whose SQL reads the
    // crm_account_profiles join that customerBaseJoins(false) does not make.
    const crmColumns = new Set<string>(CUSTOMER_CRM_COLUMN_KEYS)
    const crmFilters = new Set<string>(CUSTOMER_CRM_FILTER_KEYS)
    out = {
      ...out,
      listColumns: out.listColumns
        .filter((column) => !crmColumns.has(column.key))
        .map((column) => (column.key === 'status' ? { ...column, labelKey: CUSTOMER_STATUS_LABEL_KEY } : column)),
      listFilters: out.listFilters
        .filter((filter) => !crmFilters.has(filter.key))
        .map((filter) => {
          if (filter.key !== 'status' || !filter.options?.length) return filter
          return {
            ...filter,
            labelKey: CUSTOMER_STATUS_LABEL_KEY,
            options: filter.options.filter((option) => option.value === 'customer'),
          }
        }),
    }
  }
  if (features.hrm === false && out.key === 'employee') {
    // HRM off: the list is the party roster and nothing else. Every
    // directory column and filter goes — their SQL reads the employment
    // joins that employeeBaseJoins(false) never makes.
    const hrmColumns = new Set<string>(EMPLOYEE_HRM_COLUMN_KEYS)
    const hrmFilters = new Set<string>(EMPLOYEE_HRM_FILTER_KEYS)
    out = {
      ...out,
      listColumns: out.listColumns.filter((column) => !hrmColumns.has(column.key)),
      listFilters: out.listFilters.filter((filter) => !hrmFilters.has(filter.key)),
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
 * types with a line grid (customFieldLineTable non-null). Only a transaction
 * falls back to documents: an entity type that names no table, or a key
 * outside the registry, has no custom-field storage and resolves to null.
 */
export function customFieldTargetFor(recordType: string): {
  table: string | null
  kind: string | undefined
  lineTable: string | null
  lineKind: string | undefined
} {
  // The draft tab is a list projection of journal documents, not a new kind.
  if (recordType === "journal_draft") return customFieldTargetFor("journal")
  const meta = RECORD_TYPE_BY_KEY[recordType]
  const documentKind = meta?.category === "transaction"
  const table = meta?.customFieldTable ?? (documentKind ? "documents" : null)
  const lineTable = meta && meta.customFieldLineTable !== undefined ? meta.customFieldLineTable : documentKind ? "document_lines" : null
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
