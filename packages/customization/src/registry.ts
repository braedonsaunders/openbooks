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
  { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
  { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
  { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
  { key: "tax_code_id", labelKey: "common.labels.tax", level: "line", kind: "entity_ref" },
  { key: "amount", labelKey: "common.labels.amount", level: "line", kind: "amount", required: true },
  { key: "tax_amount", labelKey: "ap.drawer.taxAmountColumn", level: "line", kind: "tax" },
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
    { key: "document_date", labelKey: "ap.drawer.billDate", level: "header", kind: "date" },
    { key: "due_date", labelKey: "ap.drawer.dueDate", level: "header", kind: "date" },
    { key: "reference_number", labelKey: "ap.drawer.vendorRef", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
  ],
  lineFields: [
    { key: "account_id", labelKey: "common.labels.account", level: "line", kind: "entity_ref", required: true, locked: true },
    { key: "description", labelKey: "common.labels.description", level: "line", kind: "text" },
    { key: "department_id", labelKey: "common.labels.department", level: "line", kind: "dimension" },
    { key: "project_id", labelKey: "common.labels.project", level: "line", kind: "dimension" },
    { key: "tax_code_id", labelKey: "common.labels.tax", level: "line", kind: "entity_ref" },
    { key: "amount", labelKey: "common.labels.amount", level: "line", kind: "amount", required: true },
    { key: "tax_amount", labelKey: "ap.drawer.taxAmountColumn", level: "line", kind: "tax" },
  ],
  listColumns: [
    { key: "document_number", labelKey: "ap.list.columns.bill", kind: "reference", sortable: true, sortKey: "number", locked: true },
    { key: "party_name", labelKey: "common.labels.vendor", kind: "text", sortable: true, sortKey: "vendor" },
    { key: "document_date", labelKey: "common.labels.date", kind: "date", sortable: true, sortKey: "date" },
    { key: "reference_number", labelKey: "ap.list.columns.ref", kind: "text" },
    { key: "total", labelKey: "common.labels.total", kind: "amount", sortable: true, sortKey: "total", defaultWidth: 120 },
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
    { key: "reference_number", labelKey: "ap.drawer.vendorRef", level: "header", kind: "text" },
    { key: "memo", labelKey: "common.labels.memo", level: "header", kind: "long_text" },
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

export const RECORD_TYPES: RecordTypeMeta[] = [
  VENDOR_BILL,
  VENDOR_CREDIT,
  CUSTOMER_INVOICE,
  CUSTOMER_CREDIT,
  CARD_CHARGE,
  CARD_REFUND,
  CHECK,
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
