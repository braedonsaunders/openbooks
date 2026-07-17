import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeSectionsInput } from "../record-schema";

/**
 * API schema registry — the self-documenting foundation.
 *
 * Static descriptors map record-type keys to their DB table, permission, and
 * available operations. At runtime, `loadApiSchema()` queries
 * `information_schema.columns` to produce the ACTUAL field list (name, type,
 * nullable) — so the schema is always in sync with the real DB, never stale.
 * Custom record types (defined by the org via the app builder) and custom
 * fields are layered on dynamically, producing a tenant-specific schema that
 * feeds both the OpenAPI spec and the in-shell docs browser.
 *
 * This mirrors NetSuite's OpenAPI 3.0 metadata (one source of truth) but
 * goes further: it's per-tenant and includes that org's custom records and
 * custom fields — something NetSuite can't do in its global spec.
 */

export type ApiOperation = "list" | "get" | "create" | "update" | "delete";

export interface ApiRecordType {
  /** URL-safe slug used in /api/v1/records/<key>. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** What this record type represents. */
  description: string;
  /** The DB table the records live in. Null for purely-dynamic (custom) types. */
  table: string | null;
  /** Permission required to read (list/get). */
  readPermission: string;
  /** Permission required to write (create/update/delete). Null = read-only. */
  writePermission: string | null;
  /** Operations available on this record type. */
  operations: ApiOperation[];
  /** True when this record type is dynamically defined by the org. */
  dynamic: boolean;
}

/** Built-in record types exposed through the API. */
export const API_RECORD_TYPES: ApiRecordType[] = [
  {
    key: "journal-entries",
    label: "Journal Entries",
    description:
      "Balanced ledger entries enforced by the accounting kernel. Documents post exactly one entry; authorized open-period amendments re-materialize it with immutable before/after evidence, while closed-period corrections use reopening or reversal.",
    table: "journal_entries",
    readPermission: "gl.read",
    writePermission: "gl.post",
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "bills",
    label: "Vendor Bills",
    description: "Accounts payable documents — invoices received from vendors, pending approval and posting.",
    table: "documents",
    readPermission: "ap.read",
    // Write endpoints are not implemented in /api/v1 yet — the spec must not
    // advertise them. Restore create/update (with ap.create) when they land.
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "invoices",
    label: "Customer Invoices",
    description: "Accounts receivable documents — sales invoices issued to customers.",
    table: "documents",
    readPermission: "ar.read",
    // Not implemented in /api/v1 yet — see note on bills.
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "payments",
    label: "Payments",
    description: "Vendor payments and customer receipts, with open-item application.",
    table: "documents",
    readPermission: "ap.pay",
    writePermission: "ap.pay",
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "parties",
    label: "Parties",
    description: "The unified party directory — customers, vendors, and employees. A single record can hold multiple roles.",
    table: "parties",
    readPermission: "parties.read",
    // Not implemented in /api/v1 yet — see note on bills.
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "accounts",
    label: "Chart of Accounts",
    description: "The general-ledger chart of accounts — posting, summary, and header accounts.",
    table: "accounts",
    readPermission: "gl.read",
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "items",
    label: "Items & Services",
    description: "The catalog of items and services that sales and purchase lines reference.",
    table: "items",
    readPermission: "items.read",
    // Not implemented in /api/v1 yet — see note on bills.
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "projects",
    label: "Projects",
    description: "Jobs and projects for job costing and dimension tracking.",
    table: "projects",
    readPermission: "projects.read",
    // Not implemented in /api/v1 yet — see note on bills.
    writePermission: null,
    operations: ["list", "get"],
    dynamic: false,
  },
  {
    key: "assets",
    label: "Fixed Assets",
    description: "Fixed assets and their depreciation schedules.",
    table: "fixed_assets",
    readPermission: "assets.read",
    writePermission: "assets.manage",
    operations: ["list", "get"],
    dynamic: false,
  },
];

export interface ApiField {
  /** Column/field name (snake_case for DB columns, field id for custom). */
  name: string;
  /** Data type string from information_schema or the field type. */
  type: string;
  /** Whether the field is required (NOT NULL and no default). */
  required: boolean;
  /** Human-readable description, when available. */
  description: string | null;
  /** True for custom fields (appended by the org). */
  custom: boolean;
}

export interface ApiRecordTypeSchema extends ApiRecordType {
  fields: ApiField[];
  /** URL path for this record type in the v1 API. */
  path: string;
}

/** Map a Postgres data type to an OpenAPI type string. */
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
 * Load the full API schema for an org: built-in record types (with live DB
 * columns) + the org's published custom record types (with their FormField[]
 * definitions). This is the single source of truth that powers the OpenAPI
 * spec and the docs browser.
 */
export async function loadApiSchema(orgId: string): Promise<ApiRecordTypeSchema[]> {
  const builtIn = API_RECORD_TYPES.filter((t) => t.table);

  // Query live column metadata for all built-in tables at once.
  const tables = [...new Set(builtIn.map((t) => t.table!))];
  const cols = (await db.execute(sql`
    select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = any(${sql.raw(`ARRAY[${tables.map((t) => `'${t}'`).join(",")}]::text[]`)})
     order by table_name, ordinal_position`)) as any;

  const byTable = new Map<string, any[]>();
  for (const row of cols.rows) {
    const arr = byTable.get(row.table_name) ?? [];
    arr.push(row);
    byTable.set(row.table_name, arr);
  }

  const result: ApiRecordTypeSchema[] = builtIn.map((t) => ({
    ...t,
    path: `/api/v1/records/${t.key}`,
    fields: (byTable.get(t.table!) ?? []).map((c): ApiField => ({
      name: c.column_name,
      type: pgTypeToOpenApi(c.data_type),
      required: c.is_nullable === "NO" && !c.column_default,
      description: null,
      custom: false,
    })),
  }));

  // Layer on custom record types (dynamically defined by the org).
  const custom = (await db.execute(sql`
    select key, name, description, fields
      from custom_record_types
     where org_id = ${orgId} and status = 'published'
     order by sort_order, name`)) as any;

  for (const row of custom.rows) {
    // The stored definition is a FormSection[] (or a legacy flat FormField[]);
    // flatten every section's fields into the API's flat field list.
    const sections = normalizeSectionsInput(row.fields) as Array<{ fields?: any[] }>;
    const flat = sections.flatMap((s) => (Array.isArray(s.fields) ? s.fields : []));
    const fields: ApiField[] = flat.map((f: any): ApiField => ({
      name: String(f.id ?? f.key ?? ""),
      type: fieldTypeToApi(f.type ?? "text"),
      required: Boolean(f.required),
      description: f.label ? String(f.label) : null,
      custom: true,
    }));
    result.push({
      key: row.key,
      label: row.name,
      description: row.description ?? "Custom record type",
      table: "custom_records",
      readPermission: "records.read",
      // Not implemented in /api/v1 yet — see note on bills.
      writePermission: null,
      operations: ["list", "get"],
      dynamic: true,
      path: `/api/v1/records/${row.key}`,
      fields,
    });
  }

  return result;
}

function fieldTypeToApi(t: string): string {
  switch (t) {
    case "number":
    case "currency":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "string (date)";
    case "longText":
      return "string";
    default:
      return "string";
  }
}
