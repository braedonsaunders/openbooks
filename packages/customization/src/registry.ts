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
  { key: "item_id", labelKey: "common.labels.item", level: "line", kind: "entity_ref", defaultHidden: true },
  { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
  { key: "quantity", labelKey: "common.labels.quantity", level: "line", kind: "number", defaultHidden: true },
  { key: "unit", labelKey: "common.labels.unit", level: "line", kind: "text", defaultHidden: true },
  { key: "unit_price", labelKey: "common.labels.unitPrice", level: "line", kind: "currency", defaultHidden: true },
  { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
  { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
  { key: "location_id", labelKey: "common.labels.location", level: "line", kind: "dimension", defaultHidden: true },
  { key: "class_id", labelKey: "common.labels.class", level: "line", kind: "dimension", defaultHidden: true },
  { key: "tax_code_id", labelKey: "common.labels.tax", level: "line", kind: "entity_ref" },
  { key: "amount", labelKey: "common.labels.amount", level: "line", kind: "amount", required: true },
  { key: "tax_amount", labelKey: "ap.drawer.taxAmountColumn", level: "line", kind: "tax" },
];

/** Header built-ins available on every transaction form (off by default). */
const COMMON_HEADER_EXTRAS: FieldMeta[] = [
  { key: "posting_date", labelKey: "common.labels.postingDate", level: "header", kind: "date", defaultHidden: true },
  { key: "department_id", labelKey: "common.labels.department", level: "header", kind: "dimension", defaultHidden: true },
  { key: "project_id", labelKey: "common.labels.project", level: "header", kind: "dimension", defaultHidden: true },
  { key: "location_id", labelKey: "common.labels.location", level: "header", kind: "dimension", defaultHidden: true },
  { key: "class_id", labelKey: "common.labels.class", level: "header", kind: "dimension", defaultHidden: true },
  { key: "internal_notes", labelKey: "common.labels.internalNotes", level: "header", kind: "long_text", defaultHidden: true },
];

/** Extra AP-side header built-ins (bills/credits). */
const PAYABLE_HEADER_EXTRAS: FieldMeta[] = [
  { key: "expected_pay_date", labelKey: "common.labels.expectedPayDate", level: "header", kind: "date", defaultHidden: true },
  { key: "payment_hold_reason", labelKey: "common.labels.paymentHold", level: "header", kind: "text", defaultHidden: true },
];

/** Extra AR-side header built-ins (project-billing invoices). */
const INVOICE_HEADER_EXTRAS: FieldMeta[] = [
  { key: "billing_method", labelKey: "common.labels.billingMethod", level: "header", kind: "select", defaultHidden: true },
  { key: "is_final_invoice", labelKey: "common.labels.finalInvoice", level: "header", kind: "boolean", defaultHidden: true },
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
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", locked: true, defaultWidth: 96 },
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
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", locked: true, defaultWidth: 96 },
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
      { key: "_actions", labelKey: "common.labels.actions", kind: "actions", locked: true, defaultWidth: 96 },
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
    { key: "_actions", labelKey: "common.labels.actions", kind: "actions", locked: true, defaultWidth: 96 },
  ],
  listFilters: [
    DIRECT_POST_STATUS_FILTER,
    DATE_FILTER,
    { key: "reference_number", labelKey: "common.labels.reference", kind: "text", operators: OPERATORS_BY_KIND.text },
  ],
};

/**
 * Vendor/customer payment documents. Editor is the bespoke PaymentDrawer, so
 * `supportsForms` is false — only the saved list view is customizable. The
 * `total` and `bank_account` columns are journal-derived at query time (imported
 * payments carry the amount on their posted entry, not documents.total).
 */
function paymentRecordType(key: string, partyLabelKey: string, entitySource: string): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "entity",
    supportsForms: false,
    headerFields: [],
    lineFields: [],
    listColumns: [
      { key: "document_number", labelKey: "payments.list.columns.payment", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "party_name", labelKey: partyLabelKey, kind: "text", sortable: true, sortKey: "party" },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "bank_account", labelKey: "payments.list.columns.bankAccount", kind: "text" },
      { key: "reference_number", labelKey: "payments.list.columns.ref", kind: "text" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 130 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
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
 * Order documents (quotes, sales orders, purchase orders). Non-posting; edited
 * via the bespoke OrderDrawer, so `supportsForms` is false — only the saved list
 * view is customizable. Conversion progress ("Converted %") lives in a report,
 * not the list. Statuses are draft/approved/voided (no approval routing).
 */
function orderRecordType(key: string, partyLabelKey: string, entitySource: string): RecordTypeMeta {
  return {
    key,
    labelKey: `customization.recordTypes.${key}`,
    category: "entity",
    supportsForms: false,
    headerFields: [],
    lineFields: [],
    listColumns: [
      { key: "document_number", labelKey: "common.labels.number", kind: "reference", sortable: true, sortKey: "number", locked: true },
      { key: "party_name", labelKey: partyLabelKey, kind: "text", sortable: true, sortKey: "party" },
      { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
      { key: "reference_number", labelKey: "common.labels.reference", kind: "text" },
      { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
      { key: "status", labelKey: "common.labels.status", kind: "status", sortable: true, sortKey: "status", defaultWidth: 120 },
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

export const RECORD_TYPES: RecordTypeMeta[] = [
  VENDOR_BILL,
  VENDOR_CREDIT,
  CUSTOMER_INVOICE,
  CUSTOMER_CREDIT,
  CARD_CHARGE,
  CARD_REFUND,
  CHECK,
  VENDOR_PAYMENT,
  CUSTOMER_PAYMENT,
  QUOTE,
  SALES_ORDER,
  PURCHASE_ORDER,
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

/** Is `key` a custom-field reference (`cf_<defKey>`)? */
export function isCustomFieldKey(key: string): boolean {
  return key.startsWith("cf_") && key.length > 3;
}

/** The custom field def key portion of a `cf_<key>` reference. */
export function customFieldDefKey(key: string): string {
  return isCustomFieldKey(key) ? key.slice(3) : key;
}
