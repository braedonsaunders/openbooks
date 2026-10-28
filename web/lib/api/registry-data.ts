import {
  DOCUMENT_REVISION_PATTERN,
  isDocumentRevisionToken,
} from "@openbooks/engine/records/revision";
import {
  createPermission,
  documentReadPermission,
  postPermission,
} from "@openbooks/engine/records/document-kind-permissions";
import { DOC_KIND_FEATURE } from "../document-kinds";
export { DOCUMENT_REVISION_PATTERN, isDocumentRevisionToken };

/**
 * Pure API registry data + type mappings — NO db / server-only imports, so it
 * is unit-testable and safe to share. The db-backed `loadApiSchema` /
 * `resolveApiType` live in ./schema-registry and build on top of this.
 */

export type ApiOperation = "list" | "get" | "create" | "update" | "delete";

/**
 * How a record type persists on write. Writes never bypass the domain layer:
 *  - `custom_record` — generic jsonb path (custom_records + FormSection[]).
 *  - `document` — delegates to the document service (draft → apply → post),
 *    keyed by the documents.kind discriminator; preserves GL invariants.
 *  - `entity` — a flat first-class table (items, projects, …): typed columns +
 *    a `custom` jsonb bag validated against custom_field_defs.
 *  - `readonly` — no writes through the generic layer (e.g. journal_entries,
 *    which are a projection of posted documents).
 */
export type Writer =
  | { kind: "custom_record" }
  | { kind: "document"; docKind: string }
  | { kind: "entity"; table: string }
  | { kind: "readonly" };

export interface ApiRecordType {
  key: string;
  label: string;
  description: string;
  table: string | null;
  searchColumn: string;
  readPermission: string;
  writePermission: string | null;
  operations: ApiOperation[];
  writer: Writer;
  dynamic: boolean;
  /** Required read discriminator for a documents-backed non-document writer. */
  documentKinds?: readonly string[];
  /** When set, the type disappears from the API catalog if that Features switch is off. */
  featureKey?: string;
  /** Permission required for the kind-specific posting lifecycle action. */
  postPermission?: string | null;
}

/** The full read+write op set, for types whose writer supports mutation. */
export const RW: ApiOperation[] = ["list", "get", "create", "update", "delete"];
export const RO: ApiOperation[] = ["list", "get"];

/**
 * Static /api/v1 segments that are command or meta folders, not record-type
 * aliases. The catch-all resource routes refuse these so a custom record
 * named `close` cannot shadow /api/v1/close/runs.
 */
export const V1_RESERVED_STATIC_SEGMENTS = [
  "commands",
  "documents",
  "close",
  "approvals",
  "banking",
  "budgets",
  "files",
  "settings",
  "setup",
  "layouts",
  "apps",
  "vitals",
  "health",
  "schema",
  "openapi",
  "records",
  "reports",
  "open-items",
  "currencies",
  "fx",
  "inventory",
  "payroll",
  "search",
  "tax",
  "admin",
  "opportunities",
  "customers",
  "vendors",
  "employees",
  "aging",
  "trial-balance",
  "crm",
  "statements",
] as const;

const V1_RESERVED_STATIC_SEGMENT_SET = new Set<string>(V1_RESERVED_STATIC_SEGMENTS);

/** First-class resource path, or null when the key is a reserved static folder. */
export function v1PrettyResourcePath(typeKey: string): string | null {
  if (V1_RESERVED_STATIC_SEGMENT_SET.has(typeKey)) return null;
  return `/api/v1/${typeKey}`;
}

function documentResource(args: {
  key: string;
  label: string;
  description: string;
  docKind: string;
  readPermission: string;
  writePermission: string | null;
  featureKey?: string;
}): ApiRecordType {
  const writable = args.writePermission !== null;
  const featureKey = args.featureKey ?? DOC_KIND_FEATURE[args.docKind];
  let postPermissionKey: string | null = null;
  if (writable) {
    try {
      postPermissionKey = postPermission(args.docKind);
    } catch {
      // Non-registry document kinds keep their dedicated application lifecycle.
    }
  }
  return {
    key: args.key,
    label: args.label,
    description: args.description,
    table: "documents",
    searchColumn: "document_number",
    readPermission: args.readPermission,
    writePermission: args.writePermission,
    operations: writable ? RW : RO,
    writer: writable ? { kind: "document", docKind: args.docKind } : { kind: "readonly" },
    dynamic: false,
    documentKinds: [args.docKind],
    postPermission: postPermissionKey,
    ...(featureKey ? { featureKey } : {}),
  };
}

/** Built-in record types exposed through the API. */
export const API_RECORD_TYPES: ApiRecordType[] = [
  {
    key: "journal-entries",
    label: "Journal Entries",
    description:
      "Balanced ledger entries enforced by the accounting kernel. Journal entries are a projection of posted documents — create them through the `journal` document type so kernel invariants (balance, period, audit) hold. Read-only here.",
    table: "journal_entries",
    searchColumn: "entry_number",
    readPermission: "gl.read",
    writePermission: null,
    operations: RO,
    writer: { kind: "readonly" },
    dynamic: false,
  },
  documentResource({
    key: "bills",
    label: "Vendor Bills",
    description:
      "Accounts payable documents — invoices received from vendors. Writes create a draft and can submit/post through the posting kernel.",
    docKind: "vendor_bill",
    readPermission: documentReadPermission("vendor_bill"),
    writePermission: createPermission("vendor_bill"),
  }),
  documentResource({
    key: "invoices",
    label: "Customer Invoices",
    description:
      "Accounts receivable documents — sales invoices issued to customers. Writes create a draft and can submit/post through the posting kernel.",
    docKind: "customer_invoice",
    readPermission: documentReadPermission("customer_invoice"),
    writePermission: createPermission("customer_invoice"),
  }),
  {
    key: "payments",
    label: "Payments",
    description:
      "Vendor payments and customer receipts, with open-item application. Read-only in v1 — creation goes through the payment/cash-application flow.",
    table: "documents",
    searchColumn: "document_number",
    readPermission: "ap.pay",
    writePermission: null,
    operations: RO,
    writer: { kind: "readonly" },
    dynamic: false,
    documentKinds: ["vendor_payment", "customer_payment"],
  },
  {
    key: "parties",
    label: "Parties",
    description:
      "The unified party directory — customers, vendors, and employees. A single record can hold multiple roles.",
    table: "parties",
    searchColumn: "display_name",
    readPermission: "parties.read",
    writePermission: "parties.manage",
    operations: RW,
    writer: { kind: "entity", table: "parties" },
    dynamic: false,
  },
  {
    key: "accounts",
    label: "Chart of Accounts",
    description:
      "The general-ledger chart of accounts — posting, summary, and header accounts. Managed through Setup; read-only here.",
    table: "accounts",
    searchColumn: "name",
    readPermission: "gl.read",
    writePermission: null,
    operations: RO,
    writer: { kind: "readonly" },
    dynamic: false,
  },
  {
    key: "items",
    label: "Items & Services",
    description: "The catalog of items and services that sales and purchase lines reference.",
    table: "items",
    searchColumn: "name",
    readPermission: "items.read",
    writePermission: "items.manage",
    operations: RW,
    writer: { kind: "entity", table: "items" },
    dynamic: false,
  },
  {
    key: "projects",
    label: "Projects",
    description: "Jobs and projects for job costing and dimension tracking.",
    table: "projects",
    searchColumn: "name",
    readPermission: "projects.read",
    writePermission: "projects.manage",
    operations: RW,
    writer: { kind: "entity", table: "projects" },
    dynamic: false,
    featureKey: "projects",
  },
  {
    key: "assets",
    label: "Fixed Assets",
    description: "Fixed assets and their depreciation schedules.",
    table: "fixed_assets",
    searchColumn: "name",
    readPermission: "assets.read",
    writePermission: "assets.manage",
    operations: RW,
    writer: { kind: "entity", table: "fixed_assets" },
    dynamic: false,
    featureKey: "fixedAssets",
  },
  documentResource({
    key: "vendor-credits",
    label: "Vendor Credits",
    description:
      "Accounts payable credit memos. Writes create a draft and can submit/post through the posting kernel.",
    docKind: "vendor_credit",
    readPermission: "ap.read",
    writePermission: "ap.create",
  }),
  documentResource({
    key: "customer-credits",
    label: "Customer Credits",
    description:
      "Accounts receivable credit memos. Writes create a draft and can submit/post through the posting kernel.",
    docKind: "customer_credit",
    readPermission: "ar.read",
    writePermission: "ar.create",
  }),
  documentResource({
    key: "internal-billing",
    label: "Intercompany Billing",
    description:
      "Internal cross-entity billing documents. Drafts use the shared document editor and post through the accounting kernel.",
    docKind: "internal_billing",
    readPermission: documentReadPermission("internal_billing"),
    writePermission: createPermission("internal_billing"),
  }),
  documentResource({
    key: "cash-sales",
    label: "Cash Sales",
    description:
      "Paid-at-sale receipts. Writes create a draft and can submit/post through the posting kernel; tenders must sum to the document total.",
    docKind: "cash_sale",
    readPermission: "cash_sales.read",
    writePermission: "cash_sales.create",
    featureKey: "cashSales",
  }),
  documentResource({
    key: "cash-refunds",
    label: "Cash Refunds",
    description:
      "Paid-out refund documents reversing a cash sale or invoice. Writes create a draft and can submit/post through the posting kernel; tenders must sum to the refund total.",
    docKind: "cash_refund",
    readPermission: "cash_sales.read",
    writePermission: "cash_sales.create",
    featureKey: "cashSales",
  }),
  documentResource({
    key: "card-charges",
    label: "Card Charges",
    description:
      "Card-funded expense documents. Writes create a draft and can post through the posting kernel.",
    docKind: "card_charge",
    readPermission: "ap.read",
    writePermission: "ap.create",
  }),
  documentResource({
    key: "card-refunds",
    label: "Card Refunds",
    description:
      "Card refund documents. Writes create a draft and can post through the posting kernel.",
    docKind: "card_refund",
    readPermission: "ap.read",
    writePermission: "ap.create",
  }),
  documentResource({
    key: "checks",
    label: "Checks",
    description:
      "Bank-funded check documents. Writes create a draft and can post through the posting kernel.",
    docKind: "check",
    readPermission: "ap.read",
    writePermission: "ap.create",
  }),
  documentResource({
    key: "deposits",
    label: "Deposits",
    description: "Bank deposits. Writes create a draft and can post through the posting kernel.",
    docKind: "deposit",
    readPermission: "gl.read",
    writePermission: "gl.post",
  }),
  documentResource({
    key: "transfers",
    label: "Transfers",
    description:
      "Inter-account bank transfers. Writes create a draft and can post through the posting kernel.",
    docKind: "transfer",
    readPermission: "gl.read",
    writePermission: "gl.post",
  }),
  documentResource({
    key: "project-charges",
    label: "Project Charges",
    description:
      "Project resource-usage charges. Writes create a draft and can post through the posting kernel.",
    docKind: "project_charge",
    readPermission: documentReadPermission("project_charge"),
    writePermission: createPermission("project_charge"),
    featureKey: "projects",
  }),
  documentResource({
    key: "vendor-payments",
    label: "Vendor Payments",
    description:
      "Vendor payment documents. Read-only here — create and allocate through POST /api/v1/payments.",
    docKind: "vendor_payment",
    readPermission: "ap.pay",
    writePermission: null,
  }),
  documentResource({
    key: "customer-receipts",
    label: "Customer Receipts",
    description:
      "Customer receipt documents. Read-only here — create and allocate through POST /api/v1/payments.",
    docKind: "customer_payment",
    readPermission: "ar.pay",
    writePermission: null,
  }),
  documentResource({
    key: "journals",
    label: "Journals",
    description:
      "Manual journal documents. Create a balanced draft through POST /api/v1/journals (UUID Idempotency-Key becomes the id). Post through POST /api/v1/journals/{id}/post. Posted ledger projections are journal-entries.",
    docKind: "journal",
    readPermission: "gl.read",
    writePermission: null,
  }),
  documentResource({
    key: "quotes",
    label: "Quotes",
    description:
      "Customer estimates. Drafts can be created and edited here; issuing and conversion use the quote lifecycle.",
    docKind: "quote",
    readPermission: "estimates.read",
    writePermission: "estimates.create",
  }),
  documentResource({
    key: "sales-orders",
    label: "Sales Orders",
    description:
      "Customer sales orders. Drafts can be created and edited here; issuance and conversion use the sales-order lifecycle.",
    docKind: "sales_order",
    readPermission: "ar.read",
    writePermission: "ar.create",
  }),
  documentResource({
    key: "return-authorizations",
    label: "Return Authorizations",
    description:
      "Customer return authorizations. Draft creation and edits use the document writer; fulfillment remains an explicit controlled action.",
    docKind: "rma",
    readPermission: documentReadPermission("rma"),
    writePermission: createPermission("rma"),
  }),
  documentResource({
    key: "purchase-orders",
    label: "Purchase Orders",
    description:
      "Vendor purchase orders. Drafts can be created and edited here; approval and conversion use the purchase-order lifecycle.",
    docKind: "purchase_order",
    readPermission: "purchase_orders.read",
    writePermission: "purchase_orders.create",
  }),
  documentResource({
    key: "sales-fulfillments",
    label: "Sales Fulfillments",
    description:
      "Shipments against sales orders. Read-only — operational documents are not edited as commercial commitments.",
    docKind: "sales_fulfillment",
    readPermission: "orders.fulfill",
    writePermission: null,
    featureKey: "orders",
  }),
  documentResource({
    key: "purchase-receipts",
    label: "Purchase Receipts",
    description:
      "Goods receipts against purchase orders. Read-only — operational documents are not edited as commercial commitments.",
    docKind: "purchase_receipt",
    readPermission: "purchase_orders.read",
    writePermission: null,
    featureKey: "orders",
  }),
  documentResource({
    key: "expense-reports",
    label: "Expense Reports",
    description:
      "Employee expense reports. Read-only in v1 — create and submit stay on the expenses workspace.",
    docKind: "expense_report",
    readPermission: "expenses.read",
    writePermission: null,
    featureKey: "expenses",
  }),
  documentResource({
    key: "field-tickets",
    label: "Field Tickets",
    description:
      "Project field tickets. Create a draft through POST /api/v1/field-tickets. Hours and signatures stay on the field-ticket workspace.",
    docKind: "field_ticket",
    readPermission: "time.read",
    writePermission: null,
    featureKey: "fieldTickets",
  }),
  documentResource({
    key: "pay-runs",
    label: "Pay Runs",
    description:
      "Committed payroll GL documents. Read-only — lines are machine-built by the payroll engine.",
    docKind: "pay_run",
    readPermission: "payroll.read",
    writePermission: null,
    featureKey: "payroll",
  }),
];

export const RECORD_TYPE_BY_KEY = new Map(API_RECORD_TYPES.map((t) => [t.key, t]));

/**
 * Canonical wire shape of a document revision. PostgreSQL retains six
 * fractional digits; callers must treat the value as opaque and copy it
 * verbatim instead of parsing it through JavaScript Date.
 */
export const DOCUMENT_REVISION_DESCRIPTION =
  "Exact persisted document revision used for optimistic concurrency. Copy the returned updated_at value verbatim into expectedUpdatedAt for updates; never generate, parse, or reformat it.";

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  /** Defaults to `required`; overrides presence in read representations. */
  requiredOnRead?: boolean;
  writable: boolean;
  /** Defaults to true for writable fields; false means update-only. */
  writableOnCreate?: boolean;
  /** PATCH is partial unless a field explicitly carries this invariant. */
  requiredOnUpdate?: boolean;
  /** Excluded from read representations while remaining visible in writes. */
  writeOnly?: boolean;
  /** JSON Schema pattern used by OpenAPI clients. */
  pattern?: string;
  description: string | null;
  custom: boolean;
  /** Closed set advertised to REST/MCP. Omitted values are hidden, not unknown. */
  enum?: string[];
  /** Item contract for array fields such as document lines. */
  items?: ApiField[];
  /** Property contract for object fields such as order customer match input. */
  properties?: ApiField[];
}

function inputField(
  name: string,
  type: string,
  description: string,
  options: Partial<
    Pick<ApiField, "required" | "writableOnCreate" | "requiredOnUpdate" | "enum">
  > = {},
): ApiField {
  return {
    name,
    type,
    required: options.required ?? false,
    writable: true,
    description,
    custom: false,
    ...options,
  };
}

/** Header fields accepted by the shared document editor. */
export const DOCUMENT_EDIT_HEADER_FIELDS: readonly ApiField[] = [
  inputField("partyId", "string (uuid) | null", "Party on the document."),
  inputField("paymentCardId", "string (uuid) | null", "Payment card used by card documents."),
  inputField("documentDate", "string (date)", "Document business date (YYYY-MM-DD)."),
  inputField("dueDate", "string (date) | null", "Due date when the document is an open item."),
  inputField("referenceNumber", "string | null", "External or supplier reference number."),
  inputField("externalRef", "string | null", "Originating system's stable document reference."),
  inputField("externalSource", "string | null", "Originating system name; send with externalRef."),
  inputField("memo", "string | null", "Document memo."),
  inputField("postingDate", "string (date) | null", "Accounting posting date override."),
  inputField("departmentId", "string (uuid) | null", "Department dimension."),
  inputField("projectId", "string (uuid) | null", "Project dimension."),
  inputField("locationId", "string (uuid) | null", "Location dimension."),
  inputField("classId", "string (uuid) | null", "Class dimension."),
  inputField("extraDims", "object", "Additional configured segment dimensions."),
  inputField(
    "subsidiaryId",
    "string (uuid) | null",
    "Legal entity; restricted keys must use an allowed subsidiary.",
  ),
  inputField("expectedPayDate", "string (date) | null", "Expected payment date."),
  inputField("workCompletedOn", "string (date) | null", "Date the invoiced work was completed."),
  inputField("paymentHoldReason", "string | null", "Reason a payable is held from payment."),
  inputField("internalNotes", "string | null", "Internal document notes."),
  inputField("billingMethod", "string | null", "Billing method for project billing."),
  inputField("isFinalInvoice", "boolean", "Whether this is the final project invoice."),
  inputField(
    "currency",
    "string",
    "Three-letter transaction currency; requires multi-currency when different from base.",
  ),
  inputField(
    "explicitFx",
    "object | null",
    "Explicit exchange-rate evidence for supported drafts.",
  ),
];

/** Header fields accepted by the shared quote and order writers. */
export const ORDER_EDIT_HEADER_FIELDS: readonly ApiField[] = [
  inputField("partyId", "string (uuid) | null", "Customer or vendor party reference."),
  inputField("documentDate", "string (date)", "Order business date (YYYY-MM-DD)."),
  inputField("dueDate", "string (date) | null", "Order due date when applicable."),
  inputField("workCompletedOn", "string (date) | null", "Date the ordered work was completed."),
  inputField("externalRef", "string | null", "Originating system's stable order reference."),
  inputField("externalSource", "string | null", "Originating system name; send with externalRef."),
  inputField("memo", "string | null", "Order memo."),
  inputField(
    "currency",
    "string",
    "Three-letter order currency. Sales-order creation accepts the organization's base currency.",
  ),
  inputField("departmentId", "string (uuid) | null", "Department dimension."),
  inputField("projectId", "string (uuid) | null", "Project dimension."),
  inputField(
    "subsidiaryId",
    "string (uuid) | null",
    "Legal entity; restricted keys must use an allowed subsidiary.",
  ),
  inputField("extraDims", "object", "Additional configured segment dimensions."),
];

export const ORDER_CUSTOMER_FIELD: ApiField = {
  ...inputField(
    "customer",
    "object",
    "Sales-order customer: send id, or match fields to find or create a customer.",
  ),
  properties: [
    inputField("id", "string (uuid)", "Existing customer party id."),
    inputField("externalRef", "string", "Customer identity from the originating system."),
    inputField("externalSource", "string", "Originating system name; send with externalRef."),
    inputField("email", "string", "Customer email used when matching or creating."),
    inputField("name", "string", "Customer name used when matching or creating."),
    inputField("kind", "string", "Party kind, such as company or person.", {
      enum: ["company", "person", "customer", "vendor", "employee"],
    }),
    inputField("phone", "string | null", "Customer phone number."),
    {
      ...inputField("address", "object", "Customer postal address."),
      properties: [
        inputField("line1", "string | null", "Address line one."),
        inputField("line2", "string | null", "Address line two."),
        inputField("city", "string | null", "City."),
        inputField("region", "string | null", "State, province, or region."),
        inputField("postalCode", "string | null", "Postal code."),
        inputField("country", "string | null", "Country code."),
      ],
    },
  ],
};

export const ORDER_SHIPPING_LINE_FIELDS: readonly ApiField[] = [
  inputField("accountId", "string (uuid)", "Posting account for the shipping line.", {
    required: true,
  }),
  inputField("description", "string", "Shipping line description."),
  inputField("amount", "string (decimal)", "Exact shipping amount as a decimal string.", {
    required: true,
  }),
  inputField("taxCodeId", "string (uuid)", "Tax code reference."),
  inputField("taxGroupId", "string (uuid)", "Tax group reference."),
];

/** Exact line input contract accepted by the shared document editor. */
export const DOCUMENT_LINE_FIELDS: readonly ApiField[] = [
  inputField("accountId", "string (uuid)", "Posting account for the line.", { required: true }),
  inputField("itemId", "string (uuid) | null", "Optional item or service reference."),
  inputField("description", "string | null", "Line description."),
  inputField("amount", "string (decimal)", "Exact line amount as a decimal string.", {
    required: true,
  }),
  inputField("quantity", "string (decimal) | null", "Exact quantity as a decimal string."),
  inputField("unit", "string | null", "Unit label."),
  inputField("unitPrice", "string (decimal) | null", "Exact unit price as a decimal string."),
  inputField("taxCodeId", "string (uuid) | null", "Tax code reference."),
  inputField("taxGroupId", "string (uuid) | null", "Tax group reference."),
  inputField("taxOverridden", "boolean", "Whether tax was explicitly overridden."),
  inputField(
    "taxAmount",
    "string (decimal) | null",
    "Exact overridden tax amount as a decimal string.",
  ),
  inputField("partyId", "string (uuid) | null", "Line party dimension."),
  inputField("departmentId", "string (uuid) | null", "Department dimension."),
  inputField("projectId", "string (uuid) | null", "Project dimension."),
  inputField("locationId", "string (uuid) | null", "Location dimension."),
  inputField("classId", "string (uuid) | null", "Class dimension."),
  inputField("stockLocationId", "string (uuid) | null", "Inventory warehouse for the line."),
  inputField("extraDims", "object", "Additional configured segment dimensions."),
  inputField("custom", "object", "Custom field values keyed by each custom field key."),
];

/** Native order line shape; order amounts and quantities remain exact decimal strings. */
export const ORDER_LINE_FIELDS: readonly ApiField[] = [
  inputField("itemId", "string (uuid)", "Item or service id from the catalog."),
  inputField("itemCode", "string", "Item code used instead of itemId."),
  inputField("accountId", "string (uuid)", "Posting account for non-item lines."),
  inputField("description", "string", "Line description."),
  inputField("quantity", "string (decimal)", "Exact quantity as a decimal string."),
  inputField("unit", "string", "Unit label."),
  inputField("unitPrice", "string (decimal)", "Exact unit price as a decimal string."),
  inputField(
    "discountPercent",
    "string (decimal)",
    "Exact discount percentage as a decimal string.",
  ),
  inputField("discountAmount", "string (decimal)", "Exact discount amount as a decimal string."),
  inputField("taxCodeId", "string (uuid)", "Tax code reference."),
  inputField("taxGroupId", "string (uuid)", "Tax group reference."),
  inputField("stockLocationId", "string (uuid)", "Inventory warehouse for the line."),
  inputField("departmentId", "string (uuid)", "Department dimension."),
  inputField("projectId", "string (uuid)", "Project dimension."),
];

export const DOCUMENT_REVISION_READ_METADATA: Readonly<
  Pick<ApiField, "requiredOnRead" | "pattern" | "description">
> = Object.freeze({
  requiredOnRead: true,
  pattern: DOCUMENT_REVISION_PATTERN,
  description: DOCUMENT_REVISION_DESCRIPTION,
});

/** Update-only field layered onto every writable document schema. */
export const DOCUMENT_REVISION_WRITE_FIELD: Readonly<ApiField> = Object.freeze({
  name: "expectedUpdatedAt",
  type: "string (date-time)",
  required: false,
  writable: true,
  writableOnCreate: false,
  requiredOnUpdate: true,
  writeOnly: true,
  pattern: DOCUMENT_REVISION_PATTERN,
  description: DOCUMENT_REVISION_DESCRIPTION,
  custom: false,
});

/** Document bodies always carry their line collection as exact decimal strings. */
export const DOCUMENT_LINES_FIELD: Readonly<ApiField> = Object.freeze({
  name: "lines",
  type: "array",
  required: false,
  writable: true,
  description:
    "Document lines. Each line accepts accountId, itemId, description, quantity, unitPrice, amount, taxCodeId, taxGroupId, partyId, departmentId, projectId, locationId, classId, extraDims, and custom. Amount and quantity values are exact decimal strings.",
  custom: false,
  items: [...DOCUMENT_LINE_FIELDS],
});

export function withDocumentRevisionWriteField(writer: Writer, fields: ApiField[]): ApiField[] {
  return writer.kind === "document" ? [...fields, { ...DOCUMENT_REVISION_WRITE_FIELD }] : fields;
}

export interface ApiRecordTypeSchema extends ApiRecordType {
  fields: ApiField[];
  path: string;
}

/**
 * Item columns that belong to Revenue Recognition. The items catalog itself
 * stays available when Inventory is off; these fields must still disappear
 * from REST/MCP and refuse writes when the Revenue Recognition switch is off.
 * Existing values stay on the row.
 */
export const ITEM_REVENUE_RECOGNITION_COLUMNS = new Set<string>([
  "recognition_rule_id",
  "deferred_account_id",
  "create_plans_on",
  "revenue_allocation",
  "standalone_selling_price",
]);

/**
 * Item columns that belong to Time Tracking. The items catalog itself stays
 * available when Time Tracking is off; this flag must still disappear from
 * REST/MCP and refuse writes. Existing flags stay on the row.
 */
export const ITEM_TIME_TRACKING_COLUMNS = new Set<string>(["show_on_timesheet"]);

/**
 * Item `kind` values. The items catalog stays available when Inventory or
 * Equipment is off; inventory / assembly / kit and equipment_charge must
 * still disappear from REST/MCP so the catalog does not advertise writes
 * the Features switch already 404s. Existing items stay on the row.
 */
export const ITEM_KIND_VALUES = [
  "service",
  "non_inventory",
  "inventory",
  "assembly",
  "kit",
  "other_charge",
  "equipment_charge",
  "labor",
  "absence",
  "discount",
  "gift_card",
] as const;

export const ITEM_INVENTORY_KINDS = new Set<string>(["inventory", "assembly", "kit"]);

export const ITEM_EQUIPMENT_KINDS = new Set<string>(["equipment_charge"]);

/**
 * Columns that are never writable through the API — identity, tenant scope,
 * and audit stamps are set by the server, not the caller.
 */
export const READONLY_COLUMNS = new Set<string>([
  "id",
  "org_id",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "search_text",
  "type_id",
  "type_key",
  "posted_entry_id",
]);

/** Map a Postgres data type to a canonical API type string. */
export function pgTypeToOpenApi(pgType: string): string {
  if (pgType === "uuid") return "string (uuid)";
  if (pgType.startsWith("timestamp")) return "string (date-time)";
  if (pgType === "date") return "string (date)";
  if (pgType === "boolean") return "boolean";
  if (
    pgType.startsWith("numeric") ||
    pgType === "integer" ||
    pgType === "bigint" ||
    pgType === "real" ||
    pgType === "double precision"
  )
    return "number";
  if (pgType === "jsonb" || pgType === "json") return "object";
  if (pgType.startsWith("text") || pgType.startsWith("character")) return "string";
  return "string";
}

/**
 * Map a custom-field / forms-core field type to the same canonical API type
 * vocabulary the physical columns use, so the docs and validators speak one
 * language. Covers both the `custom_field_defs.field_type` enum and the
 * forms-core `FieldType` used by custom record types.
 */
export function fieldTypeToApi(t: string): string {
  switch (t) {
    case "number":
    case "currency":
    case "amount":
    case "rating":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "string (date)";
    case "datetime":
      return "string (date-time)";
    case "reference":
    case "entity_ref":
    case "gl_account":
    case "party":
      return "string (uuid)";
    case "multi_select":
      return "array";
    case "file":
      return "object";
    default:
      return "string";
  }
}

/**
 * The resolved, route-facing view of a record type: everything a write/read
 * handler needs, whether the type is built-in or a dynamic custom type. This is
 * the SINGLE resolver shape — routes never re-derive table/kind/permission.
 */
export interface ResolvedApiType {
  key: string;
  table: string;
  searchColumn: string;
  readPermission: string;
  writePermission: string | null;
  operations: ApiOperation[];
  writer: Writer;
  dynamic: boolean;
  /** Null off the documents table; otherwise a nonempty, authoritative read scope. */
  documentKinds: readonly string[] | null;
}

/**
 * Documents-backed record types must always read through an explicit,
 * nonempty kind allowlist: document writers contribute their own docKind and
 * every other writer backed by the documents table must declare one. This
 * fails closed at resolve time so a new registry entry can never silently
 * read (or let a caller read) another kind's rows.
 */
export function resolveDocumentReadKinds(t: ApiRecordType): readonly string[] | null {
  if (t.table !== "documents") return null;
  const kinds = t.writer.kind === "document" ? [t.writer.docKind] : t.documentKinds;
  if (!kinds || kinds.length === 0 || kinds.some((kind) => !kind.trim())) {
    throw new Error(
      `documents-backed record type ${t.key} requires a nonempty document kind scope`,
    );
  }
  return [...new Set(kinds)];
}

export function toResolved(t: ApiRecordType): ResolvedApiType {
  return {
    key: t.key,
    table: t.table!,
    searchColumn: t.searchColumn,
    readPermission: t.readPermission,
    writePermission: t.writePermission,
    operations: t.operations,
    writer: t.writer,
    dynamic: t.dynamic,
    documentKinds: resolveDocumentReadKinds(t),
  };
}
