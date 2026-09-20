import { sql } from "drizzle-orm";
import { CUSTOM_FIELD_REFERENCE_TABLES } from "@openbooks/customization";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";

/**
 * Ownership + shape fence for document mutations that write AROUND
 * applyDocumentEdit: user-script `set` (before_submit in flows/submit.ts,
 * before_post in posting.ts) and Flows set_field
 * (flows/documents-adapter.ts). The HTTP edit path proves uuid SHAPE and
 * org OWNERSHIP for every native dimension and every `reference`-type custom
 * value; these channels applied script/flow values with a bare update, so a
 * well-formed id from another tenant persisted as a silent cross-tenant
 * pointer (custom jsonb has no constraint at all) and a malformed date died
 * as an unhandled storage error. Every sink must call this BEFORE applying.
 *
 * Supplied-only, like the HTTP fences: only the mutated keys are checked, so
 * legacy values already stored on the row never lock an unrelated mutation.
 */
const NATIVE_DIM_TABLES: Record<string, string> = {
  departmentId: "departments",
  projectId: "projects",
  locationId: "locations",
  classId: "classes",
};

const DATE_FIELDS: ReadonlySet<string> = new Set([
  "dueDate",
  "expectedPayDate",
]);

const REFERENCE_OWNER_TABLES: ReadonlySet<string> = new Set(
  CUSTOM_FIELD_REFERENCE_TABLES as readonly string[],
);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A mutation-supplied reference the caller's org does not own (callers surface the message opaquely). */
export class DocumentMutationReferenceError extends Error {
  readonly field: string;
  constructor(field: string, message?: string) {
    super(message ?? `${field} not found in this organization`);
    this.name = "DocumentMutationReferenceError";
    this.field = field;
  }
}

export interface DocumentMutationEntry {
  /** Drizzle mutation key: a native dim/date field, `custom`, or a bare custom key (Flows set_field). */
  field: string;
  value: unknown;
}

interface ReferenceDef {
  key: string;
  label: string;
  referenceTable: string;
}

async function loadDocumentReferenceDefs(
  orgId: string,
  docKind: string | null,
): Promise<ReferenceDef[]> {
  const rows = (await db.execute<{
    key: string;
    label: string;
    referenceTable: string;
  }>(sql`
    select key, label, config ->> 'referenceTable' as "referenceTable"
      from custom_field_defs
     where org_id = ${orgId} and target_table = 'documents'
       and (target_kind is null or target_kind = ${docKind})
       and field_type = 'reference'
  `)).rows;
  return rows.filter(
    (row) =>
      typeof row.referenceTable === "string" &&
      REFERENCE_OWNER_TABLES.has(row.referenceTable),
  );
}

/**
 * Fail closed on every reference the mutation would persist. Throws
 * DocumentMutationReferenceError (tenant-opaque 404 wording, mirroring the
 * HTTP writers) for foreign or dangling ids, and a field-specific Error for
 * malformed shapes the storage layer would otherwise reject raw.
 */
export async function assertDocumentMutationRefsOwned(
  orgId: string,
  docKind: string | null,
  entries: DocumentMutationEntry[],
): Promise<void> {
  const wanted = new Map<string, { field: string; value: string }[]>();
  const need = (table: string, field: string, value: string) => {
    const list = wanted.get(table) ?? [];
    list.push({ field, value });
    wanted.set(table, list);
  };

  let defs: ReferenceDef[] | null = null;
  const referenceDef = async (key: string): Promise<ReferenceDef | undefined> => {
    defs ??= await loadDocumentReferenceDefs(orgId, docKind);
    return defs.find((def) => def.key === key);
  };

  for (const { field, value } of entries) {
    if (value === null || value === undefined) continue;
    if (DATE_FIELDS.has(field)) {
      if (typeof value !== "string" || !isIsoCalendarDate(value)) {
        throw new DocumentMutationReferenceError(
          field,
          `${field} must be a calendar date (YYYY-MM-DD)`,
        );
      }
      continue;
    }
    const dimTable = NATIVE_DIM_TABLES[field];
    if (dimTable) {
      // Null/undefined clears the column (handled by the early continue);
      // every other present value needs a shape and an owner. Shape is
      // refused here (the HTTP writers 422 malformed ids) so a script typo
      // surfaces readably instead of as a raw storage error.
      if (typeof value !== "string" || !UUID_RE.test(value)) {
        throw new DocumentMutationReferenceError(
          field,
          `${field} must be a valid record reference`,
        );
      }
      need(dimTable, field, value);
      continue;
    }
    if (field === "custom") {
      if (typeof value !== "object" || Array.isArray(value)) continue;
      for (const [key, cell] of Object.entries(value as Record<string, unknown>)) {
        if (typeof cell !== "string" || !UUID_RE.test(cell)) {
          // Shape-invalid custom values are the validator's job on the HTTP
          // path; here only well-formed ids on reference defs can become a
          // cross-tenant pointer, and anything else stores exactly as the
          // author wrote it. Malformed ids on a reference def are refused so
          // they cannot persist blind past the shape check the HTTP path runs.
          if (typeof cell === "string" && cell.length > 0) {
            const def = await referenceDef(key);
            if (def) {
              throw new DocumentMutationReferenceError(
                `custom.${key}`,
                `${def.label} must be a valid record reference`,
              );
            }
          }
          continue;
        }
        const def = await referenceDef(key);
        if (def) need(def.referenceTable, `custom.${key}`, cell);
      }
      continue;
    }
    // Any other key is a bare custom key (Flows set_field writes one key at a
    // time after verifying the def exists). Native columns outside the
    // whitelists above cannot arrive here — the script MUTABLE_FIELDS gate and
    // the flow WRITABLE_DOCUMENT_FIELDS gate already refused them.
    if (typeof value === "string" && UUID_RE.test(value)) {
      const def = await referenceDef(field);
      if (def) need(def.referenceTable, field, value);
    }
  }

  for (const [table, refs] of wanted) {
    const ids = [...new Set(refs.map((r) => r.value))];
    const owned = new Set(
      (
        await db.execute<{ id: string }>(sql`
          select id from ${sql.raw(`"${table}"`)}
           where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`)
      ).rows.map((r) => r.id),
    );
    for (const ref of refs) {
      if (!owned.has(ref.value)) throw new DocumentMutationReferenceError(ref.field);
    }
  }
}
