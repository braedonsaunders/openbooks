import "server-only";
import type { ApiField } from "./schema-registry";

/**
 * Shared request-body validation for the generic write layer.
 *
 * Given a record type's live field schema (from `loadApiSchema`), split and
 * coerce a JSON body into (a) writable physical columns and (b) `cf_<key>`
 * custom-field values — rejecting unknown, read-only, and mistyped keys. The
 * custom-field VALUES are handed on to `validateCustomValues` (options/min/max
 * rules) by the caller; this layer owns shape + writability + coercion so every
 * writer speaks the same canonical type vocabulary as the docs and OpenAPI.
 */

export interface FieldError {
  field: string;
  message: string;
}

/** Prefix that marks a custom field on a built-in table (custom_field_defs). */
export const CUSTOM_FIELD_PREFIX = "cf_";

/** Coerce a raw JSON value to a canonical API type. Empty stays empty (null). */
export function coerceScalar(
  type: string,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  const base = type.split(" (")[0]; // "string (uuid)" → "string"
  switch (base) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (Number.isNaN(n)) return { ok: false, message: "must be a number" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, message: "must be a boolean" };
    }
    case "object": {
      if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "must be an object" };
      return { ok: true, value: raw };
    }
    case "array": {
      if (!Array.isArray(raw)) return { ok: false, message: "must be an array" };
      return { ok: true, value: raw };
    }
    default: {
      // string family (including uuid/date/date-time — format is checked at the
      // DB layer via typed columns; we only guarantee it's a string here).
      if (typeof raw !== "string") return { ok: false, message: "must be a string" };
      return { ok: true, value: raw };
    }
  }
}

export interface EntityBodyResult {
  ok: boolean;
  errors: FieldError[];
  /** Coerced writable physical column values, keyed by column name. */
  columns: Record<string, unknown>;
  /** Raw custom-field values keyed WITHOUT the `cf_` prefix (for validateCustomValues). */
  customValues: Record<string, unknown>;
}

/**
 * Validate a body against a flat entity type's fields. Rejects keys that are
 * unknown, read-only, or the wrong type. On `create`, missing required columns
 * are flagged; on update, only supplied keys are validated (partial patch).
 */
export function validateEntityBody(
  fields: ApiField[],
  body: Record<string, unknown>,
  opts: { stage: "create" | "update" },
): EntityBodyResult {
  const errors: FieldError[] = [];
  const columns: Record<string, unknown> = {};
  const customValues: Record<string, unknown> = {};

  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const [key, raw] of Object.entries(body)) {
    if (key.startsWith(CUSTOM_FIELD_PREFIX)) {
      const field = byName.get(key);
      if (!field || !field.custom) {
        errors.push({ field: key, message: "unknown custom field" });
        continue;
      }
      // Leave rule validation (options/min/max/required) to validateCustomValues.
      customValues[key.slice(CUSTOM_FIELD_PREFIX.length)] = raw;
      continue;
    }
    const field = byName.get(key);
    if (!field) {
      errors.push({ field: key, message: "unknown field" });
      continue;
    }
    if (!field.writable) {
      errors.push({ field: key, message: "read-only field" });
      continue;
    }
    const c = coerceScalar(field.type, raw);
    if (!c.ok) {
      errors.push({ field: key, message: c.message });
      continue;
    }
    columns[key] = c.value;
  }

  if (opts.stage === "create") {
    for (const f of fields) {
      if (f.custom || !f.writable || !f.required) continue;
      const v = columns[f.name];
      if (v === undefined || v === null || v === "") {
        errors.push({ field: f.name, message: "required" });
      }
    }
  }

  return { ok: errors.length === 0, errors, columns, customValues };
}
