import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { normalizeSectionsInput } from "../record-schema";
import {
  API_RECORD_TYPES,
  RECORD_TYPE_BY_KEY,
  READONLY_COLUMNS,
  RW,
  fieldTypeToApi,
  pgTypeToOpenApi,
  toResolved,
  type ApiField,
  type ApiRecordType,
  type ApiRecordTypeSchema,
  type ResolvedApiType,
} from "./registry-data";

/**
 * API schema registry — the self-documenting foundation.
 *
 * The static descriptors + type mappings live in the pure ./registry-data
 * module (unit-testable). Here we add the db-backed runtime: `loadApiSchema()`
 * reflects live `information_schema.columns`, layers on the org's custom fields
 * (`custom_field_defs`) and custom record types, and `resolveApiType()` is the
 * single resolver every /api/v1/records route uses — no per-route duplication.
 *
 * The schema is always in sync with the real DB, never stale, and feeds the
 * OpenAPI spec, the docs browser, AND the write validators from one source of
 * truth. This mirrors source platform's OpenAPI metadata but goes further: it's
 * per-tenant and includes that org's custom records and fields.
 */

export * from "./registry-data";

/**
 * Load the full API schema for an org: built-in record types (with live DB
 * columns + the org's custom fields on those tables) and the org's published
 * custom record types (with their FormField[] definitions). Single source of
 * truth for the OpenAPI spec, the docs browser, and write validation.
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

  // Custom fields on built-in tables (custom_field_defs), keyed by table and
  // optional kind. Surfaced as `cf_<key>` so bills/parties/etc. advertise and
  // accept their org custom fields — like source platform's `custentity_*`.
  const cfDefs = (await db.execute(sql`
    select target_table, target_kind, key, label, field_type, is_required
      from custom_field_defs
     where org_id = ${orgId} and is_active
     order by sort_order, label`)) as any;

  const cfByTargetKind = new Map<string, any[]>();
  for (const row of cfDefs.rows) {
    const k = `${row.target_table}::${row.target_kind ?? ""}`;
    const arr = cfByTargetKind.get(k) ?? [];
    arr.push(row);
    cfByTargetKind.set(k, arr);
  }

  function customFieldsFor(table: string, docKind?: string): ApiField[] {
    const keys = docKind ? [`${table}::`, `${table}::${docKind}`] : [`${table}::`];
    const seen = new Set<string>();
    const out: ApiField[] = [];
    for (const k of keys) {
      for (const d of cfByTargetKind.get(k) ?? []) {
        const name = `cf_${d.key}`;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          type: fieldTypeToApi(d.field_type),
          required: Boolean(d.is_required),
          writable: true,
          description: d.label ? String(d.label) : null,
          custom: true,
        });
      }
    }
    return out;
  }

  const result: ApiRecordTypeSchema[] = builtIn.map((t) => {
    const docKind = t.writer.kind === "document" ? t.writer.docKind : undefined;
    const physical = (byTable.get(t.table!) ?? []).map((c): ApiField => ({
      name: c.column_name,
      type: pgTypeToOpenApi(c.data_type),
      required: c.is_nullable === "NO" && !c.column_default && !READONLY_COLUMNS.has(c.column_name),
      writable: !READONLY_COLUMNS.has(c.column_name) && c.column_name !== "custom",
      description: null,
      custom: false,
    }));
    return {
      ...t,
      path: `/api/v1/records/${t.key}`,
      fields: [...physical, ...customFieldsFor(t.table!, docKind)],
    };
  });

  // Layer on custom record types (dynamically defined by the org).
  const custom = (await db.execute(sql`
    select key, name, description, fields
      from custom_record_types
     where org_id = ${orgId} and status = 'published'
     order by sort_order, name`)) as any;

  for (const row of custom.rows) {
    // Flatten the canonical FormSection[] definition into the API field list.
    const sections = normalizeSectionsInput(row.fields) as Array<{ fields?: any[] }>;
    const flat = sections.flatMap((s) => (Array.isArray(s.fields) ? s.fields : []));
    const fields: ApiField[] = flat.map((f: any): ApiField => ({
      name: String(f.id ?? f.key ?? ""),
      type: fieldTypeToApi(f.type ?? "text"),
      required: Boolean(f.required),
      writable: true,
      description: f.label ? String(f.label) : null,
      custom: true,
    }));
    result.push({
      key: row.key,
      label: row.name,
      description: row.description ?? "Custom record type",
      table: "custom_records",
      searchColumn: "search_text",
      readPermission: "records.read",
      writePermission: "records.create",
      operations: RW,
      writer: { kind: "custom_record" },
      dynamic: true,
      path: `/api/v1/records/${row.key}`,
      fields,
    });
  }

  return result;
}

/**
 * Resolve a record-type slug to its route-facing descriptor. Checks the
 * built-in registry first, then the org's published custom record types.
 * Returns null for an unknown type.
 */
export async function resolveApiType(
  orgId: string,
  typeKey: string,
): Promise<ResolvedApiType | null> {
  const builtIn = RECORD_TYPE_BY_KEY.get(typeKey) as ApiRecordType | undefined;
  if (builtIn && builtIn.table) return toResolved(builtIn);

  const r = (await db.execute(sql`
    select key from custom_record_types
     where org_id = ${orgId} and key = ${typeKey} and status = 'published'`)) as any;
  if (!r.rows[0]) return null;
  return {
    key: typeKey,
    table: "custom_records",
    searchColumn: "search_text",
    readPermission: "records.read",
    writePermission: "records.create",
    operations: RW,
    writer: { kind: "custom_record" },
    dynamic: true,
  };
}
