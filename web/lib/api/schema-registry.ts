import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isFeatureEnabled } from "../features";
import { normalizeSectionsInput } from "../record-schema";
import { inTypeAudience } from "../records";
import {
  customFieldVisible,
  type CustomFieldViewer,
} from "@openbooks/engine/records/custom-fields";
import {
  API_RECORD_TYPES,
  DOCUMENT_REVISION_READ_METADATA,
  DOCUMENT_LINES_FIELD,
  DOCUMENT_EDIT_HEADER_FIELDS,
  DOCUMENT_LINE_FIELDS,
  ORDER_CUSTOMER_FIELD,
  ORDER_EDIT_HEADER_FIELDS,
  ORDER_LINE_FIELDS,
  ORDER_SHIPPING_LINE_FIELDS,
  RECORD_TYPE_BY_KEY,
  ITEM_EQUIPMENT_KINDS,
  ITEM_INVENTORY_KINDS,
  ITEM_KIND_VALUES,
  ITEM_REVENUE_RECOGNITION_COLUMNS,
  ITEM_TIME_TRACKING_COLUMNS,
  READONLY_COLUMNS,
  RW,
  fieldTypeToApi,
  pgTypeToOpenApi,
  toResolved,
  withDocumentRevisionWriteField,
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
 * truth. It is per-tenant and includes that org's custom records and fields.
 */

export * from "./registry-data";

interface ColumnRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_generated: "ALWAYS" | "NEVER";
}
interface CustomFieldRow extends Record<string, unknown> {
  target_table: string;
  target_kind: string | null;
  key: string;
  label: string | null;
  field_type: string;
  is_required: boolean;
  config: { allowedRoles?: unknown; options?: unknown } | null;
}
interface CustomRecordTypeRow extends Record<string, unknown> {
  key: string;
  name: string;
  description: string | null;
  fields: unknown;
  allowed_roles: string[] | null;
}
interface StoredFormField {
  id?: string;
  key?: string;
  type?: string;
  required?: boolean;
  label?: string | null;
  validation?: { options?: unknown };
}

function choiceValues(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined;
  const values = options.flatMap((option) => {
    if (typeof option === "string") return [option];
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const value = (option as { value?: unknown }).value;
    return typeof value === "string" ? [value] : [];
  });
  return values.length > 0 ? values : undefined;
}

/**
 * Load the full API schema for an org: built-in record types (with live DB
 * columns + the org's custom fields on those tables) and the org's published
 * custom record types (with their FormField[] definitions). Single source of
 * truth for the OpenAPI spec, the docs browser, and write validation.
 */
export async function loadApiSchema(
  orgId: string,
  roleKeys: readonly string[] | null = null,
  customFieldViewer?: CustomFieldViewer,
): Promise<ApiRecordTypeSchema[]> {
  const builtIn: ApiRecordType[] = [];
  for (const t of API_RECORD_TYPES.filter((candidate) => candidate.table)) {
    if (t.featureKey && !(await isFeatureEnabled(orgId, t.featureKey))) continue;
    builtIn.push(t);
  }

  // Query live column metadata for all built-in tables at once. Table names
  // travel as bound parameters, never interpolated into sql.raw.
  const tables = [...new Set(builtIn.map((t) => t.table!))];
  const tableArray = sql`ARRAY[${sql.join(
    tables.map((t) => sql`${t}`),
    sql`, `,
  )}]::text[]`;
  const cols = await db.execute<ColumnRow>(
    sql`
    select table_name, column_name, data_type, is_nullable, column_default, is_generated
      from information_schema.columns
     where table_schema = 'public' and table_name = any(${tableArray})
     order by table_name, ordinal_position`,
    "objects",
  );

  const byTable = new Map<string, ColumnRow[]>();
  for (const row of cols) {
    const arr = byTable.get(row.table_name) ?? [];
    arr.push(row);
    byTable.set(row.table_name, arr);
  }

  // Custom fields on built-in tables (custom_field_defs), keyed by table and
  // optional kind. Surfaced as `cf_<key>` so bills/parties/etc. advertise and
  // accept their org custom fields.
  const cfDefs = await db.execute<CustomFieldRow>(
    sql`
    select target_table, target_kind, key, label, field_type, is_required, config
      from custom_field_defs
     where org_id = ${orgId} and is_active
     order by sort_order, label`,
    "objects",
  );

  const cfByTargetKind = new Map<string, CustomFieldRow[]>();
  for (const row of cfDefs) {
    const k = `${row.target_table}::${row.target_kind ?? ""}`;
    const arr = cfByTargetKind.get(k) ?? [];
    arr.push(row);
    cfByTargetKind.set(k, arr);
  }

  function customFieldsFor(table: string, docKind?: string, writable = true): ApiField[] {
    const keys = docKind ? [`${table}::`, `${table}::${docKind}`] : [`${table}::`];
    const seen = new Set<string>();
    const out: ApiField[] = [];
    for (const k of keys) {
      for (const d of cfByTargetKind.get(k) ?? []) {
        if (
          customFieldViewer &&
          !customFieldVisible({ key: d.key, config: d.config }, customFieldViewer)
        )
          continue;
        const name = `cf_${d.key}`;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          type: fieldTypeToApi(d.field_type),
          required: Boolean(d.is_required),
          writable,
          description: d.label ? String(d.label) : null,
          custom: true,
          ...(choiceValues(d.config?.options) ? { enum: choiceValues(d.config?.options) } : {}),
        });
      }
    }
    return out;
  }

  const revenueRecognitionOn = await isFeatureEnabled(orgId, "revenueRecognition");
  const timeTrackingOn = await isFeatureEnabled(orgId, "timeTracking");
  const multiCurrencyOn = await isFeatureEnabled(orgId, "multiCurrency");
  const inventoryOn = await isFeatureEnabled(orgId, "inventory");
  const equipmentOn = await isFeatureEnabled(orgId, "equipment");
  const itemKinds = ITEM_KIND_VALUES.filter(
    (kind) =>
      (inventoryOn || !ITEM_INVENTORY_KINDS.has(kind)) &&
      (equipmentOn || !ITEM_EQUIPMENT_KINDS.has(kind)),
  );
  const result: ApiRecordTypeSchema[] = builtIn.map((t) => {
    const docKind =
      t.writer.kind === "document"
        ? t.writer.docKind
        : t.table === "documents" && t.documentKinds?.length === 1
          ? t.documentKinds[0]
          : undefined;
    const orderDocument = ["quote", "sales_order", "purchase_order"].includes(docKind ?? "");
    const lineCustomFields =
      docKind && !orderDocument
        ? customFieldsFor("document_lines", docKind).map((field) => ({
            ...field,
            name: `lines[].${field.name}`,
            description: field.description
              ? `Document line custom field: ${field.description}`
              : "Document line custom field",
          }))
        : [];
    const physical = (byTable.get(t.table!) ?? [])
      .filter(
        (c) =>
          t.key !== "items" ||
          revenueRecognitionOn ||
          !ITEM_REVENUE_RECOGNITION_COLUMNS.has(c.column_name),
      )
      .filter(
        (c) =>
          t.key !== "items" || timeTrackingOn || !ITEM_TIME_TRACKING_COLUMNS.has(c.column_name),
      )
      .map((c): ApiField => ({
        name: c.column_name,
        type:
          t.table === "documents" &&
          ["subtotal", "tax_total", "total", "balance", "exchange_rate"].includes(c.column_name)
            ? "string (decimal)"
            : pgTypeToOpenApi(c.data_type),
        // GENERATED ALWAYS columns are projections the row computes itself:
        // advertised for reads, never required of or accepted from a writer.
        required:
          t.table !== "documents" &&
          c.is_nullable === "NO" &&
          !c.column_default &&
          c.is_generated === "NEVER" &&
          !READONLY_COLUMNS.has(c.column_name),
        writable:
          t.writer.kind !== "readonly" &&
          t.table !== "documents" &&
          c.is_generated === "NEVER" &&
          !READONLY_COLUMNS.has(c.column_name) &&
          c.column_name !== "custom" &&
          (multiCurrencyOn || t.table !== "documents" || c.column_name !== "currency"),
        custom: false,
        ...(t.table === "documents" && c.column_name === "updated_at"
          ? DOCUMENT_REVISION_READ_METADATA
          : { description: null }),
        ...(t.key === "items" && c.column_name === "kind" ? { enum: itemKinds } : {}),
        ...(t.table === "documents" && c.column_name === "kind" && t.documentKinds
          ? { enum: [...t.documentKinds] }
          : {}),
        ...(t.table === "documents" && c.column_name === "status"
          ? {
              enum: orderDocument
                ? ["draft", "pending_approval", "approved", "voided"]
                : ["draft", "pending_approval", "approved", "posted", "voided"],
            }
          : {}),
      }));
    const lineFields = orderDocument ? ORDER_LINE_FIELDS : DOCUMENT_LINE_FIELDS;
    const lineField: ApiField = {
      ...DOCUMENT_LINES_FIELD,
      ...(orderDocument
        ? {
            description:
              "Order lines. Each line accepts itemId or itemCode, accountId, description, quantity, unit, unitPrice, discountPercent, discountAmount, taxCodeId, taxGroupId, stockLocationId, departmentId, and projectId. Amounts and quantities are exact decimal strings.",
          }
        : {}),
      items: [
        ...lineFields,
        ...lineCustomFields.map((field) => ({
          ...field,
          name: field.name.replace(/^lines\[\]\./, ""),
        })),
      ],
    };
    const documentFields: ApiField[] =
      t.writer.kind !== "document"
        ? []
        : orderDocument
          ? [
              ...ORDER_EDIT_HEADER_FIELDS,
              ...(docKind === "sales_order" ? [ORDER_CUSTOMER_FIELD] : []),
              lineField,
              ...(docKind === "sales_order"
                ? [
                    {
                      name: "shippingLines",
                      type: "array",
                      required: false,
                      writable: true,
                      description: "Sales-order shipping lines with exact decimal amounts.",
                      custom: false,
                      items: [...ORDER_SHIPPING_LINE_FIELDS],
                    },
                  ]
                : []),
            ]
          : [
              ...DOCUMENT_EDIT_HEADER_FIELDS.filter(
                (field) => multiCurrencyOn || !["currency", "explicitFx"].includes(field.name),
              ),
              lineField,
              ...lineCustomFields,
            ];
    return {
      ...t,
      path: `/api/v1/records/${t.key}`,
      fields: withDocumentRevisionWriteField(t.writer, [
        ...physical,
        ...documentFields,
        ...customFieldsFor(t.table!, docKind, t.writer.kind === "document" && !orderDocument),
      ]),
    };
  });

  // Layer on custom record types (dynamically defined by the org).
  const custom = await db.execute<CustomRecordTypeRow>(
    sql`
    select key, name, description, fields, allowed_roles
      from custom_record_types
     where org_id = ${orgId} and status = 'published'
     order by sort_order, name`,
    "objects",
  );

  for (const row of custom) {
    if (roleKeys !== null && !inTypeAudience(roleKeys, row.allowed_roles)) continue;
    // Flatten the canonical FormSection[] definition into the API field list.
    const sections = normalizeSectionsInput(row.fields) as Array<{ fields?: StoredFormField[] }>;
    const flat = sections.flatMap((s) => (Array.isArray(s.fields) ? s.fields : []));
    const fields: ApiField[] = flat.map((f): ApiField => ({
      name: String(f.id ?? f.key ?? ""),
      type: fieldTypeToApi(f.type ?? "text"),
      required: Boolean(f.required),
      writable: true,
      description: f.label ? String(f.label) : null,
      custom: true,
      ...(choiceValues(f.validation?.options) ? { enum: choiceValues(f.validation?.options) } : {}),
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
  if (builtIn && builtIn.table) {
    if (builtIn.featureKey && !(await isFeatureEnabled(orgId, builtIn.featureKey))) return null;
    return toResolved(builtIn);
  }

  const r = await db.execute(
    sql`
    select key from custom_record_types
     where org_id = ${orgId} and key = ${typeKey} and status = 'published'`,
    "objects",
  );
  if (!r[0]) return null;
  return {
    key: typeKey,
    table: "custom_records",
    searchColumn: "search_text",
    readPermission: "records.read",
    writePermission: "records.create",
    operations: RW,
    writer: { kind: "custom_record" },
    dynamic: true,
    documentKinds: null,
  };
}
