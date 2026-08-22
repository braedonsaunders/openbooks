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
  /** When set, the type disappears from the API catalog if that Features switch is off. */
  featureKey?: string;
}

/** The full read+write op set, for types whose writer supports mutation. */
export const RW: ApiOperation[] = ["list", "get", "create", "update", "delete"];
export const RO: ApiOperation[] = ["list", "get"];

/**
 * Search column per table. `custom_records` has a precomputed haystack;
 * `documents`/`journal_entries` have no `name` column, and `parties` calls it
 * `display_name`. Everything else searches `name`.
 */
export const SEARCH_COLUMNS: Record<string, string> = {
  custom_records: "search_text",
  documents: "document_number",
  journal_entries: "entry_number",
  parties: "display_name",
};

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
  {
    key: "bills",
    label: "Vendor Bills",
    description: "Accounts payable documents — invoices received from vendors. Writes create a draft and can submit/post through the posting kernel.",
    table: "documents",
    searchColumn: "document_number",
    readPermission: "ap.read",
    writePermission: "ap.create",
    operations: RW,
    writer: { kind: "document", docKind: "vendor_bill" },
    dynamic: false,
  },
  {
    key: "invoices",
    label: "Customer Invoices",
    description: "Accounts receivable documents — sales invoices issued to customers. Writes create a draft and can submit/post through the posting kernel.",
    table: "documents",
    searchColumn: "document_number",
    readPermission: "ar.read",
    writePermission: "ar.create",
    operations: RW,
    writer: { kind: "document", docKind: "customer_invoice" },
    dynamic: false,
  },
  {
    key: "payments",
    label: "Payments",
    description: "Vendor payments and customer receipts, with open-item application. Read-only in v1 — creation goes through the payment/cash-application flow.",
    table: "documents",
    searchColumn: "document_number",
    readPermission: "ap.pay",
    writePermission: null,
    operations: RO,
    writer: { kind: "readonly" },
    dynamic: false,
  },
  {
    key: "parties",
    label: "Parties",
    description: "The unified party directory — customers, vendors, and employees. A single record can hold multiple roles.",
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
    description: "The general-ledger chart of accounts — posting, summary, and header accounts. Managed through Setup; read-only here.",
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
];

export const RECORD_TYPE_BY_KEY = new Map(API_RECORD_TYPES.map((t) => [t.key, t]));

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  writable: boolean;
  description: string | null;
  custom: boolean;
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
  if (pgType.startsWith("numeric") || pgType === "integer" || pgType === "bigint" || pgType === "real" || pgType === "double precision") return "number";
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
  };
}
